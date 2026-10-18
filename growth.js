// Read-only marketing stats for the Hari growth app (app.haritagalog.com).
// Ties sign-ups and payments back to the post/video/blog that brought the user in.
// Protected by the GROWTH_API_KEY environment variable (header x-growth-key). Returns no emails.
const crypto = require("crypto");

const SOURCE_PREFIX = "src_";

/** Source code carried in a referralToken from the website (e.g. "src_v42-tiktok"), or null. */
function sourceFromToken(token) {
  if (typeof token !== "string" || !token.startsWith(SOURCE_PREFIX)) return null;
  const src = token.slice(SOURCE_PREFIX.length).toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(src) ? src : null;
}

/** Remember where a user came from (first source wins). Never throws. */
async function recordSignupSource(pool, userId, token) {
  const src = sourceFromToken(token);
  if (!src || !userId) return;
  try {
    await pool.query("UPDATE users SET signup_source = $2 WHERE id = $1 AND signup_source IS NULL", [userId, src]);
  } catch (err) {
    console.error("recordSignupSource failed (non-fatal):", err.message);
  }
}

async function ensureGrowthColumns(pool) {
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_source VARCHAR(64)");
}

function keyMatches(given) {
  const key = process.env.GROWTH_API_KEY;
  if (!key || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function mountGrowth(app, { pool, stripe }) {
  ensureGrowthColumns(pool).catch((err) => console.error("growth columns:", err.message));

  app.get("/growth/stats", async (req, res) => {
    if (!keyMatches(req.get("x-growth-key"))) return res.status(401).json({ error: "unauthorized" });
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 90));
    const since = new Date(Date.now() - days * 86400000);
    try {
      // website visits that arrived with ?src=<code>, per source per day
      const visits = await pool.query(
        `SELECT lower(substring(page_url from '[?&]src=([A-Za-z0-9._-]+)')) AS src,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                count(*)::int AS visits,
                count(DISTINCT session_id)::int AS sessions
           FROM analytics_events
          WHERE event_type = 'page_visit' AND created_at >= $1 AND page_url ~ '[?&]src='
          GROUP BY 1, 2`,
        [since]
      );
      // all visits and installs per day (for time-based attribution of posts without links)
      const daily = await pool.query(
        `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE event_type = 'page_visit')::int AS visits,
                count(*) FILTER (WHERE event_type = 'extension_install')::int AS installs
           FROM analytics_events
          WHERE created_at >= $1 AND event_type IN ('page_visit', 'extension_install')
          GROUP BY 1`,
        [since]
      );
      const users = await pool.query(
        `SELECT id, created_at, signup_source, plan_status, plan_source, trial_converted_at, stripe_customer_id IS NOT NULL AS has_customer
           FROM users
          WHERE created_at >= $1 OR trial_converted_at >= $1`,
        [since]
      );
      const subs = await pool.query(
        `SELECT user_id, status, created_at, updated_at
           FROM subscriptions
          WHERE created_at >= $1 OR updated_at >= $1`,
        [since]
      );

      // paid invoices, matched to users through their Stripe customer id
      const revenue = [];
      if (stripe) {
        const customers = await pool.query("SELECT id, stripe_customer_id FROM users WHERE stripe_customer_id IS NOT NULL");
        const userByCustomer = new Map(customers.rows.map((r) => [r.stripe_customer_id, r.id]));
        let n = 0;
        for await (const inv of stripe.invoices.list({ status: "paid", created: { gte: Math.floor(since.getTime() / 1000) }, limit: 100 })) {
          if (++n > 2000) break;
          if (!inv.amount_paid) continue;
          revenue.push({
            user_id: userByCustomer.get(typeof inv.customer === "string" ? inv.customer : inv.customer?.id) ?? null,
            amount: inv.amount_paid / 100,
            currency: inv.currency,
            at: new Date(inv.status_transitions?.paid_at ? inv.status_transitions.paid_at * 1000 : inv.created * 1000).toISOString(),
          });
        }
      }

      res.json({
        generatedAt: new Date().toISOString(),
        days,
        visits: visits.rows,
        daily: daily.rows,
        users: users.rows,
        subscriptions: subs.rows,
        revenue,
        stripe: Boolean(stripe),
      });
    } catch (err) {
      console.error("/growth/stats error:", err);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { mountGrowth, recordSignupSource, sourceFromToken };
