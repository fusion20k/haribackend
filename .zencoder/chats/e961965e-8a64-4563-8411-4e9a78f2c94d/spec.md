# Billing Audit — Technical Specification

## Difficulty: **HARD**

Multiple interacting Stripe surfaces (Checkout, Subscriptions, Billing Meters v2, Webhooks), two plans with different semantics (flat premium vs. metered PAYG), a trial flow, plan-switching, and real money on the line. Several concrete bugs and gaps found — at least two are revenue-critical.

---

## Technical Context

- **Runtime**: Node.js / Express
- **Key deps**: `stripe@^20.3.0`, `pg@^8.18.0`, `express@^4.18.2`, `jsonwebtoken`, `bcrypt`
- **Datastore**: Postgres (schema managed in-code via `initDatabase()`)
- **Stripe surfaces in use**:
  - `stripe.customers.create`
  - `stripe.checkout.sessions.create` (mode: subscription)
  - `stripe.subscriptions.create / retrieve / update / cancel`
  - `stripe.billing.meterEvents.create` (v2 meter, `event_name: "translation_chars"`)
  - Webhooks: `checkout.session.completed`, `customer.subscription.created / updated / deleted`
- **Env**: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` (premium), `STRIPE_PAYG_PRICE_ID` (metered), `STRIPE_WEBHOOK_SECRET`

### Plans
| Plan | DB `plan_status` | Char allowance (30d) | Billing model |
|---|---|---|---|
| Free | `free` | 25,000 | none |
| Premium | `pre` | 1,000,000 | flat recurring |
| PAYG | `payg` | 20,000,000 (soft cap, warning only) | metered — `ceil(chars/1000)` units reported per translate/dictionary call |

---

## Audit Findings

### ✅ What's working

1. **Premium checkout → payment lands in Stripe dashboard**: `/billing/create-checkout-session` builds a proper `mode: subscription` Checkout with `STRIPE_PRICE_ID`, customer attached, `userId` in both session and subscription metadata. Webhook `checkout.session.completed` + `customer.subscription.created` activate the user (idempotent via guards in `updateUserPlanStatus` / `activatePaygPlan`). Stripe collects payment and records it normally.
2. **Webhook signature verification** uses raw body middleware mounted before `express.json()` — correct order (`index.js:144` before `index.js:325`).
3. **Idempotency guards** in `updateUserPlanStatus('pre', …)` and `activatePaygPlan` (`db.js:689`, `db.js:830`) prevent duplicate-webhook double activation.
4. **Plan upgrade path** (`checkout.session.completed`): on active upgrade, it cancels the previous subscription to avoid double-charging (`index.js:203-210`).
5. **Meter event shape** (`index.js:1572-1578`, `:1721-1727`) matches Stripe Billing Meter v2 expected payload: `event_name`, `payload.value` (string), `payload.stripe_customer_id`.
6. **Cache-hit billing for PAYG** is included (`billableChars = cacheChars + liveChars`, `index.js:1562`) — assuming the business intent is "user pays per char translated regardless of upstream cache state." Flag for product confirmation.

---

### 🔴 CRITICAL bugs (revenue impact)

#### B1. PAYG cancellation does not invoice accrued metered usage
**File**: `index.js:1125` (`handleCancelSubscription`), `index.js:1041` (switch-plan), `index.js:205` (webhook upgrade path).

`stripe.subscriptions.cancel(subscriptionId)` is called with **no options**. For metered subscriptions, Stripe does not automatically invoice un-invoiced meter events for the current period on cancellation. Usage reported since the last period start is silently lost from billing.

The user's exact example ("user cancels mid-cycle but already used some PAYG characters — they should still be billed") is currently **not handled**.

**Fix**: When the subscription being canceled is PAYG, use:
```js
await stripe.subscriptions.cancel(subscriptionId, {
  invoice_now: true,
  prorate: true,
});
```
Only pass these options on PAYG subs (premium is flat-rate; `prorate: true` would also work but is policy-dependent).

Detection: before cancelling, `stripe.subscriptions.retrieve(subId)` and check if any item price === `STRIPE_PAYG_PRICE_ID`.

Applies at **three call-sites**:
- `handleCancelSubscription` (`index.js:1125`)
- `/billing/switch-plan` (`index.js:1041`, `:1049`)
- webhook PAYG upgrade path (`index.js:205`)

#### B2. Meter events are fire-and-forget via `setImmediate`
**File**: `index.js:1570-1584`, `:1719-1732`.

After incrementing the user's char counter in the DB and sending the HTTP response, meter events are dispatched via `setImmediate(async () => { await stripe.billing.meterEvents.create(...) })`. Failures are only logged. If the call fails (network, rate limit, deploy shutdown) the user was served + DB-charged but Stripe never records the usage → **lost revenue on PAYG**.

**Fix options**:
- **Minimum**: remove `setImmediate` and `await` the meter call inline before responding. Accept ~100ms latency hit.
- **Better**: a lightweight retry queue — on failure, write the failed event into a new `payg_meter_events_pending` table with `(user_id, stripe_customer_id, units, created_at, attempts)`, and flush on a short interval / before cancel.
- Also: before process exit (SIGTERM), drain the retry queue.

For this audit, propose **Option 1 (inline await)** for `/translate` and `/dictionary` — simpler and sufficient given Stripe meter endpoint is fast and accepts batched values.

---

### 🟠 HIGH-severity issues

#### B3. `updateSubscription` has no upsert — out-of-order webhooks silently lost
**File**: `db.js:591-607`. `customer.subscription.updated` may arrive before `customer.subscription.created` (rare but possible). `updateSubscription` does a plain UPDATE — if no row exists, `subRow = getSubscriptionByStripeId` on `index.js:261` returns `null` and the entire status-transition block is skipped. User can end up stuck in stale state.

**Fix**: change `updateSubscription` to INSERT ... ON CONFLICT ... DO UPDATE (needs `user_id`, which must be pulled from `subscription.metadata.userId`), OR fall back to `createSubscription` when `updateSubscription` returns null AND metadata carries `userId`.

#### B4. Stripe API version drift — `subscription.current_period_end` may be undefined
**File**: `index.js:183, 229, 257, 933`; `db.js:567-605`.

Starting with Stripe API version `2025-03-31.basil`, `current_period_end` moved from `Subscription` to `Subscription.items.data[0]`. Stripe Node SDK `^20.3.0` still pins to an older API version by default, so this works **today**, but the code will break silently the moment the account is upgraded or the SDK is bumped. `new Date(undefined * 1000)` → `Invalid Date` and DB insert fails or stores `NULL`.

**Fix**: centralize a helper:
```js
function getPeriodEnd(subscription) {
  const ts = subscription.current_period_end
    ?? subscription.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000) : null;
}
```
Replace all six call-sites.

#### B5. `/start-trial` sets `plan_status = 'free'` during a premium trial
**File**: `db.js:627-649` (`updateUserTrialStart`). User is on a Stripe premium trialing subscription but DB says `'free'` → `/translate` applies the **25,000-char free limit**, not a generous trial. Almost certainly not what the product intends. Either:
- set `plan_status = 'trialing'` and update `/translate` / `/dictionary` quota logic to handle it, OR
- bump `trial_chars_limit` to a trial-appropriate value at trial start.

Also note: `initDatabase()` contains a migration that rewrites any `plan_status = 'trialing'` to `'free'` (`db.js:226-232`). Need to remove or scope that before re-introducing the `'trialing'` state.

#### B6. PAYG local cycle ≠ Stripe billing cycle
**File**: `db.js:779-813` (`resetUserCharsIfNeeded` uses `free_chars_reset_date`, a DB-side 30-day clock). Stripe's billing cycle for the PAYG subscription is independent. Consequences:
- The user-facing `payg_chars_used` in `/me` can desync from what Stripe actually invoices.
- Cosmetic for billing accuracy (Stripe is the source of truth), but confusing for support.

**Fix**: derive `payg_chars_used` for display from `stripe.billing.meters.*` reads or store `current_period_start` from the webhook and reset local counters when it changes. Minimum: document this as display-only.

---

### 🟡 MEDIUM-severity issues

#### B7. `/billing/cancel-subscription` on PAYG wipes `trial_chars_used` before final invoice
**File**: `db.js:717-743`. `cancelUserSubscription` resets `trial_chars_used = 0, chars_used_at_payg_start = 0`. If B1 is fixed and Stripe invoices `invoice_now: true`, this is harmless (Stripe has its own ledger). But today, combined with B1, it erases the only local record of what the user used. After the fix to B1, keep the reset.

#### B8. `switch-plan` cancels old sub without invoicing PAYG usage
Same root cause as B1 — applies to `/billing/switch-plan` (`index.js:1041`, `:1049`). If switching PAYG → premium, the partial PAYG usage for the current period is thrown away.

#### B9. No handler for `invoice.payment_failed` / `invoice.paid` / `customer.subscription.trial_will_end`
- `invoice.payment_failed` → premium user with declined card keeps `plan_status='pre'` until Stripe eventually transitions the subscription to `past_due` / `unpaid` / `canceled` (which is caught by `customer.subscription.updated`). Gap is small in practice but worth adding a dunning indicator.
- No notification hooks for trial expiry.

#### B10. `trial_chars_limit` idempotency hole on premium re-subscribe
**File**: `db.js:679-695` — when a user re-subscribes to premium after canceling, `updateUserPlanStatus('pre', …)` sets `trial_chars_limit = 1_000_000` and `free_chars_reset_date = now + 30d`, **regardless** of whether the existing 30-day clock had not expired. Low-severity.

#### B11. `verify-session` duplicates webhook work without confirming webhook idempotency
**File**: `index.js:899-972`. Fine because the DB-level idempotency guards (`activatePaygPlan`, `updateUserPlanStatus`) absorb duplicates. Leaving as-is.

---

### 🟢 LOW-severity / polish

- `/usage` is unauthenticated (`index.js:1186`) — leaks global quota status. Minor.
- `clickRateLimiter` is an unbounded in-process `Map` (`index.js:1766`) — memory leak across uptime. Not billing-related.
- `admin_pool` + default `pool` both open against the same DB; intentional but wasteful.

---

## Fixes — Source Code Changes (precise)

### F1. Smart PAYG-aware cancellation helper (fixes B1, B8)
**New helper in `index.js`** (near `handleCancelSubscription`):
```js
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
```
Replace every `stripe.subscriptions.cancel(id)` call:
- `index.js:205` (webhook upgrade)
- `index.js:1041`, `index.js:1049` (switch-plan)
- `index.js:1125` (cancel endpoint — preserve the existing "already gone" handling)

### F2. Inline-await meter events (fixes B2)
In `/translate` (`index.js:1570`) and `/dictionary` (`index.js:1719`), remove `setImmediate` wrappers; `await` the meter call before `res.json(...)`. On error, log and still respond 200 (don't fail the user's request) but record to a simple retry table.

Minimum change:
```js
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
    console.log(`[payg] billed user=${req.userId} units=${charsToReport}`);
  } catch (e) {
    console.error("PAYG meter failed:", e.message);
    // optional: enqueue retry row
  }
}
```

### F3. Upsert for `updateSubscription` (fixes B3)
In `db.js:591-607`, rewrite as:
```js
async function updateSubscription(stripeSubscriptionId, status, currentPeriodEnd, userId = null) {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `UPDATE subscriptions
       SET status = $1, current_period_end = $2, updated_at = CURRENT_TIMESTAMP
       WHERE stripe_subscription_id = $3
       RETURNING *`,
      [status, currentPeriodEnd, stripeSubscriptionId]
    );
    if (r.rowCount > 0) return r.rows[0];
    if (userId) {
      return await createSubscription(userId, stripeSubscriptionId, status, currentPeriodEnd);
    }
    return null;
  } finally { client.release(); }
}
```
Caller at `index.js:254`: pass `subscription.metadata?.userId` when available.

### F4. Period-end helper (fixes B4)
Add to `index.js` top-level:
```js
function getPeriodEnd(sub) {
  const ts = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000) : null;
}
```
Replace `new Date(subscription.current_period_end * 1000)` at `index.js:183, 229, 257, 933` with `getPeriodEnd(subscription)`.
Drop `new Date(subscription.current_period_end * 1000)` in `verify-session` (`index.js:933`) likewise.

### F5. Trial state (fixes B5)
Two-line change:
- `db.js:634`: change `plan_status = 'free'` → `plan_status = 'trialing'`.
- Remove the migration block `db.js:226-232` that collapses `trialing` → `free`.
- `index.js:787, :1273, :1601, :1673, :1749`: include `'trialing'` alongside `'free'/'pre'` in char-limit enforcement OR treat it like `'pre'` (1M chars). Recommended: treat like `'pre'` during trial — set `trial_chars_limit = 1_000_000` in `updateUserTrialStart`.

### F6. Documentation of PAYG display metric (B6)
Add a short comment near `/me`'s PAYG branch (`index.js:808`) noting local counters are display-only and Stripe is source of truth. Optional follow-up: persist `current_period_start` and reset local counters on rollover.

---

## Source-Code Structure Changes

- **Modified**: `index.js` (helpers, webhook handlers, cancel flow, meter calls)
- **Modified**: `db.js` (`updateSubscription` upsert, `updateUserTrialStart` state change, migration removal, optional `trial_chars_limit` bump)
- **New (optional for F2)**: `payg_meter_events_pending` table added via migration inside `initDatabase()`
- **No** new top-level files required.

---

## Data Model / API / Interface Changes

### DB
- `users.plan_status` now accepts `'trialing'` in addition to `'free' | 'pre' | 'payg' | 'canceled'`. All queries currently filter by specific values — audit call sites:
  - `index.js:453-456` (admin overview counts)
  - `index.js:487` (`validPlans`)
  - `index.js:704, :831, :866, :985, :1034` (gating)
  - `index.js:787, :1210, :1273, :1601, :1658, :1673, :1749` (quota)
- Optional new table `payg_meter_events_pending(id, stripe_customer_id, units, attempts, created_at)` for retry queue.

### HTTP API
- No breaking changes to request/response shapes.
- `/me` response `plan_status` may now return `'trialing'` — clients must not assume an enum subset.

### External (Stripe)
- No new webhook subscriptions required for the critical fixes.
- Recommended (non-blocking): subscribe to `invoice.payment_failed` later (B9).

---

## Verification Approach

No test framework is configured in `package.json`. Propose **manual + scripted** verification:

1. **Static**: `node -c index.js` / `node -c db.js` to syntax-check after edits. (Project has no lint.)
2. **Local smoke with Stripe CLI**:
   ```
   stripe listen --forward-to localhost:10000/stripe/webhook
   stripe trigger checkout.session.completed
   stripe trigger customer.subscription.updated
   ```
3. **End-to-end scenarios** (Stripe test mode):
   - **S1 Premium happy path**: signup → `/billing/create-checkout-session` → pay with `4242 4242 4242 4242` → verify user is `plan_status='pre'`, `has_access=true`, Stripe dashboard shows a paid invoice.
   - **S2 PAYG happy path**: signup → `/billing/create-payg-checkout-session` → complete → call `/translate` N times → verify `stripe.billing.meter_events` lists the events → wait for cycle or force `invoice_now` cancel → verify invoice amount matches `ceil(sum(chars)/1000) * unit_price`.
   - **S3 PAYG mid-cycle cancel (the critical scenario)**: start PAYG → translate 50k chars → call `/billing/cancel-subscription` → verify Stripe dashboard shows a final invoice with ~50 meter units billed. **Must pass after B1 fix.**
   - **S4 Plan switch PAYG → Premium**: start PAYG → translate 10k chars → `/billing/switch-plan` targetPlan='pre' → verify prior PAYG usage produced a final invoice AND new premium subscription is active.
   - **S5 Out-of-order webhook**: use Stripe CLI `stripe events resend` to deliver `customer.subscription.updated` before `.created` — verify subscription row is created and user state transitions.
   - **S6 Trial flow**: `/start-trial` with payment_method → verify `plan_status='trialing'`, allowance ~1M chars, trial end webhook transitions to `'pre'`.
   - **S7 Webhook duplicate delivery**: replay `checkout.session.completed` twice — verify no duplicate `subscription` rows, no double `activatePaygPlan` invocation effect.
4. **DB diff check**: dump `users`, `subscriptions` before/after each scenario; assert only expected columns changed.
5. **Stripe reconciliation**: After S2/S3/S4, confirm `stripe.invoices.list({customer: ..., status:'paid'})` matches expected totals.

---

## Summary of recommended work (for Step 2 planning)

Two critical revenue-loss bugs (B1, B2) must ship together. Three high-severity correctness fixes (B3, B4, B5). One medium (B8) piggy-backs on B1. The remainder are polish / post-launch.
