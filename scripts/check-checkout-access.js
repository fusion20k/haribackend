// Runs the real Stripe webhook and verify-session code from index.js against a fake Stripe and an
// in-memory copy of the users / subscriptions tables, and checks what each checkout unlocks:
//   node scripts/check-checkout-access.js
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
const slice = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('index.js changed, cannot find: ' + from);
  return src.slice(a, b);
};

const PAYG = 'price_payg';
const MONTH = { id: 'price_m749', unit_amount: 749, recurring: { interval: 'month' } };
const YEAR = { id: 'price_y5999', unit_amount: 5999, recurring: { interval: 'year' } };
const PAYG_PRICE = { id: PAYG, recurring: { interval: 'month', usage_type: 'metered' } };
const FREE_PLAN_LIMIT = 50000;
const PREMIUM_PLANS = ['pre', 'payg', 'active']; // premium.js requirePremium

// ---- in-memory tables, following the SQL in db.js ----
let users, subs, stripeSubs, events, seq;
function reset() {
  users = new Map();
  subs = new Map();
  stripeSubs = new Map();
  events = [];
  seq = 0;
}
const db = {
  async getUserById(id) { const u = users.get(id); return u ? { ...u } : null; },
  async getUserByEmail(email) { return [...users.values()].find((u) => u.email === email) || null; },
  async createSubscription(userId, sid, status, end) {
    const row = subs.get(sid) || { user_id: userId, stripe_subscription_id: sid };
    subs.set(sid, { ...row, status, current_period_end: end });
  },
  async updateSubscription(sid, status, end, userId = null) {
    if (subs.has(sid)) return subs.set(sid, { ...subs.get(sid), status, current_period_end: end });
    if (userId) return db.createSubscription(userId, sid, status, end);
    return null;
  },
  async getSubscriptionByStripeId(sid) { return subs.get(sid) || null; },
  async getLatestSubscriptionForUser(uid) { return [...subs.values()].filter((s) => s.user_id === uid).pop() || null; },
  async updateUserPlanStatus(id, plan, hasAccess, at, sid) {
    const u = users.get(id);
    if (plan === 'pre' && u.plan_status === 'pre' && u.subscription_id === (sid || u.subscription_id)) return null; // idempotency guard
    Object.assign(u, { plan_status: plan, has_access: hasAccess, subscription_id: sid || u.subscription_id, trial_chars_limit: 1000000, chars_used_at_payg_start: u.trial_chars_used });
    return u;
  },
  async activatePaygPlan(id, sid, item) {
    const u = users.get(id);
    if (u.plan_status === 'payg' && u.subscription_id === sid) return null;
    Object.assign(u, { plan_status: 'payg', has_access: true, chars_used_at_payg_start: u.trial_chars_used, trial_chars_limit: 20000000, subscription_id: sid, stripe_item_id: item });
    return u;
  },
  async cancelUserSubscription(id) {
    Object.assign(users.get(id), { plan_status: 'free', has_access: true, trial_chars_limit: FREE_PLAN_LIMIT, trial_chars_used: 0, chars_used_at_payg_start: 0, subscription_id: null, stripe_item_id: null });
  },
  async updateUserTrialStart(id, sid) { Object.assign(users.get(id), { plan_status: 'free', subscription_id: sid, has_access: true }); },
  async setSubscriptionAffiliate() {},
  async sendResendEmail() {},
};

