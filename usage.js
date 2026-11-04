// What people spend their characters on. Every feature that charges characters records one row per
// person, per day, per feature (usage_daily: characters charged and number of uses), so it stays small
// however much people use Hari. Accounts on the admin plan (plan_status 'active') read it back:
//
//   GET /admin-plan/usage?days=30          totals, by feature, the people using the most, by day
//   GET /admin-plan/usage/user/:id?days=30 one person: their plan and allowance, by feature, by day
// "By day" splits each day's characters by feature. Anyone in the database can be looked up, not only
// people with usage in the period (the list of accounts comes from /messages/recipients).
const FEATURES = {
  reading: "Reading pages",
  lookup: "Word lookups",
  voice: "Voice",
  subtitles: "YouTube subtitles",
  tutor: "Thea",
  practice: "Practice",
  explain: "Explain My Mistake",
  sayit: "Say It Like a Native",
  shadowing: "Shadowing Coach",
  speech: "Speech input",
};

// the names features charge under, grouped into what people would call them
const KIND_TO_FEATURE = {
  translate: "reading", reading: "reading",
  dictionary: "lookup", lookup: "lookup", "lookup-cached": "lookup",
  tts: "voice", "tts-cached": "voice", "free-tts": "voice",
  subtitles: "subtitles",
  tutor: "tutor",
  practice: "practice",
  explain: "explain",
  sayit: "sayit",
  shadow: "shadowing", shadowguide: "shadowing", "shadowguide-cached": "shadowing",
  stt: "speech",
};

let ready = null;
function ensureUsageTable(pool) {
  if (!ready) {
    ready = pool
      .query(`CREATE TABLE IF NOT EXISTS usage_daily (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day DATE NOT NULL,
        feature TEXT NOT NULL,
        chars BIGINT NOT NULL DEFAULT 0,
        uses INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day, feature)
      )`)
      .then(() => pool.query("CREATE INDEX IF NOT EXISTS usage_daily_day ON usage_daily (day)"))
      .catch((err) => { ready = null; console.error("[usage] table setup failed:", err.message); });
  }
  return ready;
}

/** Notes a use of a feature and the characters it charged. Never throws and never delays the request. */
function recordUsage(pool, userId, kind, chars) {
  const feature = KIND_TO_FEATURE[kind];
  if (!pool || !userId || !feature) return;
  const n = Math.max(0, Math.round(Number(chars) || 0));
  setImmediate(async () => {
    try {
      await ensureUsageTable(pool);
      await pool.query(
        `INSERT INTO usage_daily (user_id, day, feature, chars, uses) VALUES ($1, CURRENT_DATE, $2, $3, 1)
         ON CONFLICT (user_id, day, feature) DO UPDATE SET chars = usage_daily.chars + EXCLUDED.chars, uses = usage_daily.uses + 1`,
        [userId, feature, n]
      );
    } catch (err) {
      console.error("[usage] record failed (non-fatal):", err.message);
    }
  });
}

