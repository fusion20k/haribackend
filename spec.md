# Bug Spec: `pre` User Stuck After Hitting 1M Char Limit — Plan Switch Not Taking Effect

## Symptom

A user on the `pre` (premium) plan hits the 1,000,000 character limit. They try to switch to PAYG via the frontend (`/billing/switch-plan`) and/or by directly editing `plan_status` in Supabase. Neither action persists — the account remains on `pre`.

---

## Root Causes (in order of likelihood)

### Root Cause 1 — Stripe webhooks revert manual Supabase edits (**PRIMARY**)

`updateUserPlanStatus` in `db.js` (line 774) has an idempotency guard that only fires when the user is **already** on `pre` with the **same** `subscription_id`:

```sql
AND NOT (plan_status = 'pre' AND subscription_id = COALESCE($5, subscription_id))
```

It does **not** guard against overwriting `payg` or `free` with `pre`.

**What happens:**
1. User manually sets `plan_status = 'payg'` in Supabase.
2. The old `pre` Stripe subscription is still active (never canceled).
3. Stripe re-delivers or fires a delayed `customer.subscription.updated` or `customer.subscription.created` event with `status = "active"` for that subscription.
4. The webhook handler calls `updateUserPlanStatus(userId, "pre", ...)`.
5. The guard does not fire (user is now on `payg`, not `pre`).
6. `plan_status` is overwritten back to `pre`.

This is why **manual Supabase edits don't persist**.

---

### Root Cause 2 — `/billing/switch-plan` relies 100% on webhooks; no DB update on the server

The `/billing/switch-plan` endpoint (index.js line 1049):
1. Calls `cancelStripeSubscriptionWithFinalUsage` on the old `pre` subscription.
2. Creates a new Stripe Checkout session for PAYG.
3. Returns `{ checkoutUrl }` — **it does not update the DB itself**.

Updating the DB to `free` (cancellation) and `payg` (new plan) both depend on webhook delivery. If the backend is asleep (Render free tier cold-start), the webhook URL is wrong, or Stripe simply doesn't reach the server, **nothing changes in the DB**. The user remains on `pre` indefinitely.

If the user then looks at `/me`, they still see `pre`. The switch "didn't work."

---

### Root Cause 3 — `create-payg-checkout-session` blocks `pre` users with a 400

`/billing/create-payg-checkout-session` (index.js line 1009):

```js
if (["pre", "active", "payg"].includes(user.plan_status)) {
  return res.status(400).json({ error: "Already on a paid plan. Use switch-plan to change." });
}
```

If the frontend upgrade flow calls this endpoint instead of `/billing/switch-plan`, the request is rejected. The UI likely interprets the error silently, and the user sees the plan as unchanged.

---

### Root Cause 4 — `activatePaygPlan` guard does not prevent `pre` Stripe event from overwriting PAYG state

The guard in `activatePaygPlan` (db.js line 932):
```sql
AND NOT (plan_status = 'payg' AND subscription_id = $1)
```
This correctly prevents duplicate PAYG activation for the same subscription. But it is irrelevant to the `pre` re-activation problem — that comes from `updateUserPlanStatus`, not `activatePaygPlan`.

---

## Secondary / Edge Cases

| Case | Description |
|------|-------------|
| `STRIPE_PAYG_PRICE_ID` not set | In the webhook handler, `isPayg` uses `process.env.STRIPE_PAYG_PRICE_ID` with no fallback (unlike `verify-session` which has a hardcoded fallback). If the env var is missing or wrong, the PAYG checkout is treated as a `pre` subscription and `updateUserPlanStatus(userId, "pre", ...)` is called — user goes back to `pre` even after paying for PAYG. |
| Manual edit misses required fields | Setting only `plan_status = 'payg'` leaves `trial_chars_limit = 1000000`, `stripe_item_id = NULL`, `chars_used_at_payg_start` uncaptured. The translate endpoint for `payg` bypasses quota checks, so the user CAN translate — but meter events will fail if there's no active PAYG subscription in Stripe. |
| `subscription_id` still points to old `pre` sub | After manual edit, if the old `pre` Stripe subscription was never canceled, Stripe keeps firing events for it (renewals, billing updates, invoice events). Each event can trigger a `customer.subscription.updated` webhook that resets the plan to `pre`. |
| Webhook race: old sub deleted AFTER new PAYG activated | The `customer.subscription.deleted` handler checks `currentUser.subscription_id === subscription.id` before calling `cancelUserSubscription`. Since `activatePaygPlan` already updated `subscription_id` to the new PAYG subscription ID, this guard correctly prevents the downgrade. **This specific race condition is handled.** |
| JWT stale plan claim | JWT payload only contains `userId`, not plan state. The `/me` endpoint always fetches fresh from DB. **No JWT staleness issue.** |
| No server-side caching | `/me` and all billing endpoints call `getUserById` on every request. **No server-side cache issue.** |

---

## How `trial_chars_limit` Differs Per Plan

| Plan | `trial_chars_limit` | Quota enforced? |
|------|---------------------|-----------------|
| `free` | 25,000 | Yes — `atomicCheckAndIncrementChars` |
| `pre` | 1,000,000 | Yes — `atomicCheckAndIncrementChars` |
| `payg` | 20,000,000 (soft) | **No** — metered billing only, no atomic quota check |

