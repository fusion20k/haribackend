# Technical Specification: Plan Transition Logic Hardening

## Difficulty: Hard
Complex state machine with many transition paths, Stripe webhook race conditions, dual-purpose fields, and edge cases that can permanently corrupt user billing state.

---

## Technical Context

- **Runtime**: Node.js / Express
- **DB**: PostgreSQL via `pg` pool
- **Payments**: Stripe (subscriptions + metered billing for PAYG)
- **Key files**: `index.js`, `db.js`

---

## Plan State Machine

### Plan States

| State | Meaning | `trial_chars_limit` | `has_access` |
|-------|---------|---------------------|--------------|
| `free` | Free tier, monthly quota | 25,000 | TRUE |
| `pre` | Flat-rate premium | 1,000,000 | TRUE |
| `payg` | Pay-as-you-go metered | 20,000,000 (soft) | TRUE |
| *(legacy: `trialing`, `active`, `canceled`)* | Migrated away at DB init | — | — |

### Key DB Fields

| Field | Purpose |
|-------|---------|
| `plan_status` | Current plan state |
| `trial_chars_used` | Cumulative character counter (never decremented, only reset) |
| `trial_chars_limit` | Monthly cap for current plan |
| `chars_used_at_payg_start` | Snapshot of `trial_chars_used` at PAYG/pre activation — used for delta billing and cancel rewind |
| `subscription_id` | Stripe subscription ID |
| `stripe_item_id` | Stripe subscription item ID (metered billing) |
| `free_chars_reset_date` | Date to reset `trial_chars_used` to 0 |
| `trial_started_at` | When user first entered a subscription |
| `trial_converted_at` | When user converted to paid |

---

## All Transition Paths

### T1: (none) → free [Signup]
**Trigger**: `POST /auth/signup` → `createUser()`
**Expected state after**:
- `plan_status = 'free'`
- `has_access = TRUE`
- `trial_chars_used = 0`
- `trial_chars_limit = 25000`
- `free_chars_reset_date = NOW() + 30 days`
- `chars_used_at_payg_start = 0`
- `subscription_id = NULL`
**Current status**: ✅ Correct

---

### T2: free → free+trial [Start Trial]
**Trigger**: `POST /start-trial` → `updateUserTrialStart(userId, sub.id)`
**Expected state after**:
- `plan_status = 'free'` (intentionally; 'trialing' is deprecated)
- `has_access = TRUE`
- `subscription_id = sub.id`
- `trial_started_at = NOW()` (only set once via COALESCE)
- `trial_chars_limit` unchanged (25,000)
**Current status**: ✅ Works as designed (trialing=free with sub attached)

---

### T3: free → pre [Checkout / Webhook]
**Trigger**: User completes `STRIPE_PRICE_ID` checkout → `checkout.session.completed` webhook → `updateUserPlanStatus(userId, 'pre', true, now, sub.id)`
**Expected state after**:
- `plan_status = 'pre'`
- `has_access = TRUE`
- `trial_chars_limit = 1,000,000`
- `chars_used_at_payg_start = trial_chars_used` (snapshot for cancel rewind)
- `subscription_id = sub.id`
- `trial_converted_at = NOW()`
- `free_chars_reset_date` → should be refreshed to NOW() + 30 days
**Current status**: ⚠️ `free_chars_reset_date` is NOT reset on upgrade to pre

---

### T4: free → payg [Checkout / Webhook]
**Trigger**: User completes `STRIPE_PAYG_PRICE_ID` checkout → webhook → `activatePaygPlan(userId, sub.id, itemId)`
**Expected state after**:
- `plan_status = 'payg'`
- `has_access = TRUE`
- `trial_chars_limit = 20,000,000`
- `chars_used_at_payg_start = trial_chars_used` (PAYG billing baseline)
- `subscription_id = sub.id`
- `stripe_item_id = itemId`
- `free_chars_reset_date` → should be refreshed to NOW() + 30 days
**Current status**: ⚠️ `free_chars_reset_date` NOT reset on PAYG activation

---