function mountUsageAnalytics(app, { pool, requireAuth, getUserById }) {
  ensureUsageTable(pool);

  async function requireAdminPlan(req, res, next) {
    try {
      const user = await getUserById(req.userId);
      if (!user || user.plan_status !== "active") return res.status(403).json({ error: "not_allowed" });
      next();
    } catch (err) {
      res.status(500).json({ error: "usage_unavailable" });
    }
  }

  const daysOf = (req) => Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
  // rows of (day, feature, chars, uses) into one entry per day, with each feature's characters that day
  const byDay = (rows) => {
    const days = new Map();
    for (const r of rows) {
      const key = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
      const d = days.get(key) || { day: key, chars: 0, uses: 0, features: {} };
      d.chars += n(r.chars);
      d.uses += n(r.uses);
      d.features[r.feature] = (d.features[r.feature] || 0) + n(r.chars);
      days.set(key, d);
    }
    return [...days.values()];
  };
  const label = (f) => FEATURES[f] || f;
  const n = (v) => Number(v) || 0;

  app.get("/admin-plan/usage", requireAuth, requireAdminPlan, async (req, res) => {
    const days = daysOf(req);
    try {
      await ensureUsageTable(pool);
      const since = `CURRENT_DATE - ($1::int - 1)`;
      const [byFeature, people, daily, totals] = await Promise.all([
        pool.query(`SELECT feature, SUM(chars) AS chars, SUM(uses) AS uses, COUNT(DISTINCT user_id) AS people
                    FROM usage_daily WHERE day >= ${since} GROUP BY feature ORDER BY SUM(chars) DESC`, [days]),
        pool.query(`SELECT u.id, u.email, u.plan_status, SUM(d.chars) AS chars, SUM(d.uses) AS uses,
                      (ARRAY_AGG(d.feature ORDER BY d.chars DESC))[1] AS top_feature
                    FROM usage_daily d JOIN users u ON u.id = d.user_id
                    WHERE d.day >= ${since} GROUP BY u.id, u.email, u.plan_status
                    ORDER BY SUM(d.chars) DESC LIMIT 200`, [days]),
        pool.query(`SELECT day, feature, SUM(chars) AS chars, SUM(uses) AS uses FROM usage_daily
                    WHERE day >= ${since} GROUP BY day, feature ORDER BY day`, [days]),
        pool.query(`SELECT COALESCE(SUM(chars), 0) AS chars, COALESCE(SUM(uses), 0) AS uses, COUNT(DISTINCT user_id) AS people
                    FROM usage_daily WHERE day >= ${since}`, [days]),
      ]);
      res.json({
        days,
        totals: { chars: n(totals.rows[0].chars), uses: n(totals.rows[0].uses), people: n(totals.rows[0].people) },
        byFeature: byFeature.rows.map((r) => ({ feature: r.feature, label: label(r.feature), chars: n(r.chars), uses: n(r.uses), people: n(r.people) })),
        people: people.rows.map((r) => ({ id: r.id, email: r.email, plan: r.plan_status || "free", chars: n(r.chars), uses: n(r.uses), topFeature: label(r.top_feature) })),
        daily: byDay(daily.rows),
      });
    } catch (err) {
      console.error("[usage] overview failed:", err.message);
      res.status(500).json({ error: "usage_unavailable" });
    }
  });

  app.get("/admin-plan/usage/user/:id", requireAuth, requireAdminPlan, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
    const days = daysOf(req);
    try {
      await ensureUsageTable(pool);
      const user = await getUserById(id);
      if (!user) return res.status(404).json({ error: "not_found" });
      const since = `CURRENT_DATE - ($2::int - 1)`;
      const [byFeature, daily] = await Promise.all([
        pool.query(`SELECT feature, SUM(chars) AS chars, SUM(uses) AS uses FROM usage_daily
                    WHERE user_id = $1 AND day >= ${since} GROUP BY feature ORDER BY SUM(chars) DESC`, [id, days]),
        pool.query(`SELECT day, feature, SUM(chars) AS chars, SUM(uses) AS uses FROM usage_daily
                    WHERE user_id = $1 AND day >= ${since} GROUP BY day, feature ORDER BY day`, [id, days]),
      ]);
      res.json({
        days,
        user: {
          id: user.id,
          email: user.email,
          plan: user.plan_status || "free",
          used: n(user.trial_chars_used) - (user.plan_status === "payg" ? n(user.chars_used_at_payg_start) : 0),
          limit: user.plan_status === "active" ? null : n(user.trial_chars_limit),
          resetsOn: user.free_chars_reset_date || null,
          joined: user.created_at || null,
        },
        byFeature: byFeature.rows.map((r) => ({ feature: r.feature, label: label(r.feature), chars: n(r.chars), uses: n(r.uses) })),
        daily: byDay(daily.rows),
      });
    } catch (err) {
      console.error("[usage] person failed:", err.message);
      res.status(500).json({ error: "usage_unavailable" });
    }
  });
}

module.exports = { recordUsage, mountUsageAnalytics, FEATURES, KIND_TO_FEATURE };