`activatePaygPlan` sets `trial_chars_limit = 20000000`. After PAYG activation, translate/dictionary/tts endpoints skip the quota gate and go directly to Stripe meter events.

---

## Does Any 402-returning Translation Endpoint Block Plan Endpoints?

No. `/billing/switch-plan`, `/billing/create-payg-checkout-session`, `/billing/verify-session`, and `/me` do not call `atomicCheckAndIncrementChars`. A user who is over-quota but otherwise authenticated can still access all billing endpoints. The 402 from translation does not block the upgrade path.

---

## Immediate DB Fix (to unstick the account right now)

### Option A: User has a new PAYG subscription in Stripe

Get the PAYG subscription ID (`sub_xxx`) and subscription item ID (`si_xxx`) from the Stripe dashboard. Then:

```sql
UPDATE users
SET
  plan_status = 'payg',
  has_access = TRUE,
  trial_chars_limit = 20000000,
  chars_used_at_payg_start = trial_chars_used,
  subscription_id = 'sub_xxx',
  stripe_item_id = 'si_xxx',
  free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE
WHERE email = 'user@example.com';
```

Also cancel the old `pre` subscription in the Stripe dashboard if it's still active.

### Option B: No PAYG subscription exists yet — reset to free so user can re-subscribe

```sql
UPDATE users
SET
  plan_status = 'free',
  has_access = TRUE,
  trial_chars_limit = 25000,
  trial_chars_used = 0,
  chars_used_at_payg_start = 0,
  subscription_id = NULL,
  stripe_item_id = NULL,
  free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE
WHERE email = 'user@example.com';
```

Then cancel the old `pre` subscription in the Stripe dashboard. The user can then subscribe to PAYG fresh via the app.

---

## Code Changes Required

### Fix 1 — `updateUserPlanStatus`: prevent downgrading `payg` users to `pre` (db.js)

Extend the idempotency guard to also block if the user is already on `payg`:

```js
// current guard (db.js ~line 791):
AND NOT (plan_status = 'pre' AND subscription_id = COALESCE($5, subscription_id))

// new guard:
AND NOT (plan_status = 'pre' AND subscription_id = COALESCE($5, subscription_id))
AND plan_status != 'payg'
```

This prevents any Stripe webhook from downgrading a `payg` user back to `pre`.

### Fix 2 — `/billing/switch-plan`: update DB state immediately, don't wait for webhook (index.js)

After canceling the old subscription, immediately call `cancelUserSubscription` on the DB (without the Stripe API call — that was already done). This ensures the DB transitions to `free` synchronously, regardless of webhook delivery timing.

```js
// After cancelStripeSubscriptionWithFinalUsage:
await cancelUserSubscription(req.userId);  // ← add this
// Then create checkout session as before
```

This also means the webhook's `cancelUserSubscription` call becomes a no-op on the already-free record (which is fine — it's idempotent).

### Fix 3 — `customer.subscription.updated` / `customer.subscription.created` webhook: add plan guard (index.js)

Before calling `updateUserPlanStatus(subRow.user_id, "pre", ...)` in the webhook handlers, check that the user is not already on `payg`:

```js
// Before updateUserPlanStatus call in webhook:
const currentUser = await getUserById(subRow.user_id);
if (currentUser && currentUser.plan_status !== 'payg') {
  await updateUserPlanStatus(subRow.user_id, "pre", true, new Date(), subscription.id);
}
```

This is a belt-and-suspenders guard alongside Fix 1.

### Fix 4 — Add `POST /admin/force-activate-payg` endpoint (index.js)

An admin-only endpoint that force-activates PAYG for a user by email, taking a `subscription_id` and `stripe_item_id` from request body. Calls `activatePaygPlan` directly. This allows unsticking accounts without raw SQL access.

### Fix 5 — `/billing/switch-plan`: skip checkout for existing customers with payment method (index.js) *(Optional/future)*

For `pre` → `payg`, create the PAYG subscription directly via Stripe API (the user has a payment method on file). This eliminates the checkout step and removes webhook dependency:

```js
const newSub = await stripe.subscriptions.create({
  customer: user.stripe_customer_id,
  items: [{ price: paygPriceId }],
  metadata: { userId: user.id.toString() },
});
const stripeItemId = newSub.items.data[0].id;
await activatePaygPlan(req.userId, newSub.id, stripeItemId);
res.json({ success: true, plan_status: 'payg' });
```

This would make the plan switch instant and reliable.

---

## Files to Modify

| File | What Changes |
|------|-------------|
| `db.js` | `updateUserPlanStatus` — extend `pre` guard to also exclude `payg` users |
| `index.js` | `/billing/switch-plan` — call `cancelUserSubscription` immediately after canceling old Stripe sub |
| `index.js` | `customer.subscription.updated` webhook handler — add `plan_status !== 'payg'` guard before `updateUserPlanStatus` |
| `index.js` | `customer.subscription.created` webhook handler — same guard |
| `index.js` | `checkout.session.completed` webhook handler — same guard (already handles PAYG correctly, but add belt-and-suspenders) |
| `index.js` | Add `POST /admin/force-activate-payg` endpoint |
