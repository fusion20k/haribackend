# Technical Specification: Fix Trial Plan Status Not Updating After Checkout

## Complexity Assessment
**Medium** — Multiple interacting bugs across webhook handling and DB layer. No architectural changes needed.

---

## Technical Context
- **Language**: JavaScript (Node.js)
- **Framework**: Express
- **Database**: PostgreSQL via `pg` pool
- **Payment**: Stripe (webhooks + Checkout Sessions)
- **Files to modify**: `index.js`, `db.js`

---

## Root Cause Analysis

### Bug 1: `createSubscription` crashes on duplicate (PRIMARY BUG)
`createSubscription` in `db.js` uses a plain `INSERT`. Stripe often fires `customer.subscription.created` before or concurrently with `checkout.session.completed`. If a subscription row already exists when the webhook tries to insert, PostgreSQL throws a unique constraint violation on `stripe_subscription_id`. This causes the entire `checkout.session.completed` handler to throw, meaning `updateUserTrialStart` is **never called**.

**Fix**: Change INSERT to `INSERT ... ON CONFLICT (stripe_subscription_id) DO UPDATE SET status, current_period_end, updated_at`.

### Bug 2: No `customer.subscription.created` handler
The webhook handles `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted` — but not `customer.subscription.created`. If `customer.subscription.created` fires before `checkout.session.completed`, there's no handler to update user plan status.

**Fix**: Add a `customer.subscription.created` handler that upserts the subscription and updates user plan status.

### Bug 3: No direct verification fallback
The extension's success page gets `?session_id=...` but there's no backend endpoint to confirm the payment directly. The system relies 100% on webhooks, which can be delayed, mis-configured, or fail silently.

**Fix**: Add a `POST /billing/verify-session` endpoint (auth required) that retrieves the Stripe session server-side, upserts the subscription, and updates the user's plan status. The extension's success page should call this endpoint after redirect.

---

## Implementation Plan

### 1. Fix `db.js` — Make `createSubscription` an upsert
```sql
INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_end)
VALUES ($1, $2, $3, $4)
ON CONFLICT (stripe_subscription_id) DO UPDATE SET
  status = EXCLUDED.status,
  current_period_end = EXCLUDED.current_period_end,
  updated_at = CURRENT_TIMESTAMP
RETURNING ...
```

### 2. Fix `index.js` webhook — Restructure `checkout.session.completed`
After the upsert, always call `updateUserTrialStart` or `updateUserPlanStatus` based on status — don't let a DB error block it. Wrap individual steps in try-catch so one failure doesn't abort the rest.

### 3. Fix `index.js` webhook — Add `customer.subscription.created` handler
Mirror the logic from `checkout.session.completed`. Look up `userId` from subscription metadata (Stripe propagates session metadata to subscription via `subscription_data.metadata`). Update user plan status based on subscription status.

### 4. Add `POST /billing/verify-session` endpoint
- Auth required
- Accepts `{ session_id }` in request body
- Retrieves session from Stripe: `stripe.checkout.sessions.retrieve(session_id, { expand: ['subscription'] })`
- Validates `session.metadata.userId === req.userId` (security check)
- Upserts subscription in DB
- Updates user plan status
- Returns updated user object

---

## Data Model / API Changes

### New endpoint
`POST /billing/verify-session` (authenticated)
- Request: `{ session_id: string }`
- Response: `{ success: true, plan_status: string, has_access: boolean }`

### Modified DB function
`createSubscription` — changed from INSERT to upsert (backwards compatible)

---

## Verification
- Start server locally with valid `.env`
- Hit `/billing/create-trial-checkout-session` to get a session URL
- Complete Stripe test checkout
- Call `POST /billing/verify-session` with `session_id` — confirm plan_status updates
- Check `/debug/me` — confirm `plan_status: "trialing"` and `has_access: true`
- Simulate webhook via Stripe CLI: `stripe trigger checkout.session.completed`
