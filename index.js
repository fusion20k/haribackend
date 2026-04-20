require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const adminPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 5,
});
const stripe = process.env.STRIPE_SECRET_KEY ? require("stripe")(process.env.STRIPE_SECRET_KEY) : null;
const axios = require("axios");
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
  updateUserTrialStart,
  incrementUserTrialChars,
  updateUserPlanStatus,
  cancelUserSubscription,
  activatePaygPlan,
  getUsage,
  incrementUsage,
  resetUserCharsIfNeeded,
  insertClickEvent,
  getWebsiteActivity,
  syncUserXp,
  getUserXp,
} = require("./db");
const { logTranslationUsage, getOverallStats, getStatsByDomain, getMonthlyUsage } = require("./analytics");
const { normalizeSegment, validateSegment, cleanSegment, isTranslatable, isMultiWord, reattachDecorations, isEchoedTranslation, isValidTranslation } = require("./segmentation");

const app = express();
const PORT = process.env.PORT || 10000;

function mapLangCode(lang) {
  const MAP = { tl: "fil" };
  return MAP[lang] || lang;
}

function getPeriodEnd(sub) {
  const ts = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000) : null;
}

async function cancelStripeSubscriptionWithFinalUsage(subscriptionId) {
  if (!stripe || !subscriptionId) return;
  let isPayg = false;
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    isPayg = sub.items?.data?.some(
      (item) => item.price?.id === process.env.STRIPE_PAYG_PRICE_ID
    );
    await stripe.subscriptions.cancel(
      subscriptionId,
      isPayg ? { invoice_now: true, prorate: true } : undefined
    );
  } catch (err) {
    const alreadyGone =
      err.code === "resource_missing" ||
      err.statusCode === 404 ||
      /no such subscription/i.test(err.message || "");
    if (!alreadyGone) throw err;
  }
}

async function azureTranslate(texts, sourceLang, targetLang) {
  const from = mapLangCode(sourceLang);
  const to = mapLangCode(targetLang);
  const endpoint = process.env.AZURE_ENDPOINT || "https://api.cognitive.microsofttranslator.com";
  let response;
  try {
    response = await axios.post(
      `${endpoint}/translate?api-version=3.0&from=${from}&to=${to}`,
      texts.map((text) => ({ Text: text })),
      {
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_API_KEY,
          "Ocp-Apim-Subscription-Region": process.env.AZURE_REGION || "eastus",
          "Content-Type": "application/json",
        },
      }
    );
  } catch (axiosErr) {
    const status = axiosErr.response ? axiosErr.response.status : null;
    const azureErr = new Error(axiosErr.message);
    azureErr.azureStatus = status;
    throw azureErr;
  }
  return response.data.map((item) => item.translations[0].text);
}

async function azureDictionaryLookup(words, sourceLang, targetLang) {
  const from = mapLangCode(sourceLang);
  const to = mapLangCode(targetLang);
  const endpoint = process.env.AZURE_ENDPOINT || "https://api.cognitive.microsofttranslator.com";
  let response;
  try {
    response = await axios.post(
      `${endpoint}/dictionary/lookup?api-version=3.0&from=${from}&to=${to}`,
      words.map((word) => ({ Text: word })),
      {
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_API_KEY,
          "Ocp-Apim-Subscription-Region": process.env.AZURE_REGION || "eastus",
          "Content-Type": "application/json",
        },
      }
    );
  } catch (axiosErr) {
    const status = axiosErr.response ? axiosErr.response.status : null;
    const azureErr = new Error(axiosErr.message);
    azureErr.azureStatus = status;
    throw azureErr;
  }
  return response.data.map((item) =>
    item.translations && item.translations.length > 0 ? item.translations[0].normalizedTarget : null
  );
}

