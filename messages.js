// Messages to someone's Hari home page, sent by accounts on the admin plan (plan_status 'active').
// The sender picks people by email (GET /messages/recipients) and sends a short note
// (POST /messages/send). The extension asks for unread notes when the new tab opens
// (GET /messages/inbox), shows each as a popup and marks it read once closed (POST /messages/:id/read).
const express = require("express");

const MAX_TITLE = 80;
const MAX_BODY = 600;
const MAX_RECIPIENTS = 100;

function mountMessages(app, { pool, requireAuth, getUserById }) {
  const jsonBody = express.json({ limit: "32kb" });

  pool
    .query(`CREATE TABLE IF NOT EXISTS home_messages (
      id SERIAL PRIMARY KEY,
      to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ
    )`)
    .then(() => pool.query("CREATE INDEX IF NOT EXISTS home_messages_unread ON home_messages (to_user_id) WHERE read_at IS NULL"))
    .catch((err) => console.error("[messages] table setup failed:", err.message));

  // only the admin plan can see the list of emails or send
  async function requireSender(req, res, next) {
    try {
      const user = await getUserById(req.userId);
      if (!user || user.plan_status !== "active") return res.status(403).json({ error: "not_allowed" });
      req.sender = user;
      next();
    } catch (err) {
      console.error("[messages] sender check failed:", err.message);
      res.status(500).json({ error: "messages_unavailable" });
    }
  }

  app.get("/messages/recipients", requireAuth, requireSender, async (req, res) => {
    try {
      const q = String(req.query.q || "").trim().toLowerCase().slice(0, 100);
      const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
      const r = await pool.query(
        `SELECT id, email, plan_status FROM users
         WHERE email IS NOT NULL AND email <> '' AND ($1 = '' OR LOWER(email) LIKE $2)
         ORDER BY LOWER(email) LIMIT 2000`,
        [q, like]
      );
      res.json({ users: r.rows.map((u) => ({ id: u.id, email: u.email, plan: u.plan_status || "free" })) });
    } catch (err) {
      console.error("[messages] recipients failed:", err.message);
      res.status(500).json({ error: "messages_unavailable" });
    }
  });

  app.post("/messages/send", requireAuth, requireSender, jsonBody, async (req, res) => {
    try {
      const raw = Array.isArray(req.body && req.body.userIds) ? req.body.userIds : [];
      const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      const title = String((req.body && req.body.title) || "").trim().slice(0, MAX_TITLE);
      const body = String((req.body && req.body.body) || "").trim();
      if (!ids.length) return res.status(400).json({ error: "Pick at least one person." });
      if (ids.length > MAX_RECIPIENTS) return res.status(400).json({ error: `Up to ${MAX_RECIPIENTS} people at a time.` });
      if (!body) return res.status(400).json({ error: "Write a message first." });
      if (body.length > MAX_BODY) return res.status(400).json({ error: `Keep it under ${MAX_BODY} characters.` });
      const r = await pool.query(
        `INSERT INTO home_messages (to_user_id, from_user_id, title, body)
         SELECT u.id, $2, $3, $4 FROM users u WHERE u.id = ANY($1::int[])
         RETURNING id`,
        [ids, req.sender.id, title, body]
      );
      console.log(`[messages] user ${req.sender.id} sent a message to ${r.rowCount} people`);
      res.json({ sent: r.rowCount });
    } catch (err) {
      console.error("[messages] send failed:", err.message);
      res.status(500).json({ error: "messages_unavailable" });
    }
  });

  app.get("/messages/inbox", requireAuth, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, title, body, created_at FROM home_messages
         WHERE to_user_id = $1 AND read_at IS NULL ORDER BY created_at ASC LIMIT 10`,
        [req.userId]
      );
      res.json({ messages: r.rows.map((m) => ({ id: m.id, title: m.title, body: m.body, sentAt: m.created_at })) });
    } catch (err) {
      console.error("[messages] inbox failed:", err.message);
      res.status(500).json({ error: "messages_unavailable" });
    }
  });

  app.post("/messages/:id/read", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
    try {
      await pool.query("UPDATE home_messages SET read_at = NOW() WHERE id = $1 AND to_user_id = $2 AND read_at IS NULL", [id, req.userId]);
      res.json({ ok: true });
    } catch (err) {
      console.error("[messages] read failed:", err.message);
      res.status(500).json({ error: "messages_unavailable" });
    }
  });
}

module.exports = { mountMessages };
