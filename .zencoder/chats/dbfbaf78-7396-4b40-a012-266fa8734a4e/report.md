# Implementation Report: Plan Transition Fixes

**Date**: 2026-04-11
**File modified**: `index.js` only
**Syntax check**: `node --check index.js` — exit 0, no errors

---

## Summary

Three surgical fixes to `index.js` eliminating a `400` deadlock on `/billing/cancel-subscription`, a duplicate-subscription vulnerability on `/billing/create-checkout-session`, and a duplicate-subscription vulnerability on `/billing/create-payg-checkout-session`. No DB schema changes required.

---

## Fix 1 — `handleCancelSubscription`: Eliminate 400, handle already-canceled subs

**Root cause**: The function returned `400 "No active subscription found"` when `user.subscription_id` was NULL and no row existed in the `subscriptions` table. This trapped users with `plan_status='pre'` who had a missing subscription ID — caused by webhook failures, partial switch-plan failures, legacy data, or external Stripe cancellations.

**Secondary root cause**: If `subscription_id` was set but the Stripe subscription was already canceled, `stripe.subscriptions.cancel()` threw `StripeInvalidRequestError` returning `402`. Users were deadlocked: guards blocked re-subscribing, and cancel returned 402.

**Changes (lines 856–921):**
- Idempotent free-plan early return: if `plan_status === 'free' && !subscription_id` → `200` immediately
- Three-tier subscription ID resolution:
  1. `user.subscription_id` (users table)
  2. `getLatestSubscriptionForUser()` (subscriptions table)
  3. Stripe API fallback: `stripe.subscriptions.list({ customer, status: 'active', limit: 1 })`
- Try/catch around `stripe.subscriptions.cancel()`: swallows `resource_missing`, 404, and "no such subscription" — re-throws all others
- `cancelUserSubscription()` **always runs** — DB downgrade is unconditional

---

## Fix 2 — `/billing/create-checkout-session`: Block PAYG users

**Before**: `["active", "pre"].includes(user.plan_status)` — PAYG users could create a second `pre` subscription directly.

**After**: `["active", "pre", "payg"].includes(user.plan_status)` — PAYG users receive `400 "Subscription already active"` and must go through `/billing/switch-plan`.

---

## Fix 3 — `/billing/create-payg-checkout-session`: Block `pre` users

**Before**: `user.plan_status === "payg"` — `pre` users could create a second PAYG subscription.

**After**: `["pre", "active", "payg"].includes(user.plan_status)` — returns `400 "Already on a paid plan. Use switch-plan to change."` for all paid-plan users.

---

## Audits (No Changes Required)

### `cancelUserSubscription` (db.js line 658)

Correctly resets all fields when downgrading to free:

| Field | Value |
|---|---|
| `plan_status` | `'free'` |
| `has_access` | `TRUE` |
| `trial_chars_limit` | `25000` |
| `trial_chars_used` | `0` |
| `free_chars_reset_date` | `NOW() + 30 days` |
| `subscription_id` | `NULL` |
| `stripe_item_id` | `NULL` |

### `/billing/switch-plan` char limit flow

Char limits are applied via Stripe webhooks after the new checkout completes:

| Plan | Limit | Applied by |
|---|---|---|
| `free` | 25,000 | `cancelUserSubscription()` — sets `trial_chars_limit = 25000` |
| `pre` | 1,000,000 | `updateUserPlanStatus('pre')` — sets `trial_chars_limit = 1000000` |
| `payg` | 20,000,000 | `activatePaygPlan()` — sets `trial_chars_limit = 20000000` |

All limits correct. No fix needed.

---

## Verification

**Syntax**: `node --check index.js` — exit 0

Manual test scenarios (code inspection; Stripe test mode for live end-to-end):

| # | Scenario | Expected | Verification basis |
|---|---|---|---|
| 1 | `plan_status='pre'`, `subscription_id=NULL`, no DB sub row → cancel | 200, `plan_status='free'` | Stripe list fallback + unconditional `cancelUserSubscription` |
| 2 | Valid `subscription_id` → cancel | 200, Stripe canceled, `plan_status='free'` | Normal path |
| 3 | `subscription_id` already canceled in Stripe → cancel | 200 (not 402), `plan_status='free'` | `resource_missing` catch swallows error |
| 4 | PAYG user calls `/billing/create-checkout-session` | 400 | New `"payg"` guard |
| 5 | `pre` user calls `/billing/create-payg-checkout-session` | 400 | New `["pre", "active", "payg"]` guard |
| 6 | Free user, no subscription → cancel | 200 (idempotent) | Early return on `plan_status='free' && !subscription_id` |

No automated test framework exists. Verification is manual via curl/Postman.

---

## Challenges

- **Multi-cause root**: The 400 on cancel had three distinct entry points (NULL `subscription_id` in users table, missing subscriptions row, or Stripe-canceled subscription). Each required a separate fix layer.
- **Deadlock analysis**: Users with externally-canceled subscriptions were completely stuck — can't re-subscribe (guards block them), can't cancel (402 from Stripe). The fix makes cancel idempotent at the Stripe layer.
- **Async char limits**: The `switch-plan` char limit update happens asynchronously via webhook, not synchronously in the endpoint. Required tracing the full webhook flow to confirm limits are set correctly.
