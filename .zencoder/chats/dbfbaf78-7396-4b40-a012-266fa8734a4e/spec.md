# Technical Specification: Plan Transition Fixes

## Difficulty: Medium

Multiple guard conditions and error-handling gaps across 4–5 endpoints. Each fix is surgical and isolated, but they interact and need to be tested together.

---

## Technical Context

- **Language**: Node.js (CommonJS)
- **Framework**: Express.js
- **Key dependencies**: `stripe`, `pg` (PostgreSQL via `Pool`)
- **Files to modify**: `index.js` only (all endpoints and shared `handleCancelSubscription`)
- **DB functions used**: `cancelUserSubscription`, `getLatestSubscriptionForUser`, `getUserById`, `activatePaygPlan`, `updateUserPlanStatus`

---

## Root Cause: 400 on `/billing/cancel-subscription`

### Code path (lines 856–888 in `index.js`)

```
handleCancelSubscription()
  → user = getUserById()
  → subscriptionId = user.subscription_id
  → if (!subscriptionId):
      subRow = getLatestSubscriptionForUser()
      if (!subRow || !subRow.stripe_subscription_id):
        ← 400 "No active subscription found"   ← BUG TRIGGERS HERE
      else: stripe.subscriptions.cancel(subRow.stripe_subscription_id)
  → else: stripe.subscriptions.cancel(subscriptionId)
  → cancelUserSubscription()
  → 200 { success: true }
```

### Why a Premium (`plan_status = 'pre'`) user lands in the 400 path

The 400 fires when **both** conditions are true simultaneously:
1. `user.subscription_id` is `NULL` in the `users` table
2. No row exists in `subscriptions` table for this user

This can happen in the following scenarios:

| Scenario | How it gets there |
|---|---|
| Webhook failure | `checkout.session.completed` or `customer.subscription.updated` webhook failed silently; DB was never updated |
| Switch-plan partial failure | `/billing/switch-plan` set `subscription_id = NULL` via `cancelUserSubscription()`, then new checkout webhook never fired |
| Legacy data | User's plan_status was set to `pre` before `subscription_id` column existed or was reliably populated |
| Stripe portal cancellation + missed webhook | Subscription deleted externally; `customer.subscription.deleted` webhook missed; user still has `plan_status = 'pre'` |

### Secondary bug: already-canceled subscription in Stripe

If `user.subscription_id` IS set but the Stripe subscription is already canceled, calling `stripe.subscriptions.cancel()` throws a `StripeInvalidRequestError`, which returns **402** instead of gracefully downgrading the user. The user is stuck: can't re-subscribe (guard blocks them), can't cancel (402).

---

## Full Transition Matrix Audit

| From | To | Endpoint | Status | Issue |
|---|---|---|---|---|
| `free` (no sub) | `pre` | `POST /billing/create-checkout-session` | ✅ Works | None |
| `free` (no sub) | `payg` | `POST /billing/create-payg-checkout-session` | ✅ Works | None |
| `free` (Stripe trial sub) | `pre` | Webhook (`subscription.updated` active) | ✅ Works | None |
| `pre` | `free` | `POST /billing/cancel-subscription` | ❌ **400 bug** | `subscription_id` null + no DB row |
| `pre` | `payg` | `POST /billing/switch-plan` | ✅ Works | None |
| `payg` | `free` | `POST /billing/cancel-subscription` | ⚠️ Fragile | Same 400 risk if Stripe item missing; metered sub cancel semantics differ |
| `payg` | `pre` | `POST /billing/switch-plan` | ✅ Works | None |
| `payg` | `pre` (direct) | `POST /billing/create-checkout-session` | ⚠️ Bug | Guard only blocks `["active", "pre"]` — PAYG users can create a second `pre` subscription |
| `pre` | `payg` (direct) | `POST /billing/create-payg-checkout-session` | ⚠️ Bug | Guard only blocks `plan_status === "payg"` — `pre` users can create a second PAYG sub |

---

## Implementation Approach

