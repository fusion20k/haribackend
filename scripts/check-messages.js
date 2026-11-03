// Checks messages.js on a real Express server with an in-memory stand-in for the database:
//   node scripts/check-messages.js
const express = require("express");
const { mountMessages } = require("../messages");

const users = [
  { id: 1, email: "admin@hari.test", plan_status: "active" },
  { id: 2, email: "ana@example.com", plan_status: "free" },
  { id: 3, email: "ben@example.com", plan_status: "pre" },
];
const messages = [];

// answers the handful of queries messages.js makes
const pool = {
  async query(sql, params = []) {
    if (/^CREATE/.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM users") && sql.includes("ORDER BY LOWER(email)")) {
      const [q] = params;
      const rows = users.filter((u) => !q || u.email.toLowerCase().includes(q)).sort((a, b) => a.email.localeCompare(b.email));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("INSERT INTO home_messages")) {
      const [ids, from, title, body] = params;
      const rows = users.filter((u) => ids.includes(u.id)).map((u) => {
        const m = { id: messages.length + 1, to_user_id: u.id, from_user_id: from, title, body, created_at: new Date(), read_at: null };
        messages.push(m);
        return { id: m.id };
      });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM home_messages")) {
      const rows = messages.filter((m) => m.to_user_id === params[0] && !m.read_at);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("UPDATE home_messages")) {
      const m = messages.find((x) => x.id === params[0] && x.to_user_id === params[1] && !x.read_at);
      if (m) m.read_at = new Date();
      return { rows: [], rowCount: m ? 1 : 0 };
    }
    throw new Error("unexpected query: " + sql);
  },
};

const requireAuth = (req, res, next) => {
  const id = Number(req.headers["x-user"]);
  if (!id) return res.status(401).json({ error: "Missing token" });
  req.userId = id;
  next();
};
const getUserById = async (id) => users.find((u) => u.id === id) || null;

let fails = 0;
const ok = (name, cond, d = "") => { if (!cond) fails++; console.log((cond ? "pass " : "FAIL ") + name, d); };

const app = express();
mountMessages(app, { pool, requireAuth, getUserById });
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, user, body) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { ...(user ? { "x-user": String(user) } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    let r = await call("/messages/recipients", 1);
    ok("the admin plan sees every email, sorted", r.status === 200 && r.data.users.map((u) => u.email).join() === "admin@hari.test,ana@example.com,ben@example.com", JSON.stringify(r.data));
    r = await call("/messages/recipients?q=BEN", 1);
    ok("search narrows the list (any case)", r.data.users.length === 1 && r.data.users[0].email === "ben@example.com");
    r = await call("/messages/recipients", 2);
    ok("a free account can't see the list", r.status === 403);
    r = await call("/messages/recipients", 3);
    ok("a Premium account can't see the list", r.status === 403);
    r = await call("/messages/recipients", null);
    ok("signed out can't see the list", r.status === 401);

    r = await call("/messages/send", 2, { userIds: [3], body: "hi" });
    ok("only the admin plan can send", r.status === 403 && messages.length === 0);
    r = await call("/messages/send", 1, { userIds: [], body: "hi" });
    ok("sending needs someone picked", r.status === 400);
    r = await call("/messages/send", 1, { userIds: [2], body: "   " });
    ok("sending needs a message", r.status === 400);
    r = await call("/messages/send", 1, { userIds: [2], body: "x".repeat(601) });
    ok("messages over 600 characters are turned away", r.status === 400);
    r = await call("/messages/send", 1, { userIds: [2, 3, 3, "x", 99], title: "Kumusta!", body: "Salamat for trying Hari." });
    ok("sends once to each real person picked", r.status === 200 && r.data.sent === 2, JSON.stringify(r.data));

    r = await call("/messages/inbox", 2);
    ok("the person gets it in their inbox", r.data.messages.length === 1 && r.data.messages[0].title === "Kumusta!" && r.data.messages[0].body === "Salamat for trying Hari.");
    const id = r.data.messages[0].id;
    r = await call(`/messages/${id}/read`, 3, {});
    r = await call("/messages/inbox", 2);
    ok("someone else can't mark it read", r.data.messages.length === 1);
    await call(`/messages/${id}/read`, 2, {});
    r = await call("/messages/inbox", 2);
    ok("once read, it doesn't come back", r.data.messages.length === 0);
  } catch (err) {
    fails++;
    console.log("FAIL", err);
  }
  console.log(fails ? `\n${fails} failed` : "\nall passed");
  server.close();
  process.exitCode = fails ? 1 : 0;
});
