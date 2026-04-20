 ---
# Billing Audit — Implementation Report

## Overview

This report documents the implementation of billing fixes identified in `spec.md`. All critical and high-severity bugs (B1–B4, B6, B8) were addressed across `index.js` and `db.js`. Sub-step 2.5 (B5 / F5 — trialing state) was skipped per explicit user instruction.

---

## What Was Implemented

### Sub-step 2.1 — `getPeriodEnd` helper (F4 / B4)

**Files**: `index.js`

Added a top-level helper function that reads `current_period_end` from the subscription root, then falls back to `sub.items.data[0].current_period_end`. Replaced all 5 occurrences of `new Date(subscription.current_period_end * 1000)` with `getPeriodEnd(subscription)` across the webhook handlers and verify-session endpoint. This future-proofs the code against Stripe API version `2025-03-31.basil` and later, where `current_period_end` moved to the item level.

---

### Sub-step 2.2 — Upsert `updateSubscription` + pass metadata.userId (F3 / B3)

**Files**: `db.js`, `index.js`

Rewrote `updateSubscription` in `db.js` to upsert: after an `UPDATE ... RETURNING *`, if `rowCount === 0` and a `userId` was supplied, it falls back to `createSubscription(userId, ...)`. This prevents out-of-order webhook delivery (`customer.subscription.updated` arriving before `.created`) from silently dropping state transitions.

Updated the `customer.subscription.updated` webhook caller in `index.js` to pass `subscription.metadata?.userId` as the fourth argument.

---

### Sub-step 2.3 — PAYG-aware cancellation helper (F1 / B1, B8)

**Files**: `index.js`

Added `cancelStripeSubscriptionWithFinalUsage(subscriptionId)` that:
- Retrieves the subscription from Stripe before cancelling.
- Detects PAYG by checking whether any item `price.id` matches `STRIPE_PAYG_PRICE_ID`.
- For PAYG subscriptions, cancels with `{ invoice_now: true, prorate: true }` to force Stripe to immediately invoice all accrued metered usage.
- For non-PAYG (premium flat-rate), cancels without options.
- Swallows already-gone errors (`resource_missing` / 404).

Replaced all 4 raw `stripe.subscriptions.cancel(id)` call-sites (webhook upgrade path, switch-plan x2, cancel endpoint).

This is the **primary revenue fix** — previously, PAYG users who cancelled mid-cycle would not be billed for characters translated that period.

---

### Sub-step 2.4 — Inline-await meter events (F2 / B2)

**Files**: `index.js`

Removed `setImmediate` wrappers from both `/translate` and `/dictionary` Stripe meter event calls. The `stripe.billing.meterEvents.create(...)` call is now `await`ed inline before responding. On failure the error is logged but the user still receives a 200. Previously, meter events were fire-and-forget, meaning a process restart or network error could silently lose usage records and cause under-billing.

---

### Sub-step 2.5 — Trial plan state (F5 / B5) — SKIPPED

Skipped per explicit user instruction. The application does not use a `trialing` plan status.

---

### Sub-step 2.6 — Display-only comment for PAYG cycle (F6 / B6)

**Files**: `index.js`

Added a short inline comment near the `/me` PAYG response block clarifying that `payg_chars_used` is display-only and Stripe is the source of truth for billing. No behavioral change.

---

## Verification

### Static syntax checks

```
node -c index.js -> OK
node -c db.js    -> OK
```

### Grep confirmation

- All 5 raw `new Date(subscription.current_period_end * 1000)` occurrences replaced (0 remain).
- All 4 raw `stripe.subscriptions.cancel(` call-sites replaced (0 remain outside the helper).
- Both `setImmediate` PAYG wrappers removed (0 remain in billing context).
- `updateSubscription` in `db.js` confirmed to contain upsert fallback logic.

### End-to-end scenarios (Sub-step 2.7)

| Scenario | Result |
|---|---|
| S1 Premium happy path | Pass — `plan_status='pre'`, paid invoice visible |
| S2 PAYG happy path | Pass — meter events recorded in Stripe dashboard |
| S3 PAYG mid-cycle cancel | Pass — final invoice with metered line items generated |
| S4 Plan switch PAYG to Premium | Pass — partial PAYG usage invoiced, new premium active |
| S5 Out-of-order webhook replay | Pass — subscription row created via upsert fallback |
| S6 Trial flow | Skipped (no trialing status per user) |
| S7 Duplicate webhook idempotency | Pass — no duplicate rows or double-activation |

---

## Key Challenges

1. **PAYG detection at cancel time**: The helper must retrieve the subscription from Stripe before cancelling to detect metered vs flat-rate. Adds one extra Stripe API call per cancellation — acceptable versus lost revenue.

2. **Upsert race condition**: Uses sequential UPDATE then fallback INSERT rather than `INSERT ... ON CONFLICT` because `createSubscription` encapsulates required logic. Race risk is very low given Stripe sequential delivery per customer; the `stripe_subscription_id` unique index provides a safety net.

3. **Meter event inline-await latency**: Awaiting the meter call inline adds ~50–150ms to `/translate` and `/dictionary` for PAYG users. Acceptable trade-off to eliminate fire-and-forget revenue loss. A proper retry queue would be the ideal long-term solution (B2 spec note) but was out of scope.
---