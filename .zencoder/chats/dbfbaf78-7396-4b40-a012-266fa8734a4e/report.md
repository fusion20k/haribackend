# Bug Fix Report: Billing plan_status and Limits Audit  
  
**Date**: 2026-04-11  
**Files modified**: index.js, db.js  
**Syntax check**: node --check index.js - exit 0, no syntax errors  
  
---  
  
## Summary  
  
Five bugs fixed across index.js and db.js. All changes are surgical.  
  
---  
  
## BUG-1 Critical - /billing/verify-session - PAYG detection - FIXED  
  
File: index.js lines 709-724  
  
Before: active branch always called updateUserPlanStatus(pre).  
After: price ID checked against STRIPE_PAYG_PRICE_ID; if PAYG, activatePaygPlan is called.  
  
Result: PAYG checkout correctly sets plan_status=payg, trial_chars_limit=20000000,  
and stripe_item_id on session verify. Webhook correction no longer needed.  
  
---  
  
## BUG-2 Medium - /start-trial - PAYG guard - FIXED  
  
File: index.js line 475  
  
Added payg to the blocked statuses array.  
  Before: [\"pre\", \"active\"].includes(user.plan_status)  
  After:  [\"pre\", \"active\", \"payg\"].includes(user.plan_status)  
  
Result: PAYG users calling /start-trial now receive 400 Trial or subscription already active.  
  
---  
  
## BUG-3 Medium - cancelUserSubscription - stale stripe_item_id - FIXED  
  
File: db.js line 671  
  
Added stripe_item_id = NULL to the UPDATE in cancelUserSubscription.  
  
Result: stripe_item_id cleared alongside subscription_id on cancellation.  
Prevents stale metered billing data from persisting after cancellation.  
  
---  
  
## BUG-4 Minor - updateUserTrialStart - missing trial_started_at - FIXED  
  
File: db.js line 582  
  
Added trial_started_at = COALESCE(trial_started_at, NOW()) to the UPDATE.  
Added trial_started_at to the RETURNING clause.  
  
Result: trial_started_at set on first call, preserved on subsequent calls.  
The /me endpoint will return a non-null trial_started_at for trial users.  
  
---  
  
## BUG-5 Minor - Duplicate /cancel-subscription endpoint - FIXED  
  
File: index.js  
  
Extracted cancel logic into handleCancelSubscription function. Both  
/billing/cancel-subscription and /cancel-subscription point to this shared handler.  
  
Result: Single implementation, future changes applied once.  
Legacy route preserved for Chrome extension backwards compatibility.  
  
---  
  
## Verification  
  
Syntax check: node --check index.js - exit code 0, no syntax errors.  
  
Code inspection confirmed via git diff:  
  BUG-1  index.js:709-724   PAYG branch calls activatePaygPlan                VERIFIED  
  BUG-2  index.js:475        payg added to blocked statuses array              VERIFIED  
  BUG-3  db.js:671           stripe_item_id = NULL in UPDATE                   VERIFIED  
  BUG-4  db.js:582           trial_started_at = COALESCE added to UPDATE       VERIFIED  
  BUG-5  index.js:890,1285  Both routes use shared handleCancelSubscription    VERIFIED  
  
Runtime verification: No automated test suite. Logic verified via static analysis  
of git diffs against the spec requirements.  
  
---  
  
## Notes  
  
- BUG-1 fallback price ID is a safety net; if STRIPE_PAYG_PRICE_ID is always set  
  in production, the fallback is never reached.  
- The legacy /cancel-subscription route is preserved for Chrome extension compatibility.  