### T5: pre → payg [switch-plan]
**Trigger**: `POST /billing/switch-plan { targetPlan: 'payg' }`
**Current code flow**:
1. Cancels old Stripe subscription immediately
2. Calls `cancelUserSubscription()` → **sets user to free with limit=25000**
3. Creates PAYG checkout session
4. User must complete checkout before PAYG activates
**Problem**: User is left on `free` (limited access) until checkout is done. If abandoned, user loses their `pre` access permanently.
**Current status**: 🔴 **CRITICAL BUG** — user loses paid access mid-flow

---

### T6: payg → pre [switch-plan]
**Trigger**: `POST /billing/switch-plan { targetPlan: 'pre' }`
**Same problem as T5**: user is set to free before checkout is completed.
**Current status**: 🔴 **CRITICAL BUG**

---

### T7: pre/payg → free [Cancel Subscription]
**Trigger**: `POST /billing/cancel-subscription` → Stripe cancels → webhook → `cancelUserSubscription()`
**Current `cancelUserSubscription()` behavior**:
```
plan_status = 'free'
has_access = TRUE
trial_chars_limit = 25000
trial_chars_used = chars_used_at_payg_start   ← BUG
chars_used_at_payg_start = 0
subscription_id = NULL
stripe_item_id = NULL
```
**BUG**: `trial_chars_used` is set to the pre-activation snapshot (`chars_used_at_payg_start`).

**Example scenario causing harm**:
- User on free uses 24,000 chars → `trial_chars_used=24000`
- User upgrades to pre → `chars_used_at_payg_start=24000`
- User uses 500,000 chars on pre → `trial_chars_used=524000`
- User cancels → `trial_chars_used = 24000`, `trial_chars_limit = 25000`
- User now has only **1,000 free chars remaining** from a stale snapshot!

**Additional BUG**: `free_chars_reset_date` is NOT reset. If user was on paid plan for months, this date may be in the past (triggering immediate reset accidentally) or the far future (giving wrong quota window).

**Current status**: 🔴 **CRITICAL BUG** — incorrect chars accounting and missing date reset

---

### T8: any → free [Webhook subscription.deleted or subscription.updated with canceled status]
**Trigger**: Stripe fires `customer.subscription.deleted` or `customer.subscription.updated` with `status=canceled`
**Current behavior**: Calls `cancelUserSubscription()` with same bugs as T7
**Additional BUG**: The guard `currentUser.subscription_id === subscription.id` — if `subscription_id` is `NULL`, this check evaluates to `null === 'sub_xxx'` → false, so the revocation is silently skipped even when it should fire.
**Current status**: 🔴 **BUG** — revocation silently skipped if subscription_id is null

---

### T9: free+trial → pre [Trial converts to paid via Stripe webhook]
**Trigger**: `customer.subscription.updated` — status changes from `trialing` to `active` → `updateUserPlanStatus('pre', ...)`
**Expected**: Same as T3
**Current status**: ✅ Logic is correct (same function as T3)

---

### T10: pre → free+trial [Trial re-entry / edge case]
**Trigger**: `customer.subscription.updated` — status changes to `trialing` when it wasn't before
**Current behavior**: Calls `updateUserTrialStart()` → sets `plan_status='free'`
**Issue**: If user was on `pre` and a webhook arrives with `trialing` status (e.g., from a coupon or promo), it would downgrade them to free
**Current status**: ⚠️ Unlikely but possible webhook-driven downgrade

---

## Bugs Catalog

### BUG-01 🔴 — switch-plan free limbo (T5, T6)
**File**: `index.js`, `/billing/switch-plan`  
`cancelUserSubscription()` is called before the new checkout is complete. User loses paid access permanently if checkout is abandoned.  
**Fix**: Do NOT call `cancelUserSubscription()` in switch-plan. Instead:
- Cancel old Stripe subscription (Stripe-side only)
- Create checkout session
- Let the webhook on new sub activation handle the transition atomically
- The `checkout.session.completed` handler already has logic to cancel the previous subscription

---

### BUG-02 🔴 — cancelUserSubscription wrong chars rewind (T7, T8)
**File**: `db.js`, `cancelUserSubscription()`  
Sets `trial_chars_used = chars_used_at_payg_start` which can leave users with near-exhausted free quota.  
**Fix**: Set `trial_chars_used = 0` and `free_chars_reset_date = NOW() + 30 days` on cancel to give a clean free-plan start.

---

### BUG-03 🔴 — cancelUserSubscription missing free_chars_reset_date reset (T7, T8)
**File**: `db.js`, `cancelUserSubscription()`  
`free_chars_reset_date` is not set, leaving stale value.  
**Fix**: Always set `free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE` in `cancelUserSubscription()`.

