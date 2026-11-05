// Checks premiumPriceId from index.js against fake Stripe accounts, before and after the founding
// offer ends: run with  node scripts/check-premium-price.js
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('const FOUNDING_ENDS =');
const b = src.indexOf('/** "year" when the request asks');
const code = src.slice(a, b);
let fails = 0;
const ok = (name, cond, d = '') => { if (!cond) fails++; console.log((cond ? 'pass ' : 'FAIL ') + name, d); };
const price = (id, cents, interval, created, extra = {}) => ({ id, unit_amount: cents, currency: 'usd', active: true, created, recurring: { interval, interval_count: 1 }, ...extra });
const BEFORE = Date.parse('2026-11-20T12:00:00Z');
const AFTER = Date.parse('2026-11-28T12:00:00Z');

async function run(name, prices, env, interval, expect, now = BEFORE) {
  const stripe = {
    prices: {
      list: () => ({ async *[Symbol.asyncIterator]() { for (const p of prices) yield p; } }),
      retrieve: async (id) => { const p = prices.find((x) => x.id === id); if (!p) throw new Error('no such price'); return p; },
    },
    paymentLinks: { list: () => ({ async *[Symbol.asyncIterator]() {} }), listLineItems: async () => ({ data: [] }) },
  };
  const process = { env };
  const console = { log() {}, warn() {} };
  // the clock the code reads
  const FakeDate = class extends Date { static now() { return now; } };
  FakeDate.parse = Date.parse;
  const premiumPriceId = new Function('stripe', 'process', 'console', 'Date', code + '\nreturn premiumPriceId;')(stripe, process, console, FakeDate);
  let got;
  try { got = await premiumPriceId(interval); } catch (e) { got = 'error: ' + e.message; }
  ok(name, got === expect, `got ${got}`);
}
(async () => {
  const now = price('p799', 799, 'month', 300);
  const old749 = price('old749', 749, 'month', 100);
  const new749 = price('new749', 749, 'month', 400);
  const yearly = price('y5999', 5999, 'year', 410);
  const reg1199 = price('m1199', 1199, 'month', 500);
  const reg8999 = price('y8999', 8999, 'year', 510);
  console.log('Founding offer (before Nov 28)');
  await run('with an old $7.49 and the new $7.49, the newest is used', [old749, now, new749], {}, 'month', 'new749');
  await run('an inactive $7.49 is never used', [price('dead', 749, 'month', 500, { active: false }), now], {}, 'month', 'p799');
  await run('a $7.49 yearly or euro price is not taken for monthly', [price('wrong1', 749, 'year', 500), price('wrong2', 749, 'month', 500, { currency: 'eur' }), now], {}, 'month', 'p799');
  await run('yearly uses the $59.99 yearly price', [now, new749, yearly], {}, 'year', 'y5999');
  await run('the regular $11.99 is not used yet', [new749, reg1199, yearly, reg8999], {}, 'month', 'new749');
  await run('nor the regular $89.99 yearly', [new749, reg1199, yearly, reg8999], {}, 'year', 'y5999');
  await run('STRIPE_PREMIUM_PRICE_ID wins when it matches', [old749, new749], { STRIPE_PREMIUM_PRICE_ID: 'old749' }, 'month', 'old749');
  console.log('After the founding offer ends');
  await run('monthly moves to $11.99', [new749, reg1199, yearly, reg8999], {}, 'month', 'm1199', AFTER);
  await run('yearly moves to $89.99', [new749, reg1199, yearly, reg8999], {}, 'year', 'y8999', AFTER);
  await run('without a $11.99 price yet, checkout keeps $7.49', [new749, yearly], {}, 'month', 'new749', AFTER);
  await run('without a $89.99 price yet, checkout keeps $59.99', [new749, yearly], {}, 'year', 'y5999', AFTER);
  await run('STRIPE_PREMIUM_REGULAR_PRICE_ID wins when it matches', [reg1199, price('m1199b', 1199, 'month', 600)], { STRIPE_PREMIUM_REGULAR_PRICE_ID: 'm1199' }, 'month', 'm1199', AFTER);
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exitCode = fails ? 1 : 0;
})();
