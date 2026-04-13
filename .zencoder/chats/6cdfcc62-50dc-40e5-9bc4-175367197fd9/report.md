# Implementation Report: Plan Transition Logic Hardening

This report summarizes the changes made to the HariBackend to harden the plan transition logic, fix critical billing bugs, and ensure idempotency across Stripe webhooks and manual plan switches.

## Summary of Changes

### Step 1: Clean Free-Plan Reset (BUG-02, BUG-03)
- **Modified**: `db.js` (`cancelUserSubscription`)
- **Action**: Updated the function to ensure that when a user cancels a paid plan, they receive a completely clean slate on the free tier.
- **Implemented**:
    - `trial_chars_used` reset to `0`.
    - `chars_used_at_payg_start` reset to `0`.
    - `free_chars_reset_date` refreshed to `NOW() + 30 days`.
- **Verification**: Verified that canceling a high-usage plan (e.g., 500k chars) no longer leaves the user with a near-exhausted free quota from stale snapshots.

### Step 2: Webhook Revocation Guard Hardening (BUG-08)
- **Modified**: `index.js` (`customer.subscription.updated`, `customer.subscription.deleted`)
- **Action**: Relaxed the subscription ID matching guard to handle cases where the user's `subscription_id` in the database might already be `NULL` due to race conditions or previous manual cancellations.
- **Implemented**: Changed guard to `if (currentUser && (!currentUser.subscription_id || currentUser.subscription_id === subscription.id))`.
- **Verification**: Simulated a webhook arriving for a user with a `NULL` `subscription_id` — the revocation now proceeds correctly instead of being silently skipped.

### Step 3: Idempotency Guards for Plan Activation (BUG-04, BUG-05)
- **Modified**: `db.js` (`activatePaygPlan`, `updateUserPlanStatus`)
- **Action**: Added SQL-level guards and logging to prevent double-processing of Stripe webhooks (e.g., `checkout.session.completed` and `customer.subscription.created` arriving simultaneously).
- **Implemented**:
    - `activatePaygPlan`: Added `AND NOT (plan_status = 'payg' AND subscription_id = $1)`.
    - `updateUserPlanStatus`: Added `AND NOT (plan_status = 'pre' AND subscription_id = COALESCE($5, subscription_id))`.
    - Added `console.warn` logging when these guards fire.
- **Verification**: Confirmed that second webhook calls result in 0 rows updated and a warning log, preserving the original `chars_used_at_payg_start` snapshot.

### Step 4: Switch-Plan "Free Limbo" Fix (BUG-01)
- **Modified**: `index.js` (`POST /billing/switch-plan`)
- **Action**: Removed the premature call to `cancelUserSubscription()`.
- **Implemented**: The flow now only cancels the old subscription on Stripe's side. The database transition to the new plan is handled atomically by the `checkout.session.completed` webhook upon successful payment.
- **Verification**: Verified that users switching plans and then abandoning checkout remain on their current paid plan instead of being immediately downgraded to the free tier.

### Step 5: (SKIPPED) Free/Pre Billing to use billableChars (BUG-06)
- **Status**: **SKIPPED** per user request.
- **Note**: The `/translate` endpoint continues to use `totalChars` for billing calculations on Free and Pre-plan tiers, maintaining the existing behavior for those users while PAYG continues to use `billableChars`.

### Step 6: Checkout Session Guard Hardening (BUG-07)
- **Modified**: `index.js` (`/billing/create-checkout-session`, `/billing/create-trial-checkout-session`, `/start-trial`)
- **Action**: Hardened guards to prevent invalid state transitions (e.g., PAYG users entering trials or users with active subscriptions starting new checkouts).
- **Implemented**:
    - Added `|| !!user.subscription_id` to various guards.
    - Included `'payg'` in the rejection list for trial endpoints.
- **Verification**: Confirmed that PAYG users are correctly blocked from trial checkouts and users with existing subscriptions cannot re-initiate checkouts.

### Step 7: Quota Window Anchoring (BUG-09)
- **Modified**: `db.js` (`updateUserPlanStatus`, `activatePaygPlan`)
- **Action**: Ensured that the 30-day monthly quota window is anchored to the date of plan upgrade/activation.
- **Implemented**: Added `free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE` to activation queries.
- **Verification**: Verified that a user upgrading from Free to Pre gets a fresh 30-day window starting from the upgrade date.

### Step 8: Frontend Visibility for Quota Reset (BUG-10)
- **Modified**: `index.js` (`GET /me`)
- **Action**: Added the reset date to the user info response.
- **Implemented**: Included `free_chars_reset_date: user.free_chars_reset_date || null` in the `meResponse` object.
- **Verification**: Confirmed `GET /me` now returns the reset date, allowing the frontend to display "Quota resets in X days".

## Verification Scenarios Completed

| Scenario | Result |
|----------|--------|
| **T7/T8 (Cancel)** | User resets to 0 chars, 25k limit, fresh 30-day date. |
| **T5/T6 (Switch)** | No immediate downgrade. User retains access until new checkout completes. |
| **Idempotency** | Double webhooks ignored by SQL guard, warning logged. |
| **Guards** | PAYG users blocked from `/start-trial` and trial checkouts. |
| **API** | `/me` returns correct `free_chars_reset_date`. |

## Edge Cases and Challenges
- **Stripe Race Conditions**: The dual-firing of `checkout.session.completed` and `customer.subscription.created` was a primary driver for the idempotency guards. The SQL `NOT (...)` clause ensures that even if Node.js processes them in parallel, the database remains consistent.
- **Snapshot Logic**: The `chars_used_at_payg_start` field is now strictly for PAYG delta calculation, as BUG-02 removed its conflicting use as a "cancel rewind" snapshot.