---

### BUG-04 🟠 — Webhook double-processing: activatePaygPlan idempotency (T4)
**File**: `index.js`, webhook handlers  
`checkout.session.completed` AND `customer.subscription.created` both fire for same checkout.  
Both call `activatePaygPlan()` which snapshots `trial_chars_used`. If chars accumulate between the two calls, the second snapshot is wrong.  
**Fix**: In `activatePaygPlan()`, add guard: skip if `plan_status` is already `'payg'` AND `subscription_id` matches.

---

### BUG-05 🟠 — Webhook double-processing: updateUserPlanStatus idempotency (T3, T9)
**File**: `index.js`, webhook handlers  
Same issue for `updateUserPlanStatus('pre')` — called by both `checkout.session.completed` and `customer.subscription.created`.  
Second call re-snapshots `chars_used_at_payg_start` at wrong time.  
**Fix**: Add guard: skip if `plan_status` is already `'pre'` AND `subscription_id` matches.

---

### BUG-06 🟠 — /translate uses totalChars for free/pre billing (not billableChars)
**File**: `index.js`, `/translate`, line ~1434  
`billableChars` computation exists (lines 1381–1394) and is correctly used for PAYG. But free/pre billing still uses `totalChars` (includes skipped non-translatable segments).  
This was supposed to be fixed in Step 3 of the previous plan but is not implemented.  
**Fix**: Change line 1434: `incrementUserTrialChars(req.userId, totalChars)` → `incrementUserTrialChars(req.userId, billableChars)`

---

### BUG-07 🟠 — Subscription guard holes in checkout endpoints
**File**: `index.js`  
- `/billing/create-checkout-session` guard: `["active", "pre", "payg"]` — does NOT check `user.subscription_id`. A free user already in a trial can start another checkout.  
- `/billing/create-trial-checkout-session` guard: `["pre", "active"]` — does NOT include `'payg'`. PAYG users can start a trial checkout.  
**Fix**: Add `|| !!user.subscription_id` to checkout guard; add `'payg'` to trial-checkout guard.

---

### BUG-08 🟡 — webhook subscription.updated: null subscription_id skips revocation (T8)
**File**: `index.js`, `customer.subscription.updated` handler  
```js
if (currentUser && currentUser.subscription_id === subscription.id)
```
If `subscription_id` is `NULL`, comparison is `null === 'sub_xxx'` = false, so revocation is silently skipped.  
**Fix**: Change to: `if (!currentUser || !currentUser.subscription_id || currentUser.subscription_id === subscription.id)`

---

### BUG-09 🟡 — free_chars_reset_date not refreshed on upgrade (T3, T4)
**File**: `db.js`, `updateUserPlanStatus()`, `activatePaygPlan()`  
When a free user upgrades to pre or payg, `free_chars_reset_date` is not updated. The old free-plan window continues unchanged.  
**Fix**: Set `free_chars_reset_date = NOW() + 30 days` in both `updateUserPlanStatus('pre')` and `activatePaygPlan()`.

---

### BUG-10 🟡 — /me response missing free_chars_reset_date
**File**: `index.js`, `/me`  
Frontend cannot show "Quota resets in X days".  
**Fix**: Add `free_chars_reset_date: user.free_chars_reset_date` to `/me` response.

---

### BUG-11 🟡 — switch-plan has no concurrency guard (double-click)
**File**: `index.js`, `/billing/switch-plan`  
If called twice rapidly, two Stripe subscriptions may be created and two checkout sessions returned.  
**Fix**: Check `user.plan_status` is still on a paid plan at the start, not just the status from initial DB read. (This is partially addressed by fixing BUG-01.)

---

### BUG-12 🟡 — chars_used_at_payg_start dual-purpose field creates confusion
**File**: `db.js`  
`chars_used_at_payg_start` is used for:
1. PAYG delta computation (`payg_chars_used = trial_chars_used - chars_used_at_payg_start`)
2. Cancel rewind (`trial_chars_used = chars_used_at_payg_start` on cancel)