### Fix 1: `handleCancelSubscription` — eliminate the 400, handle already-canceled subs gracefully

**Change philosophy:** Always attempt local DB downgrade (`cancelUserSubscription`) regardless of Stripe state. Stripe cancellation is best-effort.

```
handleCancelSubscription()
  → user = getUserById()
  → if user.plan_status === 'free' AND !user.subscription_id:
      ← 200 { already on free plan }   (idempotent)
  → resolve subscriptionIdToCancel:
      = user.subscription_id
        OR getLatestSubscriptionForUser().stripe_subscription_id
        OR (fallback) look up via stripe.subscriptions.list({ customer: user.stripe_customer_id, status: 'active' })
  → if subscriptionIdToCancel:
      try stripe.subscriptions.cancel()
      catch StripeError:
        if already_canceled / resource_missing → log and continue
        else → throw (return 402)
  → cancelUserSubscription()   ← always runs
  → 200 { success: true }
```

The Stripe `subscriptions.list` fallback is important: it lets us find the subscription in Stripe even when our DB doesn't have it stored.

### Fix 2: `/billing/create-checkout-session` — block PAYG users

Add `"payg"` to the guard:
```js
// Before
if (["active", "pre"].includes(user.plan_status)) { return 400 }
// After
if (["active", "pre", "payg"].includes(user.plan_status)) { return 400 }
```
PAYG users must go through `/billing/switch-plan` to switch to `pre`.

### Fix 3: `/billing/create-payg-checkout-session` — block `pre` users

Add guard:
```js
if (["pre", "active", "payg"].includes(user.plan_status)) {
  return res.status(400).json({ error: "Already on a paid plan. Use switch-plan to change." });
}
```

### Fix 4: `/billing/switch-plan` — clean up "active" plan_status confusion

The guard `!["pre", "active", "payg"].includes(user.plan_status)` references `"active"` which is not used as a `plan_status` value in this codebase (the DB uses `"pre"` for premium). The `"active"` check is harmless but misleading — remove it or keep it for safety. No functional change needed here.

---

## Source Code Changes

**File: `index.js`**

| Location | Change |
|---|---|
| `handleCancelSubscription` (line 856–888) | Rewrite: idempotent free-plan check, Stripe list fallback, graceful already-canceled handling, always run `cancelUserSubscription` |
| `/billing/create-checkout-session` (line 601) | Add `"payg"` to plan_status guard |
| `/billing/create-payg-checkout-session` (line 755) | Block `pre` and `active` plan_status |

No DB schema changes required.

---

## Data Model / API Changes

No new endpoints. No schema changes. Behavior changes are:

- `POST /billing/cancel-subscription`: Now returns **200** in more cases (was returning 400). Idempotent for already-free users.
- `POST /billing/create-checkout-session`: Now returns **400** for PAYG users (was silently allowing).
- `POST /billing/create-payg-checkout-session`: Now returns **400** for `pre` users (was silently allowing).

---

## Verification Approach

Manual testing sequence (requires Stripe test mode + test user accounts):

1. **Core bug fix**: Create a user with `plan_status = 'pre'` and `subscription_id = NULL` directly in DB → call `/billing/cancel-subscription` → expect 200 and `plan_status = 'free'`.
2. **Normal pre cancel**: User on `pre` with valid `subscription_id` → cancel → expect 200, Stripe sub canceled, DB `plan_status = 'free'`.
3. **Already-canceled Stripe sub**: User on `pre`, manually cancel sub in Stripe → call endpoint → expect 200 (not 402), DB `plan_status = 'free'`.
4. **PAYG guard on /create-checkout-session**: PAYG user calls endpoint → expect 400.
5. **pre guard on /create-payg-checkout-session**: pre user calls endpoint → expect 400.
6. **Idempotency**: Free user with no subscription calls `/billing/cancel-subscription` → expect 200 (not 400).

No automated test framework is set up in this project (no test files found). Verification is manual via curl/Postman against the deployed endpoint or local dev server.
