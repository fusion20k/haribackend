require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
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
} = require("./db");
const { logTranslationUsage, getOverallStats, getStatsByDomain, getMonthlyUsage } = require("./analytics");
const { normalizeSegment, validateSegment, cleanSegment, isTranslatable, reattachDecorations, isEchoedTranslation } = require("./segmentation");

const app = express();
const PORT = process.env.PORT || 10000;

function mapLangCode(lang) {
  const MAP = { tl: "fil" };
  return MAP[lang] || lang;
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
              new Date(subscription.current_period_end * 1000)
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
                await stripe.subscriptions.cancel(previousSubscriptionId);
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
              new Date(subscription.current_period_end * 1000)
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
          new Date(subscription.current_period_end * 1000)
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
            if (currentUser && currentUser.subscription_id === subscription.id) {
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
          if (currentUser && currentUser.subscription_id === subscription.id) {
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
<p>Your free trial has started. You can close this tab and return to your browser — Hari is ready to use.</p>
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

    if (["pre", "active"].includes(user.plan_status) || !!user.subscription_id) {
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
      new Date(subscription.current_period_end * 1000)
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
    };

    if (user.plan_status === "payg") {
      meResponse.payg_chars_used = user.trial_chars_used ?? 0;
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

    if (["active", "pre"].includes(user.plan_status)) {
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

    if (["pre", "active"].includes(user.plan_status) || !!user.subscription_id) {
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
        new Date(subscription.current_period_end * 1000)
      );
    } catch (dbErr) {
      console.error("verify-session: createSubscription error (non-fatal):", dbErr.message);
    }

    if (subscription.status === "trialing") {
      await updateUserTrialStart(req.userId, subscription.id);
      console.log(`verify-session: trial activated user=${req.userId} sub=${subscription.id}`);
    } else if (subscription.status === "active") {
      await updateUserPlanStatus(req.userId, "pre", true, new Date(), subscription.id);
      console.log(`verify-session: active plan set user=${req.userId}`);
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

    if (user.plan_status === "payg") {
      return res.status(400).json({ error: "Already on PAYG plan" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: user.stripe_customer_id,
      line_items: [{ price: process.env.STRIPE_PAYG_PRICE_ID }],
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

    const dbStart = Date.now();
    const existingRows = await findTranslationsByKeys(keys);
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

      newTranslations.forEach((tl, i) => {
        const { index, key, text, decorations } = toTranslate[i];
        const echoed = isEchoedTranslation(text, tl);

        if (echoed && wordLevel) {
          retryItems.push({ i, index, key, text, decorations });
          return;
        }

        if (echoed) {
          translations[index] = textsToTranslate[index];
          console.log(`[translate] echo detected, skipping cache: "${text}"`);
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
              const stillEchoed = isEchoedTranslation(text, tl);

              if (stillEchoed) {
                translations[index] = textsToTranslate[index];
                console.log(`[translate] word retry still echoed, skipping: "${text}"`);
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
          retryItems.forEach(({ index }) => {
            translations[index] = textsToTranslate[index];
          });
        }
      }

      await insertTranslations(rowsToInsert);

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
      targetLang
    );

    if (user && user.plan_status === "payg") {
      await incrementUserTrialChars(req.userId, totalChars);

      const freshUser = await getUserById(req.userId);
      if (freshUser?.stripe_item_id && stripe) {
        setImmediate(async () => {
          try {
            await stripe.subscriptionItems.createUsageRecord(
              freshUser.stripe_item_id,
              { quantity: totalChars, timestamp: "now", action: "increment" }
            );
          } catch (e) {
            console.error("PAYG Stripe usage report failed (non-fatal):", e.message);
          }
        });
      }

      const charsUsedBefore = user.trial_chars_used ?? 0;
      const updatedCharsUsed = charsUsedBefore + totalChars;
      const softLimit = user.trial_chars_limit ?? 20_000_000;
      const paygResponse = {
        translations,
        payg_chars_used: updatedCharsUsed,
        payg_chars_limit: softLimit,
      };
      if (updatedCharsUsed >= softLimit) {
        paygResponse.payg_soft_limit_warning = "You have exceeded the 20M character soft limit. Contact support if needed.";
      }
      return res.json(paygResponse);
    }

    if (user && ["free", "pre"].includes(user.plan_status)) {
      const updatedUser = await incrementUserTrialChars(req.userId, totalChars);
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

app.post("/cancel-subscription", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Payment system not configured" });
    }

    const user = await getUserById(req.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const subscriptionId = user.subscription_id;
    if (!subscriptionId) {
      const subRow = await getLatestSubscriptionForUser(req.userId);
      if (!subRow || !subRow.stripe_subscription_id) {
        return res.status(400).json({ error: "No active subscription found" });
      }
      await stripe.subscriptions.cancel(subRow.stripe_subscription_id);
    } else {
      await stripe.subscriptions.cancel(subscriptionId);
    }

    await cancelUserSubscription(req.userId);

    res.json({ success: true, message: "Subscription canceled" });
  } catch (err) {
    console.error("/cancel-subscription error:", err);
    if (err.type && err.type.startsWith("Stripe")) {
      return res.status(402).json({ error: err.message });
    }
    res.status(500).json({ error: "Internal server error" });
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
