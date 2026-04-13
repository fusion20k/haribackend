# Technical Specification: Character Usage Integrity Across Plan Switches

## Complexity Assessment: **Medium**

Targeted surgical changes to 3 DB functions and 2 endpoint response blocks. No architectural overhaul needed. Edge cases exist around display vs. billing counts.

---

## Technical Context

- **Language**: Node.js (CommonJS)
- **DB**: PostgreSQL via `pg` Pool
- **Billing**: Stripe (subscriptions + Billing Meter Events for PAYG)
- **Key files**: `db.js`, `index.js`

---

## The Bug

### Root Cause

Three DB functions unconditionally reset `trial_chars_used = 0` and `free_chars_reset_date = NOW() + 30 days` whenever a user switches plans:

| Function | Resets chars? | Resets reset_date? |
|---|---|---|
| `activatePaygPlan()` | ✅ YES (BUG) | ✅ YES (BUG) |
| `cancelUserSubscription()` | ✅ YES (BUG) | ✅ YES (BUG) |
| `updateUserPlanStatus()` (pre plan) | ✅ YES (BUG) | ✅ YES (BUG) |

### Abuse Scenario Enabled

1. User signs up → `trial_chars_used=0`, `trial_chars_limit=25000`, `free_chars_reset_date=NOW()+30d`
2. Uses all 25k free chars → `trial_chars_used=25000` (blocked on free)
3. Upgrades to PAYG → `activatePaygPlan()` fires → **`trial_chars_used=0` (reset!)**, `free_chars_reset_date=NOW()+30d` (new 30-day window!)
4. Cancels PAYG → `cancelUserSubscription()` fires → **`trial_chars_used=0` (reset again!)**, `free_chars_reset_date=NOW()+30d`
5. Back on free with a **fresh 25k characters** — bypassing the original 30-day window entirely

---

## Correct Behaviour

- `free_chars_reset_date` anchors the user's **30-day billing cycle**. This date must only advance when the cycle **naturally expires** (handled correctly by `resetUserCharsIfNeeded()`).
- `trial_chars_used` is the total character count for the **current cycle** — it must persist across plan switches within the same cycle.
- The `resetUserCharsIfNeeded()` function already handles the legitimate cycle reset correctly and requires no changes.

### Verified Example (post-fix)

| Step | Action | trial_chars_used | free_chars_reset_date | Outcome |
|---|---|---|---|---|
| 1 | Sign up (free) | 0 | T+30d | 25k available |
| 2 | Use 20k chars | 20000 | T+30d | 5k remaining |
| 3 | Upgrade to PAYG | 20000 | T+30d (unchanged) | PAYG active, `chars_used_at_payg_start=20000` |
| 4 | Use 5k chars on PAYG | 25000 | T+30d | Billed via Stripe meter events |
| 5 | Cancel PAYG → free | **20000** (restored) | T+30d (unchanged) | 5k free chars remain (only free usage counts) |
| 6 | Cycle expires (T+30d) | 0 | T+60d | Fresh 25k available |

---

## Data Model Changes

### New Column: `chars_used_at_payg_start`

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS chars_used_at_payg_start INTEGER NOT NULL DEFAULT 0;
```

**Purpose**: Snapshot of `trial_chars_used` at the moment PAYG is activated. Used to display PAYG-specific usage (chars billed on PAYG only, not including prior free chars in the same cycle).

**Formula**: `payg_chars_used (display) = trial_chars_used - chars_used_at_payg_start`

This prevents the display from showing free-plan chars as PAYG-billed chars.

---

## Implementation Approach

### `db.js` — `activatePaygPlan(userId, subscriptionId, stripeItemId)`

**Current (broken)**:
```sql
SET plan_status = 'payg',
    has_access = TRUE,
    trial_chars_used = 0,                              -- BUG: resets cycle chars
    trial_chars_limit = 20000000,
    free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE,  -- BUG: resets cycle window
    subscription_id = $1,
    stripe_item_id = $2
```

**Fixed**:
```sql
SET plan_status = 'payg',
    has_access = TRUE,
    chars_used_at_payg_start = trial_chars_used,       -- snapshot before PAYG starts
    trial_chars_limit = 20000000,
    subscription_id = $1,
    stripe_item_id = $2
    -- trial_chars_used: NOT touched (preserved from free plan cycle)
    -- free_chars_reset_date: NOT touched (cycle window preserved)
```

Return `chars_used_at_payg_start` in the RETURNING clause.

---

### `db.js` — `cancelUserSubscription(userId)`

**Current (broken)**:
```sql
SET plan_status = 'free',
    has_access = TRUE,
    trial_chars_limit = 25000,
    trial_chars_used = 0,                              -- BUG: resets cycle chars
    free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE,  -- BUG: resets cycle window
    subscription_id = NULL,
    stripe_item_id = NULL
