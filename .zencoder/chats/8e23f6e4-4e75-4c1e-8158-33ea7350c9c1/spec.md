# Technical Specification: Subscription/Plan Lifecycle Correctness Audit (Round 3)

## Technical Context

- **Language**: Node.js (CommonJS)
- **Framework**: Express.js
- **Database**: PostgreSQL via `pg` (Pool)
- **Payment**: Stripe (subscriptions, webhooks, checkout sessions)
- **Auth**: JWT (jsonwebtoken), bcrypt

## DB State Model (users table)

| Column | Meaning |
|---|---|
| `plan_status` | `null` (fresh), `'trialing'`, `'active'`, `'canceled'`, `'past_due'`, `'unpaid'` |
| `has_access` | Boolean gate for translation access |
| `subscription_id` | Stripe subscription ID of the user's **current** subscription |
| `trial_chars_used` | Characters consumed during trial |
| `trial_chars_limit` | Max trial characters (default 10000) |
| `trial_started_at` | When trial began |
| `trial_converted_at` | When trial converted to paid |

## Key DB Functions

| Function | Effect |
|---|---|
| `updateUserTrialStart(userId, subId)` | Sets `plan_status='trialing'`, `has_access=true`, resets `trial_chars_used=0`, sets `subscription_id` |
| `updateUserPlanStatus(userId, status, hasAccess, convertedAt, subId?)` | Sets plan_status, has_access, trial_converted_at. Uses `COALESCE(subId, subscription_id)` so null subId preserves old value |
| `cancelUserSubscription(userId)` | Sets `plan_status='canceled'`, `has_access=false`. Does NOT clear `subscription_id` |
| `createSubscription(...)` | INSERT with `ON CONFLICT (stripe_subscription_id) DO UPDATE` — idempotent |

---

## Scenario-by-Scenario Audit

### 1. Fresh user starts trial — CORRECT

