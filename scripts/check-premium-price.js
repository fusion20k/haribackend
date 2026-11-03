// Checks premiumPriceId from index.js against fake Stripe accounts: run with  node scripts/check-premium-price.js
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('const PREMIUM_PRICES = {');
const b = src.indexOf('/** "year" when the request asks');
const code = src.slice(a, b);
const ok = (name, cond, d = '') => console.log((cond ? 'pass ' : 'FAIL ') + name, d);
const price = (id, cents, interval, created, extra = {}) => ({ id, unit_amount: cents, currency: 'usd', active: true, created, recurring: { interval, interval_count: 1 }, ...extra });
async function run(name, prices, env, interval, expect) {
  const stripe = {
    prices: {
      list: () => ({ async *[Symbol.asyncIterator]() { for (const p of prices) yield p; } }),
      retrieve: async (id) => { const p = prices.find((x) => x.id === id); if (!p) throw new Error('no such price'); return p; },
    },
    paymentLinks: { list: () => ({ async *[Symbol.asyncIterator]() {} }), listLineItems: async () => ({ data: [] }) },
  };
  const process = { env };
  const console = { log() {}, warn() {} };
  const premiumPriceId = new Function('stripe', 'process', 'console', code + '\nreturn premiumPriceId;')(stripe, process, console);
  let got;
  try { got = await premiumPriceId(interval); } catch (e) { got = 'error: ' + e.message; }
  ok(name, got === expect, `got ${got}`);
}
(async () => {
  const now = price('p799', 799, 'month', 300);
  const old749 = price('old749', 749, 'month', 100);
  const new749 = price('new749', 749, 'month', 400);
  const yearly = price('y5999', 5999, 'year', 410);
  await run('before the Stripe change, monthly keeps the current $7.99', [now, price('p1999', 1999, 'month', 200)], {}, 'month', 'p799');
  await run('with an old $7.49 and the new $7.49, the newest is used', [old749, now, new749], {}, 'month', 'new749');
  await run('an inactive $7.49 is never used', [price('dead', 749, 'month', 500, { active: false }), now], {}, 'month', 'p799');
  await run('a $7.49 yearly or euro price is not taken for monthly', [price('wrong1', 749, 'year', 500), price('wrong2', 749, 'month', 500, { currency: 'eur' }), now], {}, 'month', 'p799');
  await run('yearly uses the $59.99 yearly price', [now, new749, yearly], {}, 'year', 'y5999');
  await run('yearly without a $59.99 price says so (no fallback)', [now, new749], {}, 'year', 'error: Premium price ($59.99 a year) not found in Stripe');
  await run('STRIPE_PREMIUM_PRICE_ID wins when it matches', [old749, new749], { STRIPE_PREMIUM_PRICE_ID: 'old749' }, 'month', 'old749');
  await run('a STRIPE_PREMIUM_PRICE_ID that does not match is ignored', [now, new749], { STRIPE_PREMIUM_PRICE_ID: 'p799' }, 'month', 'new749');
})();