async function llmDictionary(word, english, context) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const response = await axios.post(
    `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-12-01-preview`,
    {
      messages: [
        {
          role: "system",
          content: "You are a Tagalog language expert. Always respond in English with valid JSON only. All field values must be in English except where Tagalog text is explicitly required (tagalog, pronunciation, example.tl, and wordBreakdown[].tagalog fields).",
        },
        {
          role: "user",
          content: `Given the Tagalog word "${word}" (English: "${english}", context: "${context}"), provide a dictionary entry as JSON with exactly these fields:\n{\n  "tagalog": string,\n  "pronunciation": string (syllable-broken, e.g. "ma-gan-da"),\n  "partOfSpeech": string (in English, e.g. "noun", "verb", "adjective"),\n  "englishTranslation": string (in English),\n  "example": { "tl": string (Tagalog sentence), "en": string (English translation) },\n  "culturalNotes": string (in English),\n  "wordBreakdown": [{ "tagalog": string, "english": string (in English), "pos": string (in English, e.g. "noun", "verb", "particle") }]\n}`,
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 800,
    },
    {
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
      },
    }
  );
  const content = response.data.choices[0].message.content;
  return JSON.parse(content);
}

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
        const userId = parseInt(session.metadata && session.metadata.userId);
        const subscriptionId = session.subscription;

        if (!userId || isNaN(userId)) {
          console.error("checkout.session.completed: missing userId in metadata", session.id);
          break;
        }

        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);

          try {
            await createSubscription(
              userId,
              subscription.id,
              subscription.status,
              getPeriodEnd(subscription)
            );
          } catch (dbErr) {
            console.error("checkout.session.completed: createSubscription error (non-fatal):", dbErr.message);
          }

          const isPayg = subscription.items.data[0]?.price?.id === process.env.STRIPE_PAYG_PRICE_ID;

          if (isPayg && subscription.status === "active") {
            const stripeItemId = subscription.items.data[0].id;
            await activatePaygPlan(userId, subscription.id, stripeItemId);
            console.log(`PAYG activated: user=${userId} sub=${subscription.id} item=${stripeItemId}`);
          } else if (subscription.status === "trialing") {
            await updateUserTrialStart(userId, subscription.id);
            console.log(`Trial started: user=${userId} sub=${subscription.id}`);
          } else if (subscription.status === "active") {
            const userBeforeUpdate = await getUserById(userId);
            const previousSubscriptionId = userBeforeUpdate ? userBeforeUpdate.subscription_id : null;
            await updateUserPlanStatus(userId, "pre", true, new Date(), subscription.id);
            console.log(`Subscription active: user=${userId}`);
            if (previousSubscriptionId && previousSubscriptionId !== subscription.id) {
              try {
                await cancelStripeSubscriptionWithFinalUsage(previousSubscriptionId);
                console.log(`Canceled old sub ${previousSubscriptionId} after upgrade for user=${userId}`);
              } catch (e) {
                console.error("Failed to cancel old sub on upgrade:", e.message);
              }
            }
          }
        }
        break;
      }

      case "customer.subscription.created": {
        const subscription = event.data.object;
        const meta = subscription.metadata || {};
        const userId = meta.userId ? parseInt(meta.userId) : null;

        console.log(`customer.subscription.created: sub=${subscription.id} status=${subscription.status} userId=${userId}`);

        if (userId && !isNaN(userId)) {
          try {
            await createSubscription(
              userId,
              subscription.id,
              subscription.status,
              getPeriodEnd(subscription)
            );
          } catch (dbErr) {
            console.error("customer.subscription.created: createSubscription error (non-fatal):", dbErr.message);
          }

          const isPayg = subscription.items.data[0]?.price?.id === process.env.STRIPE_PAYG_PRICE_ID;

          if (isPayg && subscription.status === "active") {
            const stripeItemId = subscription.items.data[0].id;
            await activatePaygPlan(userId, subscription.id, stripeItemId);
            console.log(`PAYG activated via subscription.created: user=${userId} sub=${subscription.id} item=${stripeItemId}`);
          } else if (subscription.status === "trialing") {
            await updateUserTrialStart(userId, subscription.id);
            console.log(`Trial started via subscription.created: user=${userId}`);
          } else if (subscription.status === "active") {
            await updateUserPlanStatus(userId, "pre", true, new Date(), subscription.id);
            console.log(`Active via subscription.created: user=${userId}`);
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object;
        await updateSubscription(
          subscription.id,
          subscription.status,
          getPeriodEnd(subscription),
          subscription.metadata?.userId ? parseInt(subscription.metadata.userId) : null
        );
        console.log(`Subscription ${subscription.id} updated to ${subscription.status}`);

        const subRow = await getSubscriptionByStripeId(subscription.id);
        if (subRow) {
          const isPayg = subscription.items.data[0]?.price?.id === process.env.STRIPE_PAYG_PRICE_ID;

          if (subscription.status === "trialing") {
            const prevAttrs = event.data.previous_attributes || {};
            const statusChanged = prevAttrs.status !== undefined && prevAttrs.status !== "trialing";
            if (statusChanged) {
              await updateUserTrialStart(subRow.user_id, subscription.id);
              console.log(`User ${subRow.user_id} set to trialing via subscription.updated`);
            } else {
              console.log(`Sub ${subscription.id} still trialing, skipping trial reset`);
            }
          } else if (subscription.status === "active") {
            if (isPayg) {
              const stripeItemId = subscription.items.data[0].id;
              await activatePaygPlan(subRow.user_id, subscription.id, stripeItemId);
              console.log(`PAYG activated via subscription.updated: user=${subRow.user_id} sub=${subscription.id} item=${stripeItemId}`);
            } else {
              await updateUserPlanStatus(subRow.user_id, "pre", true, new Date(), subscription.id);
              console.log(`User ${subRow.user_id} plan set to active`);
            }
          } else if (["canceled", "unpaid", "past_due"].includes(subscription.status)) {
            const currentUser = await getUserById(subRow.user_id);
            if (currentUser && (!currentUser.subscription_id || currentUser.subscription_id === subscription.id)) {
              await cancelUserSubscription(subRow.user_id);
              console.log(`User ${subRow.user_id} access revoked, status: ${subscription.status}`);
            } else {
              console.log(`Skipping revoke for user ${subRow.user_id}: current sub ${currentUser?.subscription_id} differs from updated sub ${subscription.id}`);
            }
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        await updateSubscription(subscription.id, "canceled", null);
        console.log(`Subscription ${subscription.id} deleted`);

        const subRow = await getSubscriptionByStripeId(subscription.id);
        if (subRow) {
          const currentUser = await getUserById(subRow.user_id);
          if (currentUser && (!currentUser.subscription_id || currentUser.subscription_id === subscription.id)) {
            await cancelUserSubscription(subRow.user_id);
            console.log(`User ${subRow.user_id} access revoked on subscription deletion`);
          } else {
            console.log(`Skipping revoke for user ${subRow.user_id}: current sub differs from deleted sub`);
          }
        }
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

app.get("/checkout-success", (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Hari - Success</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#1a1a2e;color:#e0e0e0}
.card{text-align:center;padding:3rem;border-radius:16px;background:rgba(255,255,255,0.05);backdrop-filter:blur(10px);max-width:420px}
h1{color:#4ade80;margin-bottom:.5rem}p{color:#a0a0b0;line-height:1.6}
.icon{font-size:3rem;margin-bottom:1rem}</style></head>
<body><div class="card"><div class="icon">&#10003;</div><h1>You're all set!</h1>
<p>Your subscription is active. You can close this tab and return to your browser — Hari is ready to use.</p>
</div></body></html>`);
});

app.get("/checkout-cancel", (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Hari - Canceled</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#1a1a2e;color:#e0e0e0}
.card{text-align:center;padding:3rem;border-radius:16px;background:rgba(255,255,255,0.05);backdrop-filter:blur(10px);max-width:420px}
h1{margin-bottom:.5rem}p{color:#a0a0b0;line-height:1.6}
.icon{font-size:3rem;margin-bottom:1rem}</style></head>
<body><div class="card"><div class="icon">&#8617;</div><h1>Checkout canceled</h1>
<p>No worries — nothing was charged. You can close this tab and try again whenever you're ready.</p>
</div></body></html>`);
});

app.get("/debug/me", requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.userId);
    const hasAccess = await userHasActiveSubscription(req.userId);
    const sub = await getLatestSubscriptionForUser(req.userId);
    res.json({
      userId: req.userId,
      userFound: !!user,
      user: user ? {
        id: user.id,
        email: user.email,
        has_access: user.has_access,
        plan_status: user.plan_status,
        trial_chars_used: user.trial_chars_used,
        trial_chars_limit: user.trial_chars_limit,
        subscription_id: user.subscription_id,
        chars_used_at_payg_start: user.chars_used_at_payg_start,
      } : null,
      hasAccessResult: hasAccess,
      latestSubscription: sub || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
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

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload.isAdmin) return res.status(403).json({ error: "Admin access required" });
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

app.post("/admin/login", async (req, res) => {
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

    if (!process.env.ADMIN_EMAIL || email.toLowerCase() !== process.env.ADMIN_EMAIL.toLowerCase()) {
      return res.status(403).json({ error: "Access denied: not an admin account" });
    }

    const token = jwt.sign({ userId: user.id, isAdmin: true }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/admin/overview", requireAdmin, async (req, res) => {
  try {
    const client = await adminPool.connect();
    let overviewData;
    try {
      const result = await client.query(`
        SELECT
          COUNT(*) AS total_users,
          SUM(CASE WHEN plan_status IN ('pre', 'active') THEN 1 ELSE 0 END) AS active_subscribers,
          SUM(CASE WHEN plan_status = 'pre' THEN 1 ELSE 0 END) AS premium_users,
          SUM(CASE WHEN plan_status = 'payg' THEN 1 ELSE 0 END) AS payg_users,
          SUM(CASE WHEN plan_status = 'free' THEN 1 ELSE 0 END) AS free_users,
          SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) AS new_signups_7d
        FROM users
      `);
      overviewData = result.rows[0];
    } finally {
      client.release();
    }
    const usage = await getMonthlyUsage();
    res.json({
      total_users: parseInt(overviewData.total_users) || 0,
      active_subscribers: parseInt(overviewData.active_subscribers) || 0,
      premium_users: parseInt(overviewData.premium_users) || 0,
      payg_users: parseInt(overviewData.payg_users) || 0,
      free_users: parseInt(overviewData.free_users) || 0,
      new_signups_7d: parseInt(overviewData.new_signups_7d) || 0,
      chars_used_this_month: usage.used,
      chars_quota: usage.total,
    });
  } catch (err) {
    console.error("Admin overview error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/admin/users", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const plan = req.query.plan || null;
    const offset = (page - 1) * limit;
    const validPlans = ["free", "pre", "active", "payg", "canceled"];
    const planFilter = plan && validPlans.includes(plan) ? plan : null;
    const client = await adminPool.connect();
    try {
      let countQuery = "SELECT COUNT(*) AS total FROM users";
      let dataQuery = `
        SELECT id, email, plan_status, has_access, trial_chars_used, trial_chars_limit,
               subscription_id, created_at, free_chars_reset_date
        FROM users
      `;
      const params = [];
      if (planFilter) {
        countQuery += " WHERE plan_status = $1";
        dataQuery += " WHERE plan_status = $1";
        params.push(planFilter);
      }
      dataQuery += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      const [countResult, dataResult] = await Promise.all([
        client.query(countQuery, planFilter ? [planFilter] : []),
        client.query(dataQuery, [...params, limit, offset]),
      ]);
      const total = parseInt(countResult.rows[0].total) || 0;
      const pages = Math.ceil(total / limit);
      res.json({ users: dataResult.rows, total, page, limit, pages });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Admin users error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/admin/activity", requireAdmin, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));
    const client = await adminPool.connect();
    try {
      const result = await client.query(`
        SELECT DATE(created_at) AS date, COUNT(*) AS count
        FROM users
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `, [days]);
      const signupMap = new Map();
      for (const row of result.rows) {
        signupMap.set(new Date(row.date).toISOString().split('T')[0], parseInt(row.count));
      }
      const signups_by_day = [];
      let total_period = 0;
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        const count = signupMap.get(dateStr) || 0;
        signups_by_day.push({ date: dateStr, count });
        total_period += count;
      }
      res.json({ signups_by_day, total_period });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Admin activity error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

async function userHasActiveSubscription(userId) {
  const user = await getUserById(userId);
  if (user && (user.has_access === true || user.plan_status === "free")) {
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

    let stripeCustomerId = null;
    if (stripe) {
      try {
        const customer = await stripe.customers.create({ email });
        stripeCustomerId = customer.id;
      } catch (stripeErr) {
        console.error("Stripe customer creation failed (non-fatal):", stripeErr.message);
      }
    }

    const user = await createUser(email, passwordHash, stripeCustomerId);

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    res.json({
      token,
      user: { id: user.id, email: user.email },
      hasAccess: true,
      plan_status: "free",
      trial_chars_used: 0,
      trial_chars_limit: 25000,
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
      plan_status: user.plan_status || null,
      trial_chars_used: user.trial_chars_used ?? 0,
      trial_chars_limit: user.trial_chars_limit ?? 25000,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/start-trial", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Payment system not configured" });
    }

    const { email, password, payment_method_id } = req.body;

    let userId;
    let user;
    let isNewUser = false;

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (token) {
      let payload;
      try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
      } catch {
        return res.status(401).json({ error: "Invalid token" });
      }
      userId = payload.userId;
      user = await getUserById(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
    } else {
      if (!email || !password || typeof email !== "string" || typeof password !== "string") {
        return res.status(400).json({ error: "email and password are required for new users" });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }

      const existingUser = await getUserByEmail(email);
      if (existingUser) {
        return res.status(400).json({ error: "Email already registered. Please log in." });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const customer = await stripe.customers.create({ email });
      user = await createUser(email, passwordHash, customer.id);
      userId = user.id;
      isNewUser = true;
    }

    if (["pre", "active", "payg"].includes(user.plan_status) || !!user.subscription_id) {
      return res.status(400).json({ error: "Trial or subscription already active" });
    }

    if (!user.stripe_customer_id) {
      const customer = await stripe.customers.create({ email: user.email });
      await updateUserStripeCustomerId(userId, customer.id);
      user.stripe_customer_id = customer.id;
    }

    if (payment_method_id && typeof payment_method_id === "string") {
      await stripe.paymentMethods.attach(payment_method_id, {
        customer: user.stripe_customer_id,
      });

      await stripe.customers.update(user.stripe_customer_id, {
        invoice_settings: { default_payment_method: payment_method_id },
      });
    }

    const trialEndTimestamp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    const subParams = {
      customer: user.stripe_customer_id,
      items: [{ price: process.env.STRIPE_PRICE_ID }],
      trial_end: trialEndTimestamp,
      trial_settings: {
        end_behavior: {
          missing_payment_method: "cancel",
        },
      },
      metadata: { userId: userId.toString() },
    };

    if (payment_method_id && typeof payment_method_id === "string") {
      subParams.default_payment_method = payment_method_id;
    } else {
      subParams.payment_settings = {
        save_default_payment_method: "on_subscription",
      };
    }

    const subscription = await stripe.subscriptions.create(subParams);

    await createSubscription(
      userId,
      subscription.id,
      subscription.status,
      getPeriodEnd(subscription)
    );

    const updatedUser = await updateUserTrialStart(userId, subscription.id);

    const jwtToken = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "30d" });

    res.json({
      token: jwtToken,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        plan_status: updatedUser.plan_status,
        trial_chars_used: updatedUser.trial_chars_used,
        trial_chars_limit: updatedUser.trial_chars_limit,
        trial_started_at: updatedUser.trial_started_at,
        has_access: updatedUser.has_access,
      },
    });
  } catch (err) {
    console.error("/start-trial error:", err);
    if (err.type && err.type.startsWith("Stripe")) {
      return res.status(402).json({ error: err.message });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/me", requireAuth, async (req, res) => {
  try {
    let user = await getUserById(req.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (["free", "pre", "payg"].includes(user.plan_status)) {
      const reset = await resetUserCharsIfNeeded(req.userId);
      if (reset) {
        user = await getUserById(req.userId);
      }
    }

    const hasAccess = user.plan_status === "free" ? true : await userHasActiveSubscription(req.userId);

    const meResponse = {
      id: user.id,
      email: user.email,
      hasAccess,
      has_access: hasAccess,
      plan_status: user.plan_status || null,
      trial_chars_used: user.trial_chars_used ?? 0,
      trial_chars_limit: user.trial_chars_limit ?? 25000,
      trial_started_at: user.trial_started_at || null,
      free_chars_reset_date: user.free_chars_reset_date || null,
    };

    if (user.plan_status === "payg") {
      // Display-only counters — Stripe metered billing is the source of truth for invoicing
      meResponse.payg_chars_used = (user.trial_chars_used ?? 0) - (user.chars_used_at_payg_start ?? 0);
      meResponse.payg_chars_limit = user.trial_chars_limit ?? 20000000;
    }

    res.json(meResponse);
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

    if (["active", "pre", "payg"].includes(user.plan_status) || !!user.subscription_id) {
      return res.status(400).json({ error: "Subscription already active" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: user.stripe_customer_id,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: {
        metadata: { userId: user.id.toString() },
      },
      success_url: `${process.env.BACKEND_URL || "https://haribackend-mitj.onrender.com"}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BACKEND_URL || "https://haribackend-mitj.onrender.com"}/checkout-cancel`,
      allow_promotion_codes: true,
      metadata: { userId: user.id.toString() },
    });

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error("Checkout session error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/billing/create-trial-checkout-session", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Payment system not configured" });
    }

    const user = await getUserById(req.userId);
    if (!user || !user.stripe_customer_id) {
      return res.status(400).json({ error: "Missing Stripe customer" });
    }

    if (["pre", "active", "payg"].includes(user.plan_status) || !!user.subscription_id) {
      return res.status(400).json({ error: "Trial or subscription already active" });
    }

    const trialEndTimestamp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: user.stripe_customer_id,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: {
        trial_end: trialEndTimestamp,
        metadata: { userId: user.id.toString() },
        trial_settings: {
          end_behavior: {
            missing_payment_method: "cancel",
          },
        },
      },
      payment_method_collection: "if_required",
      success_url: `${process.env.BACKEND_URL || "https://haribackend-mitj.onrender.com"}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BACKEND_URL || "https://haribackend-mitj.onrender.com"}/checkout-cancel`,
      allow_promotion_codes: true,
      metadata: { userId: user.id.toString() },
    });

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error("Trial checkout session error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/billing/verify-session", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Payment system not configured" });
    }

    const { session_id } = req.body;
    if (!session_id || typeof session_id !== "string") {
      return res.status(400).json({ error: "session_id is required" });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["subscription"],
    });

    const sessionUserId = parseInt(session.metadata && session.metadata.userId);
    if (!sessionUserId || isNaN(sessionUserId) || sessionUserId !== req.userId) {
      return res.status(403).json({ error: "Session does not belong to this user" });
    }

    if (session.payment_status !== "paid" && session.status !== "complete") {
      return res.status(402).json({ error: "Payment not completed" });
    }

    const subscription = session.subscription;
    if (!subscription) {
      return res.status(400).json({ error: "No subscription found in session" });
    }

    try {
      await createSubscription(
        req.userId,
        subscription.id,
        subscription.status,
        getPeriodEnd(subscription)
      );
    } catch (dbErr) {
      console.error("verify-session: createSubscription error (non-fatal):", dbErr.message);
    }

    const paygPriceId = process.env.STRIPE_PAYG_PRICE_ID || "price_1TKW2wDKBlUi0cQL7JtrM4lH";
    const isPayg = subscription.items?.data[0]?.price?.id === paygPriceId;

    if (subscription.status === "trialing") {
      await updateUserTrialStart(req.userId, subscription.id);
      console.log(`verify-session: trial activated user=${req.userId} sub=${subscription.id}`);
    } else if (subscription.status === "active") {
      if (isPayg) {
        const stripeItemId = subscription.items.data[0].id;
        await activatePaygPlan(req.userId, subscription.id, stripeItemId);
        console.log(`verify-session: PAYG activated user=${req.userId} sub=${subscription.id} item=${stripeItemId}`);
      } else {
        await updateUserPlanStatus(req.userId, "pre", true, new Date(), subscription.id);
        console.log(`verify-session: active plan set user=${req.userId}`);
      }
    }

    const updatedUser = await getUserById(req.userId);

    res.json({
      success: true,
      plan_status: updatedUser ? updatedUser.plan_status : subscription.status,
      has_access: updatedUser ? updatedUser.has_access : true,
      trial_chars_used: updatedUser ? updatedUser.trial_chars_used : 0,
      trial_chars_limit: updatedUser ? updatedUser.trial_chars_limit : 25000,
    });
  } catch (err) {
    console.error("/billing/verify-session error:", err);
    if (err.type && err.type.startsWith("Stripe")) {
      return res.status(402).json({ error: err.message });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/billing/create-payg-checkout-session", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Payment system not configured" });
    }

    const user = await getUserById(req.userId);
    if (!user || !user.stripe_customer_id) {
      return res.status(400).json({ error: "Missing Stripe customer" });
    }

    if (["pre", "active", "payg"].includes(user.plan_status)) {
      return res.status(400).json({ error: "Already on a paid plan. Use switch-plan to change." });
    }

    const paygPriceId = process.env.STRIPE_PAYG_PRICE_ID || (req.body && req.body.priceId);
    if (!paygPriceId || typeof paygPriceId !== "string" || !paygPriceId.startsWith("price_")) {
      return res.status(503).json({ error: "PAYG price not configured" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: user.stripe_customer_id,
      line_items: [{ price: paygPriceId }],
      subscription_data: {
        metadata: { userId: user.id.toString() },
      },
      success_url: `${process.env.BACKEND_URL || "https://haribackend-mitj.onrender.com"}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BACKEND_URL || "https://haribackend-mitj.onrender.com"}/checkout-cancel`,
      allow_promotion_codes: true,
      metadata: { userId: user.id.toString() },
    });

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error("PAYG checkout session error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/billing/switch-plan", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Payment system not configured" });
    }

    const { targetPlan } = req.body;
    if (!["pre", "payg"].includes(targetPlan)) {
      return res.status(400).json({ error: "targetPlan must be 'pre' or 'payg'" });
    }

    const user = await getUserById(req.userId);
    if (!user || !user.stripe_customer_id) {
      return res.status(400).json({ error: "Missing Stripe customer" });
    }

    if (user.plan_status === targetPlan) {
      return res.status(400).json({ error: `Already on ${targetPlan} plan` });
    }

    if (!["pre", "active", "payg"].includes(user.plan_status)) {
      return res.status(400).json({ error: "No active subscription to switch from. Subscribe first." });
    }

    const subscriptionId = user.subscription_id;
    if (subscriptionId) {
      try {
        await cancelStripeSubscriptionWithFinalUsage(subscriptionId);
      } catch (e) {
        console.error("Failed to cancel old subscription during switch:", e.message);
      }
    } else {
      const subRow = await getLatestSubscriptionForUser(req.userId);
      if (subRow && subRow.stripe_subscription_id) {
        try {
          await cancelStripeSubscriptionWithFinalUsage(subRow.stripe_subscription_id);
        } catch (e) {
          console.error("Failed to cancel old subscription during switch:", e.message);
        }
      }
    }

    const priceId = targetPlan === "payg" ? process.env.STRIPE_PAYG_PRICE_ID : process.env.STRIPE_PRICE_ID;
    const lineItems = targetPlan === "payg"
      ? [{ price: priceId }]
      : [{ price: priceId, quantity: 1 }];

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: user.stripe_customer_id,
      line_items: lineItems,
      subscription_data: {
        metadata: { userId: user.id.toString() },
      },
      success_url: `${process.env.BACKEND_URL || "https://haribackend-mitj.onrender.com"}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BACKEND_URL || "https://haribackend-mitj.onrender.com"}/checkout-cancel`,
      allow_promotion_codes: true,
      metadata: { userId: user.id.toString() },
    });

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error("/billing/switch-plan error:", err);
    if (err.type && err.type.startsWith("Stripe")) {
      return res.status(402).json({ error: err.message });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

async function handleCancelSubscription(req, res) {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Payment system not configured" });
    }

    const user = await getUserById(req.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.plan_status === "free" && !user.subscription_id) {
      return res.json({ success: true, message: "Already on free plan" });
    }

    let subscriptionIdToCancel = user.subscription_id;

    if (!subscriptionIdToCancel) {
      const subRow = await getLatestSubscriptionForUser(req.userId);
      if (subRow && subRow.stripe_subscription_id) {
        subscriptionIdToCancel = subRow.stripe_subscription_id;
      }
    }

    if (!subscriptionIdToCancel && user.stripe_customer_id) {
      try {
        const stripeList = await stripe.subscriptions.list({
          customer: user.stripe_customer_id,
          status: "active",
          limit: 1,
        });
        if (stripeList.data.length > 0) {
          subscriptionIdToCancel = stripeList.data[0].id;
        }
      } catch (listErr) {
        console.error("Stripe subscriptions.list fallback failed (non-fatal):", listErr.message);
      }
    }

    if (subscriptionIdToCancel) {
      await cancelStripeSubscriptionWithFinalUsage(subscriptionIdToCancel);
    } else {
      console.log(`No Stripe subscription found for user=${req.userId} — proceeding with local DB update only`);
    }

    await cancelUserSubscription(req.userId);

    res.json({ success: true, message: "Subscription canceled" });
  } catch (err) {
    console.error("/billing/cancel-subscription error:", err);
    if (err.type && err.type.startsWith("Stripe")) {
      return res.status(402).json({ error: err.message });
    }
    res.status(500).json({ error: "Internal server error" });
  }
}

app.post("/billing/cancel-subscription", requireAuth, handleCancelSubscription);

app.get("/stats", requireAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
    const domain = typeof req.query.domain === "string" && req.query.domain.length > 0
      ? req.query.domain
      : null;

    if (domain) {
      const domainStats = await getStatsByDomain(days);
      const filtered = domainStats.filter((r) => r.domain === domain);
      return res.json({
        period_days: days,
        domain,
        stats: filtered[0] || null,
      });
    }

    const [overall, byDomain] = await Promise.all([
      getOverallStats(days),
      getStatsByDomain(days),
    ]);

    res.json({
      period_days: days,
      overall: overall || null,
      by_domain: byDomain,
    });
  } catch (err) {
    console.error("/stats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/usage", async (req, res) => {
  try {
    const QUOTA = parseInt(process.env.MONTHLY_CHAR_LIMIT) || 10_000_000;
    const row = await getUsage();
    res.json({ used: row.current_month_usage_chars, total: QUOTA });
  } catch (err) {
    console.error("/usage error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/translate", requireAuth, async (req, res) => {
  const requestStart = Date.now();
  try {
    let user = await getUserById(req.userId);

    const hasAccess = (user && user.has_access) || (await userHasActiveSubscription(req.userId));
    if (!hasAccess) {
      return res.status(402).json({ error: "Subscription required" });
    }

    if (
      user &&
      user.plan_status &&
      !["free", "active", "pre", "payg"].includes(user.plan_status)
    ) {
      return res.status(402).json({ error: "no_access" });
    }

    const { sourceLang, targetLang, sentences, segments, domain, isWordLevel } = req.body;

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
    const wordLevel = isWordLevel === true;

    const normalizedTexts = [];
    const cleanedData = [];
    const skipIndices = new Set();

    for (let i = 0; i < textsToTranslate.length; i++) {
      const validation = validateSegment(textsToTranslate[i]);
      if (!validation.valid) {
        return res.status(400).json({ 
          error: `Invalid segment at index ${i}: ${validation.error}` 
        });
      }
      normalizedTexts.push(validation.normalized);

      const segClean = cleanSegment(textsToTranslate[i]);
      cleanedData.push(segClean);

      if (!isTranslatable(segClean.cleaned)) {
        skipIndices.add(i);
      }
    }

    const multiWordIndices = new Set();
    for (let i = 0; i < cleanedData.length; i++) {
      if (!skipIndices.has(i) && isMultiWord(cleanedData[i].cleaned)) {
        multiWordIndices.add(i);
      }
    }

    const totalChars = normalizedTexts.reduce((sum, s) => sum + s.length, 0);
    if (totalChars > 8000) {
      return res.status(400).json({ error: "Request too large (over 8000 characters)" });
    }

    if (user && ["free", "pre"].includes(user.plan_status)) {
      if (["free", "pre"].includes(user.plan_status)) {
        const reset = await resetUserCharsIfNeeded(req.userId);
        if (reset) {
          user = await getUserById(req.userId);
        }
      }
      const charsUsed = user.trial_chars_used ?? 0;
      const charsLimit = user.trial_chars_limit ?? 25000;
      if (charsUsed >= charsLimit) {
        if (user.plan_status === "pre") {
          return res.status(402).json({
            error: "monthly_limit_reached",
            message: "You have used your 1,000,000 monthly characters. Your limit resets in 30 days.",
            trial_chars_used: charsUsed,
            trial_chars_limit: charsLimit,
          });
        }
        return res.status(402).json({
          error: "trial_exhausted",
          message: "You have used your 25,000 free characters.",
          trial_chars_used: charsUsed,
          trial_chars_limit: charsLimit,
        });
      }
    }

    if (user && user.plan_status === "payg") {
      const reset = await resetUserCharsIfNeeded(req.userId);
      if (reset) {
        user = await getUserById(req.userId);
      }
    }

    const QUOTA = parseInt(process.env.MONTHLY_CHAR_LIMIT) || 10_000_000;
    const usageRow = await getUsage();
    if (usageRow.current_month_usage_chars + totalChars > QUOTA * 0.95) {
      return res.status(503).json({ error: "usage_cap_reached" });
    }

    const keys = cleanedData.map((cd) =>
      makeBackendKey(sourceLang, targetLang, cd.cleaned.toLowerCase(), validatedDomain)
    );

    const singleWordKeys = keys.filter((_, i) => !multiWordIndices.has(i));

    const dbStart = Date.now();
    const existingRows = await findTranslationsByKeys(singleWordKeys);
    const dbMs = Date.now() - dbStart;

    const existingMap = new Map();
    existingRows.forEach((row) => {
      existingMap.set(row.key, { translated_text: row.translated_text, original_text: row.original_text });
    });

    const translations = new Array(normalizedTexts.length).fill(null);
    const toTranslate = [];
    const hitStatuses = new Array(normalizedTexts.length).fill(false);

    keys.forEach((key, index) => {
      if (skipIndices.has(index)) {
        translations[index] = textsToTranslate[index];
        hitStatuses[index] = true;
        return;
      }

      if (multiWordIndices.has(index)) {
        toTranslate.push({
          index,
          text: cleanedData[index].cleaned,
          key,
          decorations: cleanedData[index],
        });
        return;
      }

      const cached = existingMap.get(key);
      if (cached) {
        if (cached.original_text !== cleanedData[index].cleaned.toLowerCase()) {
          console.warn(`Cache original_text mismatch for key ${key}: expected "${cleanedData[index].cleaned.toLowerCase()}", got "${cached.original_text}". Treating as cache miss.`);
          toTranslate.push({
            index,
            text: cleanedData[index].cleaned,
            key,
            decorations: cleanedData[index],
          });
        } else {
          translations[index] = reattachDecorations(cached.translated_text, cleanedData[index]);
          hitStatuses[index] = true;
        }
      } else {
        toTranslate.push({
          index,
          text: cleanedData[index].cleaned,
          key,
          decorations: cleanedData[index],
        });
      }
    });

    const totalChunks = normalizedTexts.length;
    const cacheHits = totalChunks - toTranslate.length;
    let mtCalls = toTranslate.length;
    const hitRatePct = totalChunks > 0 ? ((cacheHits / totalChunks) * 100).toFixed(1) : "0.0";

    if (toTranslate.length > 0) {
      const textsForAzure = toTranslate.map((item) => item.text);

      const azureStart = Date.now();
      const newTranslations = await azureTranslate(textsForAzure, sourceLang, targetLang);
      const azureMs = Date.now() - azureStart;

      if (newTranslations.length !== textsForAzure.length) {
        console.error(
          "Length mismatch from Azure",
          textsForAzure.length,
          newTranslations.length
        );
        return res.status(500).json({ error: "Translation length mismatch" });
      }

      const retryItems = [];
      const rowsToInsert = [];
      const dictLookupItems = [];

      newTranslations.forEach((tl, i) => {
        const { index, key, text, decorations } = toTranslate[i];
        const isSingleWord = !multiWordIndices.has(index);
        const echoed = isEchoedTranslation(text, tl);

        if (echoed && wordLevel) {
          retryItems.push({ i, index, key, text, decorations });
          return;
        }

        if (echoed) {
          if (isSingleWord) {
            dictLookupItems.push({ index, key, text, decorations, bestEffort: reattachDecorations(tl, decorations) });
          } else {
            translations[index] = textsToTranslate[index];
          }
          console.log(`[translate] echo detected, skipping cache: "${text}"`);
          return;
        }

        if (!isValidTranslation(text, tl)) {
          if (isSingleWord) {
            dictLookupItems.push({ index, key, text, decorations, bestEffort: reattachDecorations(tl, decorations) });
          } else {
            translations[index] = textsToTranslate[index];
          }
          console.warn(`[translate] placeholder leak detected, falling back: "${text}" → "${tl}"`);
          return;
        }

        const finalTranslation = reattachDecorations(tl, decorations);
        translations[index] = finalTranslation;
        rowsToInsert.push({
          key,
          source_lang: sourceLang,
          target_lang: targetLang,
          original_text: decorations.cleaned.toLowerCase(),
          translated_text: tl,
          domain: validatedDomain,
        });
      });

      if (retryItems.length > 0) {
        const retryTexts = retryItems.map((r) => r.text);
        try {
          const retryTranslations = await azureTranslate(retryTexts, sourceLang, targetLang);
          mtCalls += retryItems.length;
          if (Array.isArray(retryTranslations)) {
            retryTranslations.forEach((tl, ri) => {
              const { index, key, text, decorations } = retryItems[ri];
              const isSingleWord = !multiWordIndices.has(index);
              const stillEchoed = isEchoedTranslation(text, tl);

              if (stillEchoed) {
                if (isSingleWord) {
                  dictLookupItems.push({ index, key, text, decorations, bestEffort: reattachDecorations(tl, decorations) });
                } else {
                  translations[index] = textsToTranslate[index];
                }
                console.log(`[translate] word retry still echoed, skipping: "${text}"`);
                return;
              }

              if (!isValidTranslation(text, tl)) {
                if (isSingleWord) {
                  dictLookupItems.push({ index, key, text, decorations, bestEffort: reattachDecorations(tl, decorations) });
                } else {
                  translations[index] = textsToTranslate[index];
                }
                console.warn(`[translate] placeholder leak detected on retry, falling back: "${text}" → "${tl}"`);
                return;
              }

              const finalTranslation = reattachDecorations(tl, decorations);
              translations[index] = finalTranslation;
              rowsToInsert.push({
                key,
                source_lang: sourceLang,
                target_lang: targetLang,
                original_text: decorations.cleaned.toLowerCase(),
                translated_text: tl,
                domain: validatedDomain,
              });
            });
          }
        } catch (retryErr) {
          console.error("[translate] word retry failed:", retryErr.message);
          retryItems.forEach(({ index, key, text, decorations }) => {
            if (!multiWordIndices.has(index)) {
              dictLookupItems.push({ index, key, text, decorations, bestEffort: textsToTranslate[index] });
            } else {
              translations[index] = textsToTranslate[index];
            }
          });
        }
      }

      if (dictLookupItems.length > 0) {
        const dictTexts = dictLookupItems.map((d) => d.text);
        try {
          const dictResults = await azureDictionaryLookup(dictTexts, sourceLang, targetLang);
          dictResults.forEach((dictTarget, di) => {
            const { index, key, text, decorations, bestEffort } = dictLookupItems[di];
            if (dictTarget && !isEchoedTranslation(text, dictTarget) && isValidTranslation(text, dictTarget)) {
              const finalTranslation = reattachDecorations(dictTarget, decorations);
              translations[index] = finalTranslation;
              rowsToInsert.push({
                key,
                source_lang: sourceLang,
                target_lang: targetLang,
                original_text: decorations.cleaned.toLowerCase(),
                translated_text: dictTarget,
                domain: validatedDomain,
              });
            } else {
              translations[index] = bestEffort;
            }
          });
        } catch (dictErr) {
          console.error("[translate] dictionary lookup failed:", dictErr.message);
          dictLookupItems.forEach(({ index, bestEffort }) => {
            translations[index] = bestEffort;
          });
        }
      }

      await insertTranslations(rowsToInsert.filter((row) => !row.original_text.includes(" ")));

      const azureChars = toTranslate.reduce((sum, item) => sum + item.text.length, 0);
      if (azureChars > 0) {
        await incrementUsage(azureChars);
      }

      console.log(
        `[translate] domain=${validatedDomain} total_chunks=${totalChunks} cache_hits=${cacheHits} mt_calls=${mtCalls} skipped=${skipIndices.size} hit_rate=${hitRatePct}% db=${dbMs}ms azure=${azureMs}ms total=${Date.now() - requestStart}ms`
      );
    } else {
      console.log(
        `[translate] domain=${validatedDomain} total_chunks=${totalChunks} cache_hits=${cacheHits} mt_calls=${mtCalls} skipped=${skipIndices.size} hit_rate=${hitRatePct}% db=${dbMs}ms total=${Date.now() - requestStart}ms`
      );
    }

    logTranslationUsage(
      req.userId,
      normalizedTexts,
      hitStatuses,
      validatedDomain,
      sourceLang,
      targetLang,
      'translator'
    );

    let cacheChars = 0;
    let liveChars = 0;

    for (let i = 0; i < cleanedData.length; i++) {
      if (skipIndices.has(i)) continue;
      if (hitStatuses[i] && !multiWordIndices.has(i)) {
        cacheChars += cleanedData[i].cleaned.length;
      }
    }
    for (const item of toTranslate) {
      liveChars += item.text.length;
    }

    const billableChars = cacheChars + liveChars;

    if (user && user.plan_status === "payg") {
      await incrementUserTrialChars(req.userId, billableChars);

      const freshUser = await getUserById(req.userId);
      if (freshUser?.stripe_customer_id && stripe && billableChars > 0) {
        const charsToReport = Math.ceil(billableChars / 1000);
        try {
          await stripe.billing.meterEvents.create({
            event_name: "translation_chars",
            payload: {
              value: String(charsToReport),
              stripe_customer_id: freshUser.stripe_customer_id,
            },
          });
          console.log(`[payg] billed user=${req.userId} cache=${cacheChars} live=${liveChars} total=${billableChars} units=${charsToReport}`);
        } catch (e) {
          console.error("PAYG Stripe meter event failed (non-fatal):", e.message);
        }
      }

      const charsUsedBefore = user.trial_chars_used ?? 0;
      const updatedCharsUsed = charsUsedBefore + billableChars;
      const paygBaseline = user.chars_used_at_payg_start ?? 0;
      const softLimit = user.trial_chars_limit ?? 20_000_000;
      const paygResponse = {
        translations,
        payg_chars_used: updatedCharsUsed - paygBaseline,
        payg_chars_limit: softLimit,
      };
      if (updatedCharsUsed >= softLimit) {
        paygResponse.payg_soft_limit_warning = "You have exceeded the 20M character soft limit. Contact support if needed.";
      }
      return res.json(paygResponse);
    }

    if (user && ["free", "pre"].includes(user.plan_status)) {
      const updatedUser = await incrementUserTrialChars(req.userId, billableChars);
      if (updatedUser && updatedUser.trial_chars_used >= updatedUser.trial_chars_limit) {
        if (user.plan_status === "free" && stripe && updatedUser.subscription_id) {
          try {
            await stripe.subscriptions.update(updatedUser.subscription_id, {
              trial_end: "now",
            });
            console.log(`Trial ended early for user ${req.userId} after hitting char limit`);
          } catch (stripeErr) {
            console.error("Failed to end Stripe trial early:", stripeErr.message);
          }
        }
      }
      return res.json({
        translations,
        trial_chars_used: updatedUser ? updatedUser.trial_chars_used : null,
        trial_chars_limit: updatedUser ? updatedUser.trial_chars_limit : null,
      });
    }

    return res.json({ translations });
  } catch (err) {
    console.error("Internal /translate error", err);

    if (err.azureStatus != null) {
      const s = err.azureStatus;
      if (s === 401 || s === 403) {
        return res.status(401).json({ error: "Translation service authentication failed" });
      }
      if (s === 429) {
        return res.status(503).json({ error: "Translation service rate limited" });
      }
      if (s >= 500 && s < 600) {
        return res.status(500).json({ error: "Translation service error" });
      }
      return res.status(502).json({ error: "Upstream translation error", details: err.message });
    }

    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/cancel-subscription", requireAuth, handleCancelSubscription);

app.post("/dictionary", requireAuth, async (req, res) => {
  try {
    let user = await getUserById(req.userId);

    const hasAccess = (user && user.has_access) || (await userHasActiveSubscription(req.userId));
    if (!hasAccess) {
      return res.status(402).json({ error: "Subscription required" });
    }

    if (
      user &&
      user.plan_status &&
      !["free", "active", "pre", "payg"].includes(user.plan_status)
    ) {
      return res.status(402).json({ error: "no_access" });
    }

    const { word, english, context } = req.body;

    if (!word || typeof word !== "string" || word.trim() === "" ||
        !english || typeof english !== "string" || english.trim() === "") {
      return res.status(400).json({ error: "word and english are required" });
    }

    const contextStr = typeof context === "string" ? context : "";
    const totalChars = word.trim().length + english.trim().length + contextStr.trim().length;

    if (user && ["free", "pre"].includes(user.plan_status)) {
      const reset = await resetUserCharsIfNeeded(req.userId);
      if (reset) {
        user = await getUserById(req.userId);
      }
      const charsUsed = user.trial_chars_used ?? 0;
      const charsLimit = user.trial_chars_limit ?? 25000;
      if (charsUsed >= charsLimit) {
        if (user.plan_status === "pre") {
          return res.status(402).json({
            error: "monthly_limit_reached",
            message: "You have used your 1,000,000 monthly characters. Your limit resets in 30 days.",
            trial_chars_used: charsUsed,
            trial_chars_limit: charsLimit,
          });
        }
        return res.status(402).json({
          error: "trial_exhausted",
          message: "You have used your 25,000 free characters.",
          trial_chars_used: charsUsed,
          trial_chars_limit: charsLimit,
        });
      }
    }

    if (user && user.plan_status === "payg") {
      const reset = await resetUserCharsIfNeeded(req.userId);
      if (reset) {
        user = await getUserById(req.userId);
      }
    }

    let entry;
    try {
      entry = await llmDictionary(word.trim(), english.trim(), contextStr.trim());
    } catch (llmErr) {
      console.error("[dictionary] LLM error:", llmErr.message);
      return res.status(500).json({ error: "dictionary_unavailable" });
    }

    await incrementUsage(totalChars);
    logTranslationUsage(
      req.userId,
      [word.trim()],
      [false],
      'dictionary',
      'tl',
      'en',
      'llm'
    );

    if (user && user.plan_status === "payg") {
      await incrementUserTrialChars(req.userId, totalChars);
      const freshUser = await getUserById(req.userId);
      if (freshUser?.stripe_customer_id && stripe) {
        const charsToReport = Math.ceil(totalChars / 1000);
        if (charsToReport > 0) {
          try {
            await stripe.billing.meterEvents.create({
              event_name: "translation_chars",
              payload: {
                value: String(charsToReport),
                stripe_customer_id: freshUser.stripe_customer_id,
              },
            });
            console.log(`[payg] billed user=${req.userId} total=${totalChars} units=${charsToReport}`);
          } catch (e) {
            console.error("PAYG Stripe meter event failed (non-fatal):", e.message);
          }
        }
      }
      const charsUsedBefore = user.trial_chars_used ?? 0;
      const updatedCharsUsed = charsUsedBefore + totalChars;
      const paygBaseline = user.chars_used_at_payg_start ?? 0;
      const softLimit = user.trial_chars_limit ?? 20_000_000;
      const paygResponse = {
        ...entry,
        payg_chars_used: updatedCharsUsed - paygBaseline,
        payg_chars_limit: softLimit,
      };
      if (updatedCharsUsed >= softLimit) {
        paygResponse.payg_soft_limit_warning = "You have exceeded the 20M character soft limit. Contact support if needed.";
      }
      return res.json(paygResponse);
    }

    if (user && ["free", "pre"].includes(user.plan_status)) {
      const updatedUser = await incrementUserTrialChars(req.userId, totalChars);
      return res.json({
        ...entry,
        trial_chars_used: updatedUser ? updatedUser.trial_chars_used : null,
        trial_chars_limit: updatedUser ? updatedUser.trial_chars_limit : null,
      });
    }

    return res.json(entry);
  } catch (err) {
    console.error("[dictionary] error:", err);
    return res.status(500).json({ error: "dictionary_unavailable" });
  }
});


const clickRateLimiter = new Map();

app.post("/track/click", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxPerWindow = 10;

  const entry = clickRateLimiter.get(ip);
  if (entry && now < entry.resetAt) {
    if (entry.count >= maxPerWindow) {
      return res.status(204).end();
    }
    entry.count++;
  } else {
    clickRateLimiter.set(ip, { count: 1, resetAt: now + windowMs });
  }

  try {
    const { btn, ref } = req.body || {};
    const btnId = btn && typeof btn === "string" ? btn.slice(0, 64) : null;
    const referrer = ref && typeof ref === "string" ? ref : null;
    const userAgent = req.headers["user-agent"] || null;
    await insertClickEvent(btnId, referrer, userAgent);
  } catch (err) {
    console.error("click tracking error (non-fatal):", err.message);
  }

  return res.status(204).end();
});

app.get("/admin/website-activity", requireAdmin, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const result = await getWebsiteActivity(days);
    res.json(result);
  } catch (err) {
    console.error("admin/website-activity error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/tts", requireAuth, async (req, res) => {
  if (!process.env.AZURE_SPEECH_KEY) {
    return res.status(503).json({ error: "TTS service not configured" });
  }

  let user = await getUserById(req.userId);
  const hasAccess = (user && user.has_access) || (await userHasActiveSubscription(req.userId));
  if (!hasAccess) {
    return res.status(402).json({ error: "Subscription required" });
  }

  const { text, voice = "en-US-Ava:DragonHDLatestNeural", native = false } = req.body;

  if (!text || text.length > 500) {
    return res.status(400).json({ error: "Invalid text" });
  }

  const ttsChars = text.length;
  const weightedChars = ttsChars * 2;

  if (user && ["free", "pre"].includes(user.plan_status)) {
    const reset = await resetUserCharsIfNeeded(req.userId);
    if (reset) {
      user = await getUserById(req.userId);
    }
    const charsUsed = user.trial_chars_used ?? 0;
    const charsLimit = user.trial_chars_limit ?? 25000;
    if (charsUsed >= charsLimit) {
      if (user.plan_status === "pre") {
        return res.status(402).json({
          error: "monthly_limit_reached",
          message: "You have used your 1,000,000 monthly characters. Your limit resets in 30 days.",
          trial_chars_used: charsUsed,
          trial_chars_limit: charsLimit,
        });
      }
      return res.status(402).json({
        error: "trial_exhausted",
        message: "You have used your 25,000 free characters.",
        trial_chars_used: charsUsed,
        trial_chars_limit: charsLimit,
      });
    }
  }

  if (user && user.plan_status === "payg") {
    const reset = await resetUserCharsIfNeeded(req.userId);
    if (reset) {
      user = await getUserById(req.userId);
    }
  }

  const safeText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

  let ssml;
  if (native) {
    ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="fil-PH"><voice name="${voice}">${safeText}</voice></speak>`;
  } else {
    ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="fil-PH"><voice name="${voice}"><lang xml:lang="fil-PH">${safeText}</lang></voice></speak>`;
  }

  try {
    const response = await fetch(
      `https://eastus.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-16khz-128kbitrate-mono-mp3",
        },
        body: ssml,
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("Azure TTS error:", response.status, errorBody);
      return res.status(response.status).json({ error: "TTS request failed", details: errorBody });
    }

    await incrementUsage(ttsChars);
    logTranslationUsage(
      req.userId,
      [text],
      [false],
      'tts',
      'fil',
      'fil',
      'tts'
    );

    if (user && user.plan_status === "payg") {
      await incrementUserTrialChars(req.userId, weightedChars);
      const freshUser = await getUserById(req.userId);
      if (freshUser?.stripe_customer_id && stripe && weightedChars > 0) {
        const unitsToReport = Math.ceil(weightedChars / 1000);
        try {
          await stripe.billing.meterEvents.create({
            event_name: "translation_chars",
            payload: {
              value: String(unitsToReport),
              stripe_customer_id: freshUser.stripe_customer_id,
            },
          });
          console.log(`[tts] billed user=${req.userId} raw=${ttsChars} weighted=${weightedChars} units=${unitsToReport}`);
        } catch (e) {
          console.error("TTS PAYG Stripe meter event failed (non-fatal):", e.message);
        }
      }
    }

    if (user && ["free", "pre"].includes(user.plan_status)) {
      await incrementUserTrialChars(req.userId, weightedChars);
    }

    res.set("Content-Type", "audio/mpeg");
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("TTS service error:", err);
    res.status(500).json({ error: "TTS service error" });
  }
});

app.post("/xp/sync", requireAuth, async (req, res) => {
  const { xp_balance, xp_lifetime_earned } = req.body;
  if (
    !Number.isInteger(xp_balance) || xp_balance < 0 ||
    !Number.isInteger(xp_lifetime_earned) || xp_lifetime_earned < 0
  ) {
    return res.status(400).json({ error: "xp_balance and xp_lifetime_earned must be non-negative integers" });
  }
  try {
    const updated = await syncUserXp(req.userId, xp_balance, xp_lifetime_earned);
    if (!updated) {
      return res.status(500).json({ error: "Internal server error" });
    }
    return res.json({ xp_balance: updated.xp_balance, xp_lifetime_earned: updated.xp_lifetime_earned });
  } catch (err) {
    console.error("POST /xp/sync error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/xp", requireAuth, async (req, res) => {
  try {
    const xp = await getUserXp(req.userId);
    if (!xp) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json({ xp_balance: xp.xp_balance, xp_lifetime_earned: xp.xp_lifetime_earned });
  } catch (err) {
    console.error("GET /xp error:", err);
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
        "WARNING: DATABASE_URL not set - running without cache (will use Azure for every request)"
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