```

**Fixed**:
```sql
SET plan_status = 'free',
    has_access = TRUE,
    trial_chars_limit = 25000,
    trial_chars_used = chars_used_at_payg_start,       -- restore to pre-PAYG value (only free usage counts)
    chars_used_at_payg_start = 0,                      -- clear PAYG display baseline
    subscription_id = NULL,
    stripe_item_id = NULL
    -- free_chars_reset_date: NOT touched (cycle window preserved)
```

---

### `db.js` — `updateUserPlanStatus(userId, planStatus, ...)` (for `pre` plan upgrade)

**Current (broken)**:
```sql
SET trial_chars_limit = 1000000,
    trial_chars_used = CASE WHEN plan_status != 'pre' THEN 0 ELSE trial_chars_used END,    -- BUG
    free_chars_reset_date = CASE WHEN plan_status != 'pre' THEN (NOW() + INTERVAL '30 days')::DATE ELSE free_chars_reset_date END  -- BUG
```

**Fixed** (remove the resets, preserve cycle state):
```sql
SET trial_chars_limit = 1000000
    -- trial_chars_used: NOT touched
    -- free_chars_reset_date: NOT touched
```

---

### `db.js` — `getUserById` and `getUserByEmail`

Add `chars_used_at_payg_start` to the SELECT column list in both functions.

---

### `db.js` — `initDatabase()` schema migration

Add the new column migration block (idempotent):
```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'chars_used_at_payg_start'
  ) THEN
    ALTER TABLE users ADD COLUMN chars_used_at_payg_start INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;
```

---

### `index.js` — `/me` endpoint

**Current**:
```js
meResponse.payg_chars_used = user.trial_chars_used ?? 0;
```

**Fixed**:
```js
meResponse.payg_chars_used = (user.trial_chars_used ?? 0) - (user.chars_used_at_payg_start ?? 0);
```

---

### `index.js` — `/translate` endpoint (PAYG response block)

**Current**:
```js
const charsUsedBefore = user.trial_chars_used ?? 0;
const updatedCharsUsed = charsUsedBefore + totalChars;
// ...
payg_chars_used: updatedCharsUsed,
```

**Fixed**:
```js
const charsUsedBefore = user.trial_chars_used ?? 0;
const updatedCharsUsed = charsUsedBefore + totalChars;
const paygBaseline = user.chars_used_at_payg_start ?? 0;
// ...
payg_chars_used: updatedCharsUsed - paygBaseline,
```

Also fetch `freshUser.chars_used_at_payg_start` is already available via `freshUser` object (after the `getUserById` call within the endpoint).

---

### `index.js` — `/debug/me` endpoint

Add `chars_used_at_payg_start: user.chars_used_at_payg_start` to the debug response for visibility.

---

## What Is NOT Changed

| Component | Status | Reason |
|---|---|---|
| `resetUserCharsIfNeeded()` | Unchanged | Correctly resets chars when cycle expires |
| Stripe meter event reporting | Unchanged | Already charges only for PAYG-period chars |
| `incrementUserTrialChars()` | Unchanged | Works correctly for all plans |
| `trial_chars_limit` values | Unchanged | 25k (free), 1M (pre), 20M (payg) |
| Stripe subscription creation/cancellation | Unchanged | Billing flow unaffected |
| `free_chars_reset_date` in `resetUserCharsIfNeeded()` | Unchanged | Correct cycle reset mechanism |

---

## Source Code Files Modified

1. **`db.js`**:
   - `initDatabase()` — add `chars_used_at_payg_start` column migration
   - `getUserById()` — add column to SELECT
   - `getUserByEmail()` — add column to SELECT
   - `activatePaygPlan()` — fix reset bug, add snapshot
   - `cancelUserSubscription()` — fix reset bug
   - `updateUserPlanStatus()` — fix reset bug

2. **`index.js`**:
   - `/me` endpoint — fix `payg_chars_used` calculation
   - `/translate` endpoint — fix `payg_chars_used` in PAYG response
   - `/debug/me` endpoint — add `chars_used_at_payg_start` to debug info

---

## Verification Approach

- No automated tests present in the codebase — manual verification via the `/debug/me` endpoint
- After deployment: verify existing PAYG users have `chars_used_at_payg_start = 0` (correct, as default)
- Test scenario: sign up → exhaust free chars → upgrade to PAYG → cancel → confirm `trial_chars_used` not reset to 0
- Lint: `npm run lint` (if configured) or review for syntax errors manually
- Run `node -e "require('./db')"` to verify module loads without error