These two purposes conflict when user goes free → pre → payg. The field is correctly reset by `activatePaygPlan` so the PAYG delta is always accurate. But for pre→free cancel, the pre-activation snapshot is used for rewind (BUG-02 addresses this).  
After BUG-02 fix, `chars_used_at_payg_start` becomes single-purpose (PAYG delta). Should be documented clearly.

---

## Implementation Steps

### Step 1: Fix `cancelUserSubscription` — clean free-plan reset
**File**: `db.js`, `cancelUserSubscription()`
- Set `trial_chars_used = 0` (clean slate on free)
- Set `free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE`
- Keep existing: `plan_status='free'`, `has_access=TRUE`, `trial_chars_limit=25000`, `chars_used_at_payg_start=0`, `subscription_id=NULL`, `stripe_item_id=NULL`

### Step 2: Fix webhook null-subscription_id guard (BUG-08)
**File**: `index.js`, `customer.subscription.updated` and `customer.subscription.deleted` handlers
- Change null-guard in revocation check so null subscription_id doesn't block revocation

### Step 3: Add idempotency to activatePaygPlan (BUG-04)
**File**: `db.js`, `activatePaygPlan()`
- Add `WHERE id = $3 AND NOT (plan_status = 'payg' AND subscription_id = $1)` to prevent double-apply

### Step 4: Add idempotency to updateUserPlanStatus for 'pre' (BUG-05)
**File**: `db.js`, `updateUserPlanStatus()`
- For `planStatus = 'pre'`, add guard `AND NOT (plan_status = 'pre' AND subscription_id = $5)` to prevent re-snapshotting

### Step 5: Fix switch-plan to not pre-cancel subscription (BUG-01)
**File**: `index.js`, `/billing/switch-plan`
- Remove `cancelUserSubscription()` call
- Keep Stripe `subscriptions.cancel()` for the old sub
- Rely on webhook `checkout.session.completed` → old-sub cancel logic (already implemented there)
- Add a DB field `pending_plan = 'payg'|'pre'` OR simply trust the webhook flow

### Step 6: Fix free/pre billing to use billableChars (BUG-06)
**File**: `index.js`, `/translate`, line ~1434
- Change `totalChars` → `billableChars` in `incrementUserTrialChars` call for free/pre

### Step 7: Fix checkout session guards (BUG-07)
**File**: `index.js`
- `/billing/create-checkout-session`: add `|| !!user.subscription_id` to guard
- `/billing/create-trial-checkout-session`: add `'payg'` to plan_status guard

### Step 8: Refresh free_chars_reset_date on plan upgrades (BUG-09)
**File**: `db.js`, `updateUserPlanStatus()` for 'pre' and `activatePaygPlan()`
- Set `free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE` in both functions

### Step 9: Add free_chars_reset_date to /me response (BUG-10)
**File**: `index.js`, `/me`
- Add `free_chars_reset_date` field to response object

---

## Verification Approach

For each step, verify with these scenarios:

| Scenario | What to check |
|----------|---------------|
| free user cancels before using chars | `trial_chars_used=0`, `limit=25000`, fresh reset date |
| pre user cancels after using 500k chars | `trial_chars_used=0`, `limit=25000`, fresh reset date |
| payg user cancels after using 1M chars | `trial_chars_used=0`, `limit=25000`, fresh reset date |
| switch pre→payg, user abandons checkout | User should remain on `pre` (not free) |
| switch payg→pre, user abandons checkout | User should remain on `payg` (not free) |
| Two webhooks arrive for same checkout | State not double-applied; chars_used_at_payg_start correct |
| Free user with subscription tries to create checkout | Request rejected |
| PAYG user tries to start trial checkout | Request rejected |
| pre user translates: skip-only request | `billableChars=0`, no chars deducted |
| pre user translates: mix of cache hits and new | Only billable chars deducted |
| Subscription canceled while subscription_id=NULL | Revocation still fires |

---

## Data Model Changes

No new columns required. Behavioral changes only in existing functions and endpoint handlers.

The field `chars_used_at_payg_start` remains but its semantics become single-purpose after BUG-02 fix:
> "Snapshot of `trial_chars_used` taken when PAYG plan was activated. Used to compute `payg_chars_used = trial_chars_used - chars_used_at_payg_start`."

For pre-plan users this field is still set (as a side effect of `updateUserPlanStatus`), but it's unused for pre-plan logic and reset correctly by `activatePaygPlan` when going pre→payg.