- `/start-trial`: `plan_status` is null → passes guard
- Creates Stripe subscription (status='trialing'), calls `createSubscription` + `updateUserTrialStart`
- Webhook `customer.subscription.created` fires: no userId in subscription metadata (see Issue #3), so webhook handler is a no-op. Harmless because `/start-trial` already handled everything synchronously.

### 2. Trialing user upgrades to paid mid-trial — BUG FOUND (Issue #1)

- `/billing/create-checkout-session`: plan_status='trialing' ≠ 'active' → passes guard
- User completes checkout → `checkout.session.completed` fires:
  - Fetches old `subscription_id` (= trial sub), updates to new sub, cancels old trial sub via Stripe ✓
- **Problem**: Canceling the old trial sub triggers `customer.subscription.updated` with status='canceled' for the OLD subscription. The `updated` handler has NO guard checking whether the subscription is the user's current one — it unconditionally calls `updateUserPlanStatus(userId, 'canceled', false, null)`, revoking access.
- The `customer.subscription.deleted` handler correctly has this guard, but `updated` does not.
- **Net effect**: User who upgrades can temporarily or permanently lose access depending on webhook ordering.

### 3. Active user tries to start trial — CORRECT

- `/start-trial` guard: `plan_status in ['trialing', 'active', 'canceled']` → blocked ✓
- `/billing/create-trial-checkout-session`: same guard → blocked ✓

### 4. Active user tries to create checkout — CORRECT

- `/billing/create-checkout-session` guard: `plan_status === 'active'` → blocked ✓

### 5. Canceled user tries to start trial — CORRECT

- `/start-trial` guard: plan_status='canceled' → blocked ✓
- `/billing/create-trial-checkout-session`: same guard → blocked ✓

### 6. Canceled user re-subscribes via premium checkout — CORRECT

- `/billing/create-checkout-session`: plan_status='canceled' ≠ 'active' → passes ✓
- `checkout.session.completed` fires: sets plan_status='active', has_access=true
- Tries to cancel old subscription (already canceled) — caught by try/catch ✓

### 7. Trial expires naturally (payment succeeds → active) — CORRECT

- Stripe transitions subscription from 'trialing' to 'active'
- `customer.subscription.updated` fires with status='active'
- Handler calls `updateUserPlanStatus(userId, 'active', true, new Date(), subscription.id)` ✓
- `subscription.id` matches `user.subscription_id` ✓

### 8. Trial expires (no payment method → canceled) — CORRECT

- Stripe cancels subscription
- `customer.subscription.deleted` fires
- Handler checks `user.subscription_id === subscription.id` → matches → revokes access ✓

### 9. Active user cancels — CORRECT

- `/cancel-subscription`: cancels via Stripe, then `cancelUserSubscription(userId)` → plan_status='canceled', has_access=false
- `customer.subscription.deleted` webhook: `user.subscription_id === subscription.id` → calls `updateUserPlanStatus` again (redundant but idempotent) ✓

### 10. Payment fails → past_due — CORRECT (with caveat from Issue #1)

- `customer.subscription.updated` fires with status='past_due'
- Handler revokes access: `updateUserPlanStatus(userId, 'past_due', false, null)` ✓
- If payment recovers, `updated` fires with status='active' → restores access ✓
- Caveat: the missing subscription_id guard (Issue #1) is only a problem when a DIFFERENT subscription goes past_due, which is unlikely in this scenario.

### 11. Webhook arrives out of order — MOSTLY CORRECT

- `createSubscription` uses ON CONFLICT → idempotent ✓
- `updateUserTrialStart` / `updateUserPlanStatus` are last-write-wins, but set the same values for the same event → OK
- Edge case: `customer.subscription.deleted` (old sub) arrives before `checkout.session.completed` (new sub) → temporarily revokes access, then `checkout.session.completed` restores it. Eventually consistent ✓

### 12. Same webhook fires twice (idempotency) — MOSTLY CORRECT

- `createSubscription` ON CONFLICT → idempotent ✓
- `updateUserPlanStatus` → idempotent ✓
- **Caveat**: `updateUserTrialStart` resets `trial_chars_used=0` every time it's called. If a duplicate `customer.subscription.created` webhook fires after user has used some trial chars, it resets the counter. See Issue #2.

---

## Issues Found

### Issue #1 (MEDIUM-HIGH): `customer.subscription.updated` handler missing subscription_id guard

**Location**: `index.js` lines 191-193 (the `canceled`/`unpaid`/`past_due` branch in `customer.subscription.updated`)

**Problem**: When a user upgrades from trial to paid, the old trial subscription gets canceled by Stripe. This triggers `customer.subscription.updated` with `status='canceled'` for the OLD subscription. The handler unconditionally revokes the user's access without checking whether the updated subscription is the user's current one.

The `customer.subscription.deleted` handler already has this guard (line 206-208):
```js
if (currentUser && currentUser.subscription_id === subscription.id) {
```
But the `updated` handler does not.

**Fix**: Add the same guard to the `updated` handler's revocation branch:
```js
} else if (["canceled", "unpaid", "past_due"].includes(subscription.status)) {
    const currentUser = await getUserById(subRow.user_id);
    if (currentUser && currentUser.subscription_id === subscription.id) {
        await updateUserPlanStatus(subRow.user_id, subscription.status, false, null);
        console.log(`User ${subRow.user_id} access revoked, status: ${subscription.status}`);
    } else {
        console.log(`Skipping revoke for user ${subRow.user_id}: current sub ${currentUser?.subscription_id} differs from updated sub ${subscription.id}`);
    }
}
```

**Files to modify**: `index.js` lines ~191-194

---

### Issue #2 (LOW): `updateUserTrialStart` unconditionally resets trial_chars_used

**Location**: `db.js` lines 499-523

**Problem**: `updateUserTrialStart` always sets `trial_chars_used = 0`. If a webhook fires after the user has already started translating (or fires twice), the trial character counter resets. This could allow a user to get slightly more than 10,000 free characters.

**Affected scenarios**: Duplicate `customer.subscription.created` webhook; `/billing/verify-session` called after webhook already processed.

**Fix**: Only reset trial if user is not already trialing on this same subscription:
```js
UPDATE users
SET plan_status = 'trialing',
    trial_chars_used = CASE WHEN subscription_id = $1 THEN trial_chars_used ELSE 0 END,
    trial_chars_limit = 10000,
    trial_started_at = CASE WHEN subscription_id = $1 THEN trial_started_at ELSE NOW() END,
    subscription_id = $1,
    has_access = TRUE
WHERE id = $2
```

**Files to modify**: `db.js` `updateUserTrialStart` function

---

### Issue #3 (LOW): `/start-trial` doesn't set userId metadata on Stripe subscription

**Location**: `index.js` lines 460-477

**Problem**: When creating a subscription via `/start-trial`, no `metadata: { userId }` is set on the Stripe subscription object. This means if `customer.subscription.created` fires, the webhook handler can't find the userId and becomes a no-op. Currently harmless because `/start-trial` handles everything synchronously, but it means the webhook can't act as a fallback if the API response fails after creating the Stripe subscription.

**Fix**: Add metadata to `subParams`:
```js
const subParams = {
    customer: user.stripe_customer_id,
    items: [{ price: process.env.STRIPE_PRICE_ID }],
    trial_end: trialEndTimestamp,
    metadata: { userId: userId.toString() },
    // ...
};
```

**Files to modify**: `index.js` line ~460

---

### Issue #4 (LOW): Race condition in `/start-trial` — no concurrency guard

**Location**: `index.js` lines 391-511

**Problem**: Two concurrent `/start-trial` requests for the same user could both pass the `plan_status` guard check and each create a separate Stripe subscription. The second `updateUserTrialStart` overwrites the first, leaving an orphaned Stripe subscription.

**Practical risk**: Low — requires exact timing and same user double-clicking.

**Fix options**:
- Add `SELECT ... FOR UPDATE` in the guard check (requires a transaction)
- Accept as low-risk and rely on Stripe dashboard cleanup
- Add a unique constraint or advisory lock

---

## What Is Already Correct

1. `checkout.session.completed` correctly fetches old subscription_id before update and cancels old sub
2. `customer.subscription.deleted` correctly guards with `subscription_id === subscription.id` before revoking
3. `customer.subscription.updated` correctly checks `previous_attributes.status` before resetting trial
4. All trial-start endpoints block `plan_status in ['trialing', 'active', 'canceled']` — one trial per user ever
5. `createSubscription` is idempotent via ON CONFLICT
6. `updateUserPlanStatus` uses COALESCE for optional subscriptionId — correct
7. `/billing/create-checkout-session` blocks active users
8. `/billing/verify-session` is idempotent and safe as a fallback for webhook delays
9. Translation access checks (`has_access` + `plan_status`) are correct
10. Trial char limit enforcement and early trial termination via Stripe API work correctly

## Verification Approach

After fixes are applied:
1. Unit test: simulate `customer.subscription.updated` with status='canceled' for a non-current subscription → user should retain access
2. Unit test: simulate duplicate `customer.subscription.created` → trial_chars_used should not reset if already trialing on same sub
3. Manual test: upgrade flow (trial → paid) end-to-end with Stripe test mode
4. Run existing linter/tests if available

## Source Code Structure Changes

| File | Change |
|---|---|
| `index.js` | Add subscription_id guard to `customer.subscription.updated` revocation branch (~line 191) |
| `index.js` | Add `metadata: { userId }` to `/start-trial` subscription params (~line 460) |
| `db.js` | Make `updateUserTrialStart` idempotent — don't reset chars if already trialing on same sub |

## Difficulty Assessment

**Easy-Medium**: The fixes are surgical — adding a guard condition, adding a metadata field, and making one SQL query conditional. No architectural changes needed.
