// The usage stats endpoints (usage.js): only the admin plan can read them, and they come back in the
// shape the extension's Usage screen expects. The database is a stand-in that answers each query.
//   node scripts/check-usage.js
const express = require("express");
const { mountUsageAnalytics } = require("../usage");

const users = { 1: { id: 1, email: "admin@hari.test", plan_status: "active" }, 2: { id: 2, email: "ana@example.com", plan_status: "exc", trial_chars_used: 80000, trial_chars_limit: 1000000, free_chars_reset_date: "2026-12-01" } };
const pool = {
  async query(sql, params) {
    if (/^\s*CREATE/.test(sql)) return { rows: [] };
    if (/WHERE user_id = \$1/.test(sql) && /GROUP BY feature/.test(sql)) return { rows: [{ feature: "subtitles", chars: "70000", uses: "90" }, { feature: "tutor", chars: "10000", uses: "40" }] };
    if (/WHERE user_id = \$1/.test(sql)) return { rows: [{ day: "2026-11-03", chars: "80000", uses: "130" }] };
    if (/GROUP BY feature/.test(sql)) return { rows: [{ feature: "subtitles", chars: "70000", uses: "90", people: "1" }, { feature: "reading", chars: "30000", uses: "400", people: "5" }] };
    if (/JOIN users/.test(sql)) return { rows: [{ id: 2, email: "ana@example.com", plan_status: "exc", chars: "80000", uses: "130", top_feature: "subtitles" }] };
    if (/GROUP BY day/.test(sql)) return { rows: [{ day: "2026-11-03", chars: "100000", uses: "490" }] };
    return { rows: [{ chars: "100000", uses: "490", people: "5" }] };
  },
};
const app = express();
mountUsageAnalytics(app, {
  pool,
  requireAuth: (req, res, next) => { req.userId = Number(req.headers["x-user"]); if (!req.userId) return res.status(401).json({}); next(); },
  getUserById: async (id) => users[id] || null,
});

let fails = 0;
const ok = (name, cond, d = "") => { if (!cond) fails++; console.log((cond ? "pass " : "FAIL ") + name, d); };
const server = app.listen(0, async () => {
  const get = async (path, user) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: user ? { "x-user": String(user) } : {} }); return { status: r.status, data: await r.json() }; };
  let r = await get("/admin-plan/usage", 2);
  ok("other plans can't read the stats", r.status === 403);
  r = await get("/admin-plan/usage", null);
  ok("signed out can't either", r.status === 401);
  r = await get("/admin-plan/usage?days=7", 1);
  ok("the admin plan gets totals, features, people and days", r.status === 200 && r.data.days === 7 && r.data.totals.chars === 100000
    && r.data.byFeature[0].label === "YouTube subtitles" && r.data.people[0].topFeature === "YouTube subtitles" && r.data.daily.length === 1, JSON.stringify(r.data).slice(0, 200));
  r = await get("/admin-plan/usage/user/2", 1);
  ok("one person's stats: plan, allowance and features", r.status === 200 && r.data.user.email === "ana@example.com" && r.data.user.used === 80000 && r.data.user.limit === 1000000 && r.data.byFeature[0].chars === 70000, JSON.stringify(r.data).slice(0, 200));
  r = await get("/admin-plan/usage/user/99", 1);
  ok("someone who doesn't exist is a 404", r.status === 404);
  console.log(fails ? `\n${fails} failed` : "\nall passed");
  server.close();
  process.exitCode = fails ? 1 : 0;
});
