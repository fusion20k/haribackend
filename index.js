require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const stripe = process.env.STRIPE_SECRET_KEY ? require("stripe")(process.env.STRIPE_SECRET_KEY) : null;
const { Credentials, Translator } = require("@translated/lara");
const {
  initDatabase,
  findTranslationsByKeys,
  insertTranslations,
  makeBackendKey,
  getUserById,
  getUserByEmail,
  createUser,
  updateUserStripeCustomerId,
  getLatestSubscriptionForUser,
  createSubscription,
  updateSubscription,
  getSubscriptionByStripeId,
} = require("./db");
const { logTranslationUsage } = require("./analytics");
const { normalizeSegment, validateSegment } = require("./segmentation");

const app = express();
const PORT = process.env.PORT || 10000;

const credentials = new Credentials(
  process.env.LARA_ACCESS_KEY_ID,
  process.env.LARA_ACCESS_KEY_SECRET
);
const lara = new Translator(credentials);

app.use(
  cors({
    origin: "*",
  })
);

app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: "Payment system not configured" });
  }

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = parseInt(session.metadata.userId);
        const subscriptionId = session.subscription;

        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          await createSubscription(
            userId,
            subscription.id,
            subscription.status,
            new Date(subscription.current_period_end * 1000)
          );
          console.log(`Subscription created for user ${userId}`);
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object;
        await updateSubscription(
          subscription.id,
          subscription.status,
          new Date(subscription.current_period_end * 1000)
        );
        console.log(`Subscription ${subscription.id} updated to ${subscription.status}`);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        await updateSubscription(subscription.id, "canceled", null);
        console.log(`Subscription ${subscription.id} deleted`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).json({ error: "Webhook handler failed" });
  }
});

app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "ok", 
    message: "Backend is healthy",
    timestamp: new Date().toISOString()
  });
});

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

async function userHasActiveSubscription(userId) {
  const user = await getUserById(userId);
  if (user && user.has_access === true) {
    return true;
  }

  const row = await getLatestSubscriptionForUser(userId);
  if (!row) return false;
  if (!["active", "trialing"].includes(row.status)) return false;
  if (row.current_period_end && new Date(row.current_period_end) < new Date())
    return false;
  return true;
}