// ---- fake Stripe: cancelling a subscription queues the webhooks Stripe would send for it ----
const stripe = {
  subscriptions: {
    async retrieve(id) { const s = stripeSubs.get(id); if (!s) throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' }); return JSON.parse(JSON.stringify(s)); },
    async cancel(id) {
      const s = stripeSubs.get(id);
      if (!s) throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
      s.status = 'canceled';
      events.push({ type: 'customer.subscription.updated', data: { object: JSON.parse(JSON.stringify(s)), previous_attributes: { status: 'active' } } });
      events.push({ type: 'customer.subscription.deleted', data: { object: JSON.parse(JSON.stringify(s)) } });
    },
  },
  checkout: { sessions: { async retrieve(id, opts) {
    const sess = sessions.get(id);
    const out = JSON.parse(JSON.stringify(sess));
    if (opts && opts.expand && opts.expand.includes('subscription')) out.subscription = await stripe.subscriptions.retrieve(sess.subscription);
    return out;
  } } },
};
const sessions = new Map();

const env = { STRIPE_PAYG_PRICE_ID: PAYG };
const quiet = { log() {}, warn() {}, error: (...a) => console.error('  [index.js]', ...a) };
const scope = { stripe, process: { env }, console: quiet, PAYG_PRICE_ID: PAYG, FREE_PLAN_LIMIT, ...db };
const names = Object.keys(scope);
const build = (code, ret) => new Function(...names, code + '\nreturn ' + ret + ';')(...names.map((n) => scope[n]));

const helpers = slice('function getPeriodEnd(sub) {', '// --- Auth hardening helpers ---')
  + slice('async function cancelStripeSubscriptionWithFinalUsage(subscriptionId) {', 'async function azureTranslate(')
  + slice('/** After a switch completes: cancel the subscription the checkout replaced', 'const sendBillingError =')
  + slice('async function userHasActiveSubscription(userId) {', '// --- Partner referral endpoints ---');
const webhookBody = slice('    switch (event.type) {', '    res.json({ received: true });');
const handleEvent = build(helpers + '\nasync function handleEvent(event) {\n' + webhookBody + '\n}', 'handleEvent');
const verifyBody = slice('    const session = await stripe.checkout.sessions.retrieve(session_id, {', '    const updatedUser = await getUserById(req.userId);');
const verify = build(helpers + '\nasync function verify(req, res, session_id) {\n' + verifyBody + '\n}', 'verify');
const userHasActiveSubscription = build(helpers, 'userHasActiveSubscription');
// premium.js: Premium endpoints let in pre / payg / active, and PAYG also needs a Stripe customer
const premiumGate = (u) => PREMIUM_PLANS.includes(u.plan_status) && !(u.plan_status === 'payg' && !u.stripe_customer_id);

// ---- a checkout: Stripe creates the subscription, then sends its webhooks (and the extension may verify first) ----
async function checkout(userId, price, { replaces = null, verifyFirst = false } = {}) {
  const sid = 'sub_' + ++seq;
  const meta = { userId: String(userId), ...(replaces ? { replaces } : {}) };
  const sub = { id: sid, status: 'active', metadata: meta, current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30, items: { data: [{ id: 'si_' + seq, price }] } };
  stripeSubs.set(sid, sub);
  const sess = { id: 'cs_' + seq, metadata: meta, client_reference_id: String(userId), subscription: sid, customer: 'cus_' + userId, payment_status: 'paid', status: 'complete' };
  sessions.set(sess.id, sess);
  const res = { status() { return res; }, json() {} };
  if (verifyFirst) await verify({ userId, body: { session_id: sess.id } }, res, sess.id);
  events.push({ type: 'customer.subscription.created', data: { object: JSON.parse(JSON.stringify(sub)) } });
  events.push({ type: 'checkout.session.completed', data: { object: sess } });
  while (events.length) await handleEvent(events.shift()); // includes the cancellation webhooks a switch causes
  return sid;
}

let fails = 0;
const ok = (name, cond, d = '') => { if (!cond) fails++; console.log((cond ? 'pass ' : 'FAIL ') + name, d); };
async function expectPlan(label, id, plan, limit, sid) {
  const u = users.get(id);
  const access = await userHasActiveSubscription(id);
  ok(`${label}: ${plan}, ${limit.toLocaleString()} chars, Premium tools ${plan === 'free' ? 'locked' : 'open'}`,
    u.plan_status === plan && u.trial_chars_limit === limit && access === true && premiumGate(u) === (plan !== 'free') && (sid === undefined || u.subscription_id === sid),
    JSON.stringify({ plan: u.plan_status, limit: u.trial_chars_limit, access, gate: premiumGate(u), sub: u.subscription_id }));
}
const newUser = (id) => users.set(id, { id, email: `u${id}@x.test`, plan_status: 'free', has_access: true, trial_chars_used: 1200, trial_chars_limit: FREE_PLAN_LIMIT, subscription_id: null, stripe_customer_id: 'cus_' + id });

(async () => {
  for (const verifyFirst of [false, true]) {
    console.log(verifyFirst ? '\n-- extension verifies the session before the webhooks land --' : '-- webhooks only --');
    reset();
    newUser(1); newUser(2); newUser(3);
    const m = await checkout(1, MONTH, { verifyFirst });
    await expectPlan('Free -> Premium monthly', 1, 'pre', 1000000, m);
    const y = await checkout(2, YEAR, { verifyFirst });
    await expectPlan('Free -> Premium yearly', 2, 'pre', 1000000, y);
    const p = await checkout(3, PAYG_PRICE, { verifyFirst });
    await expectPlan('Free -> PAYG', 3, 'payg', 20000000, p);

    const y1 = await checkout(1, YEAR, { replaces: m, verifyFirst });
    await expectPlan('Premium monthly -> yearly', 1, 'pre', 1000000, y1);
    ok('  the monthly subscription is cancelled in Stripe', stripeSubs.get(m).status === 'canceled');

    const p2 = await checkout(2, PAYG_PRICE, { replaces: y, verifyFirst });
    await expectPlan('Premium yearly -> PAYG', 2, 'payg', 20000000, p2);
    ok('  the yearly subscription is cancelled in Stripe', stripeSubs.get(y).status === 'canceled');

    const m3 = await checkout(3, MONTH, { replaces: p, verifyFirst });
    await expectPlan('PAYG -> Premium monthly', 3, 'pre', 1000000, m3);
    ok('  the PAYG subscription is cancelled in Stripe', stripeSubs.get(p).status === 'canceled');

    // cancelling the current plan drops back to free (the deleted webhook)
    await stripe.subscriptions.cancel(m3);
    while (events.length) await handleEvent(events.shift());
    await expectPlan('Premium cancelled -> Free', 3, 'free', 50000, null);
  }
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exitCode = fails ? 1 : 0;
})();
