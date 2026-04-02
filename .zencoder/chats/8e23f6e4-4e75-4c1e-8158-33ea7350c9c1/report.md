# Implementation Report

## What Was Implemented

Three surgical fixes were applied to address subscription/plan lifecycle correctness issues:

### Issue #1 — `customer.subscription.updated` subscription_id guard (`index.js` ~line 191)

Added the same guard that `customer.subscription.deleted` already had. The revocation branch now fetches the current user and checks `currentUser.subscription_id === subscription.id` before calling `updateUserPlanStatus`. If the updated subscription is not the user's current one (e.g., the old trial sub firing 'canceled' after an upgrade), access is preserved and a log message is emitted instead.

### Issue #2 — `updateUserTrialStart` idempotency (`db.js` ~line 505)

Changed the SQL to use `CASE WHEN subscription_id = $1 THEN ... ELSE ... END` for both `trial_chars_used` and `trial_started_at`. If the user is already trialing on the same subscription ID, neither the character counter nor the start timestamp is reset. If the subscription ID is new (first call), both are reset as before.

### Issue #3 — Missing `metadata.userId` on trial subscription (`index.js` ~line 460)

Added `metadata: { userId: userId.toString() }` to `subParams` in the `/start-trial` route. This allows the `customer.subscription.created` webhook handler to look up the user and act as a fallback if the synchronous API response fails after the Stripe subscription is created.

### Issue #4 — Race condition in `/start-trial`

Accepted as low risk per spec. No fix applied.

## How the Solution Was Tested

- `node -c index.js` — syntax OK
- `node -c db.js` — syntax OK

## Biggest Challenges

No significant challenges. All three fixes were surgical and confined to isolated locations. The trickiest part was ensuring the CASE expression in the SQL correctly preserves existing values when the subscription ID matches, while still updating `subscription_id = $1` unconditionally so the column always reflects the latest value.
