# Technical Specification: Free Plan Migration

## Complexity Assessment
**Medium** — Multiple coordinated changes across `db.js` and `index.js`, a DB schema migration, a new per-user monthly reset mechanism, and several logic touch points in the translate pipeline.

---

## Technical Context

- **Language/Runtime**: Node.js (CommonJS)
- **Framework**: Express
- **Database**: PostgreSQL via `pg` Pool
- **Key dependencies**: `jsonwebtoken`, `bcrypt`, `stripe`, `axios`
- **Files to modify**: `db.js`, `index.js`
- **No new files needed**

---

## Current State Summary

| Concern | Current behavior |
|---|---|
| `plan_status` for new signups | `null` (no plan set at signup) |
| Old free-trial flow | `"trialing"` via Stripe, 10,000 char limit |
| `/auth/signup` response | `hasAccess: false`, no plan fields |
| `/translate` access gate | Only `"trialing"` or `"active"` pass |
| Char tracking in `/translate` | Only for `plan_status === "trialing"` |
| `trial_chars_limit` default | `10000` (hardcoded in `updateUserTrialStart` and fallbacks) |
| Monthly per-user char reset | None |

---

## Implementation Approach

### 1. Database — `db.js`

#### `initDatabase()` — add migrations
Run at startup (idempotent):

1. Add `free_chars_reset_date DATE` column to `users` if missing.
2. Migrate existing `"trialing"` users to `"free"`:
   ```sql
   UPDATE users
   SET plan_status = 'free',
       trial_chars_limit = 25000,
       free_chars_reset_date = COALESCE(free_chars_reset_date, DATE_TRUNC('month', NOW()) + INTERVAL '1 month')
   WHERE plan_status = 'trialing';
   ```
3. Seed `free_chars_reset_date` for any existing free-plan users that don't have it set.

#### `createUser()` — set free plan at creation
Change the `INSERT` to also set:
```sql
plan_status = 'free',
has_access = TRUE,
trial_chars_limit = 25000,
trial_chars_used = 0,
free_chars_reset_date = DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
```

#### New function: `resetFreeUserCharsIfNeeded(userId)`
Called lazily from `/translate` and `/me` before reading char counts.

- Query user's `free_chars_reset_date`.
- If today >= `free_chars_reset_date`:
  - Reset `trial_chars_used = 0`
  - Set `free_chars_reset_date = DATE_TRUNC('month', NOW()) + INTERVAL '1 month'`
  - Return updated row.
- Else return null (no reset needed).

This mirrors the existing `resetUsageIfNeeded()` pattern for the global usage table.

#### `updateUserTrialStart()` — update limit default
Change hardcoded `trial_chars_limit = 10000` to `25000` for consistency (legacy Stripe trial path).

#### `getUserById` / `getUserByEmail`
Add `free_chars_reset_date` to the SELECT column list so it's available in application logic.

---

### 2. API — `index.js`

#### `userHasActiveSubscription(userId)`
Add `"free"` as an access-granting plan status:
```js
if (user && (user.has_access === true || user.plan_status === 'free')) return true;
```

#### `POST /auth/signup`
After `createUser()`:
- Remove the Stripe customer creation requirement guard (`if (!stripe) return 503`) — signup no longer requires Stripe.
- Still create a Stripe customer if `stripe` is configured (for future upgrade path), but don't block if not.
- Return:
  ```json
  {
    "token": "...",
    "user": { "id": "...", "email": "..." },
    "hasAccess": true,
    "plan_status": "free",
    "trial_chars_used": 0,
    "trial_chars_limit": 25000
  }
  ```

#### `GET /me`
Before returning:
1. Call `resetFreeUserCharsIfNeeded(req.userId)` if `user.plan_status === "free"`.
2. Return `hasAccess: true` for `"free"` plan users.
3. Change fallback `trial_chars_limit ?? 10000` → `?? 25000`.

#### `POST /translate`
**Access gate** (currently blocks non-trialing/non-active):
```js
// OLD:
if (user.plan_status !== "trialing" && user.plan_status !== "active") { 402 }

// NEW:
if (!["free", "trialing", "active"].includes(user.plan_status)) { 402 }
```

**Char exhaustion check** — extend from only `"trialing"` to also `"free"`:
```js
if (user && (user.plan_status === "free" || user.plan_status === "trialing")) {
  // Call resetFreeUserCharsIfNeeded first for "free" users
  // Then check charsUsed >= charsLimit
  // Return trial_exhausted if exceeded
}
```
For `"free"` users, return exhaustion error but do NOT cancel a Stripe subscription (that logic only applies to `"trialing"`).

**Char increment after translation** — extend to `"free"` plan:
```js
if (user && (user.plan_status === "free" || user.plan_status === "trialing")) {
  const updatedUser = await incrementUserTrialChars(req.userId, totalChars);
  // Only attempt to end Stripe trial if plan_status === "trialing"
  if (user.plan_status === "trialing" && stripe && updatedUser.subscription_id && ...) {
    await stripe.subscriptions.update(...)
  }
  return res.json({ translations, trial_chars_used: ..., trial_chars_limit: ... });
}
```

**Monthly reset** — call `resetFreeUserCharsIfNeeded(req.userId)` at the start of the free-user char check block (before reading `user.trial_chars_used`). Re-fetch the user after reset if needed.

#### `POST /billing/verify-session` — fix stale default
Change `trial_chars_limit: 10000` fallback → `25000`.

---

## Data Model Changes

### `users` table — new column
```sql
ALTER TABLE users ADD COLUMN free_chars_reset_date DATE;
```
Added in `initDatabase()` with idempotency guard.

### `users` table — `createUser` defaults
The INSERT will now set `plan_status`, `has_access`, `trial_chars_limit`, `trial_chars_used`, and `free_chars_reset_date` directly rather than relying on column defaults.

### No new tables required.

---

## API Changes Summary

| Endpoint | Change |
|---|---|
| `POST /auth/signup` | Returns `hasAccess: true`, `plan_status: "free"`, `trial_chars_used: 0`, `trial_chars_limit: 25000`; Stripe no longer blocks signup |
| `GET /me` | Returns free-plan fields; triggers lazy monthly reset |
| `POST /translate` | Allows `"free"` plan; tracks chars; resets monthly; no Stripe trial cancel for free users |
| `GET /billing/verify-session` | Fixes `trial_chars_limit` fallback from 10000 → 25000 |

---

## Verification

1. **Startup migration**: On server start, existing `"trialing"` users are migrated to `"free"` with `trial_chars_limit = 25000` and a `free_chars_reset_date` set to next month's first day.
2. **New signup**: POST `/auth/signup` → response contains `hasAccess: true`, `plan_status: "free"`, `trial_chars_limit: 25000`.
3. **Translation access**: A new free-plan user can successfully call `/translate`.
4. **Char tracking**: After translation, `trial_chars_used` increments; response includes updated counts.
5. **Exhaustion**: When `trial_chars_used >= 25000`, `/translate` returns `{ error: "trial_exhausted" }` with 402.
6. **Monthly reset**: Manually set `free_chars_reset_date` to yesterday in DB; next `/translate` or `/me` call resets `trial_chars_used` to 0 and re-enables access.
7. **Active users**: Paid users (`plan_status: "active"`) still get unlimited translations with no char tracking.
8. **Global quota**: The `MONTHLY_CHAR_LIMIT` 95% threshold check remains unchanged — applies to all users.
9. **Run**: `node index.js` — no lint/typecheck tooling configured in `package.json`.