app.post("/auth/signup", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Payment system not configured" });
    }

    const { email, password } = req.body;

    if (!email || !password || typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Email and password required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const customer = await stripe.customers.create({ email });

    const user = await createUser(email, passwordHash, customer.id);

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    res.json({
      token,
      user: { id: user.id, email: user.email },
      hasAccess: false,
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password || typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const hasAccess = await userHasActiveSubscription(user.id);

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    res.json({
      token,
      user: { id: user.id, email: user.email },
      hasAccess,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const hasAccess = await userHasActiveSubscription(req.userId);

    res.json({
      id: user.id,
      email: user.email,
      hasAccess,
    });
  } catch (err) {
    console.error("/me error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/billing/create-checkout-session", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Payment system not configured" });
    }

    const user = await getUserById(req.userId);
    if (!user || !user.stripe_customer_id) {
      return res.status(400).json({ error: "Missing Stripe customer" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: user.stripe_customer_id,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.FRONTEND_BASE_URL}/newtab-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_BASE_URL}/newtab-cancel.html`,
      allow_promotion_codes: true,
      metadata: { userId: user.id.toString() },
    });

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error("Checkout session error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/translate", requireAuth, async (req, res) => {
  try {
    const hasAccess = await userHasActiveSubscription(req.userId);
    if (!hasAccess) {
      return res.status(402).json({ error: "Subscription required" });
    }

    const { sourceLang, targetLang, sentences, segments, domain } = req.body;

    if (typeof sourceLang !== "string" || typeof targetLang !== "string") {
      return res.status(400).json({ error: "sourceLang and targetLang are required" });
    }

    let textsToTranslate = [];
    
    if (segments && Array.isArray(segments) && segments.length > 0) {
      if (!segments.every((s) => typeof s === "string")) {
        return res.status(400).json({ error: "All segments must be strings" });
      }
      textsToTranslate = segments;
    } else if (sentences && Array.isArray(sentences) && sentences.length > 0) {
      if (!sentences.every((s) => typeof s === "string")) {
        return res.status(400).json({ error: "All sentences must be strings" });
      }
      textsToTranslate = sentences;
    } else {
      return res.status(400).json({ error: "Either segments or sentences array is required" });
    }

    const validatedDomain = typeof domain === "string" && domain.length > 0 ? domain : "default";

    const totalChars = textsToTranslate.reduce((sum, s) => sum + s.length, 0);
    if (totalChars > 8000) {
      return res.status(400).json({ error: "Request too large (over 8000 characters)" });
    }

    for (let i = 0; i < textsToTranslate.length; i++) {
      const validation = validateSegment(textsToTranslate[i]);
      if (!validation.valid) {
        return res.status(400).json({ 
          error: `Invalid segment at index ${i}: ${validation.error}` 
        });
      }
    }

    const keys = textsToTranslate.map((text) =>
      makeBackendKey(sourceLang, targetLang, text, validatedDomain)
    );

    const existingRows = await findTranslationsByKeys(keys);
    const existingMap = new Map();
    existingRows.forEach((row) => {
      existingMap.set(row.key, row.translated_text);
    });

    const translations = new Array(textsToTranslate.length).fill(null);
    const toLookupForLara = [];
    const hitStatuses = new Array(textsToTranslate.length).fill(false);

    keys.forEach((key, index) => {
      const cached = existingMap.get(key);
      if (cached) {
        translations[index] = cached;
        hitStatuses[index] = true;
      } else {
        toLookupForLara.push({ index, text: textsToTranslate[index], key });
      }
    });

    const cacheHits = textsToTranslate.length - toLookupForLara.length;
    console.log(
      `[${validatedDomain}] Cache: ${cacheHits} hits, ${toLookupForLara.length} misses (${textsToTranslate.length} total)`
    );

    if (toLookupForLara.length > 0) {
      const textsForLara = toLookupForLara.map((item) => item.text);

      const result = await lara.translate(textsForLara, sourceLang, targetLang);

      if (!Array.isArray(result.translation)) {
        return res.status(500).json({ error: "Unexpected Lara response shape" });
      }

      const newTranslations = result.translation;

      if (newTranslations.length !== textsForLara.length) {
        console.error(
          "Length mismatch from Lara",
          textsForLara.length,
          newTranslations.length
        );
        return res.status(500).json({ error: "Translation length mismatch" });
      }

      const rowsToInsert = [];
      newTranslations.forEach((tl, i) => {
        const { index, key } = toLookupForLara[i];
        translations[index] = tl;
        rowsToInsert.push({
          key,
          source_lang: sourceLang,
          target_lang: targetLang,
          original_text: textsToTranslate[index],
          translated_text: tl,
          domain: validatedDomain,
        });
      });

      await insertTranslations(rowsToInsert);
    }

    logTranslationUsage(
      req.userId,
      textsToTranslate,
      hitStatuses,
      validatedDomain,
      sourceLang,
      targetLang
    );

    return res.json({ translations });
  } catch (err) {
    console.error("Internal /translate error", err);

    if (err.constructor.name === "LaraApiError") {
      return res.status(502).json({
        error: "Upstream translation error",
        details: err.message,
      });
    }

    return res.status(500).json({ error: "Internal server error" });
  }
});

async function startServer() {
  try {
    if (process.env.DATABASE_URL) {
      console.log("Initializing database...");
      await initDatabase();
      console.log("Database ready");
    } else {
      console.warn(
        "WARNING: DATABASE_URL not set - running without cache (will use Lara for every request)"
      );
    }

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
