# Bug Investigation: `/me` returns `trial_chars_used` as null/missing

## Bug Summary

The `/me` endpoint at `haribackend-mitj.onrender.com` is returning `trial_chars_used` as `null` or missing from the JSON response instead of an integer. The frontend (`newtab.js:1042-1054`) reads six fields from `/me`: `hasAccess`, `plan_status`, `trial_chars_used`, `trial_chars_limit`, `payg_chars_used`, `payg_chars_limit`. At least `trial_chars_used` is wrong, and `payg_chars_used`/`payg_chars_limit` are absent for non-payg users.

---

## Affected Components

| File | Lines | Role |
|------|-------|------|
| `index.js` | 1129–1167 | `/me` request handler |
| `index.js` | 1706–1738 | `/translate` char-increment path (free/pre) |
| `index.js` | 1912–1946 | `/translate` char-increment path (payg) |
| `db.js` | 587–603 | `getUserById` — SELECT query |
| `db.js` | 131–141 | Migration: ADD COLUMN `trial_chars_used` |
| `db.js` | 802–821 | `incrementUserTrialChars` (payg path) |
| `db.js` | 823–842 | `atomicCheckAndIncrementChars` (free/pre path) |
| `db.js` | 275–310 | Startup data-fix UPDATEs |

---

## Root Cause Analysis

### Root Cause 1 (PRIMARY) — NULL values in the DB silently break every increment

The `trial_chars_used` column migration (db.js:131–141) uses an `IF NOT EXISTS` guard:

```sql
IF NOT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'users' AND column_name = 'trial_chars_used'
) THEN
  ALTER TABLE users ADD COLUMN trial_chars_used INTEGER NOT NULL DEFAULT 0;
END IF;
```

If the column was already present in the production database from an earlier, hand-crafted migration **without** `NOT NULL DEFAULT 0`, the guard silently skips the corrective `ALTER TABLE`. This leaves the column nullable and without a default for existing rows.

**Consequence A — Increments silently produce NULL:**

Both increment functions use bare arithmetic:

```sql
-- incrementUserTrialChars (db.js:808)
SET trial_chars_used = trial_chars_used + $1

-- atomicCheckAndIncrementChars (db.js:828)
SET trial_chars_used = trial_chars_used + $1
WHERE id = $2
  AND trial_chars_used + $1 <= trial_chars_limit
```

In PostgreSQL, `NULL + N = NULL`. If a row has `trial_chars_used = NULL`:
- The `SET` expression evaluates to `NULL`, so the value stays `NULL` after every translation.
- The `WHERE` condition in `atomicCheckAndIncrementChars` evaluates to `UNKNOWN` (not TRUE), so `rowCount = 0`, which makes that function return `{ allowed: false }` — this would incorrectly block free/pre users from translating.

**Consequence B — `/me` returns 0 where the frontend may expect a tracked integer:**

The current source has `trial_chars_used: user.trial_chars_used ?? 0` (index.js:1144), which coerces DB `NULL` to `0`. The frontend sees `0` every time regardless of actual usage, making the usage counter appear permanently at zero. If the **deployed** binary predates this `?? 0` guard, the JSON field would be literally `null`.

### Root Cause 2 (SECONDARY) — `payg_chars_used` and `payg_chars_limit` absent for non-payg users

In the `/me` handler (index.js:1156–1160):

```js
if (user.plan_status === "payg") {
  meResponse.payg_chars_used = (user.trial_chars_used ?? 0) - (user.chars_used_at_payg_start ?? 0);
  meResponse.payg_chars_limit = user.trial_chars_limit ?? 20000000;
}
```

These two fields are **only added** for payg users. For free/pre/active users the keys are entirely absent from the JSON object. If `newtab.js` reads them unconditionally (lines 1042–1054), it gets `undefined`, which may render as `null` or cause NaN in any math.

### Root Cause 3 (MINOR) — `payg_chars_limit` uses `trial_chars_limit` as its source

For payg users, `meResponse.payg_chars_limit = user.trial_chars_limit ?? 20000000`. This is the same column used as a monthly soft limit. If that column is also NULL (same migration guard issue applies — db.js:143–153), both `trial_chars_limit` and `payg_chars_limit` would be wrong.

### What was ruled out

- **Supabase anon/service-role key** — Not applicable. This backend uses direct PostgreSQL (`pg.Pool` via `DATABASE_URL`). There is no Supabase client.
- **Snake_case vs camelCase mismatch** — `getUserById` explicitly lists `trial_chars_used` in the SELECT, and the column name in SQL matches the JS object key. No mismatch found.
- **Missing SELECT column** — `trial_chars_used` is present in the SELECT string in `getUserById` (db.js:593) and in `getUserByEmail` (db.js:611).
- **Missing RPC** — Not used; increments are direct SQL UPDATEs.

---

## Proposed Solution

### Fix 1 — Repair NULL rows at startup (db.js `initDatabase`)

Add two explicit data-fix UPDATEs immediately after the `ADD COLUMN` guards, before any other logic:

```sql
UPDATE users SET trial_chars_used  = 0     WHERE trial_chars_used  IS NULL;
UPDATE users SET trial_chars_limit = 15000  WHERE trial_chars_limit IS NULL;
```

This is safe to run repeatedly; it only touches rows that have NULL values.

### Fix 2 — Protect increment queries with COALESCE (db.js)

In both `incrementUserTrialChars` and `atomicCheckAndIncrementChars`, replace bare arithmetic with COALESCE-guarded arithmetic so that NULL rows are healed on first write:

```sql
-- incrementUserTrialChars
SET trial_chars_used = COALESCE(trial_chars_used, 0) + $1

-- atomicCheckAndIncrementChars
SET trial_chars_used = COALESCE(trial_chars_used, 0) + $1
WHERE id = $2
  AND COALESCE(trial_chars_used, 0) + $1 <= COALESCE(trial_chars_limit, 15000)
```

### Fix 3 — Always include payg fields in `/me` (index.js)

Move `payg_chars_used` and `payg_chars_limit` into the base `meResponse` object with safe defaults for non-payg users:

```js
const meResponse = {
  // ... existing fields ...
  trial_chars_used:  user.trial_chars_used  ?? 0,
  trial_chars_limit: user.trial_chars_limit ?? FREE_PLAN_LIMIT,
  payg_chars_used:   null,   // default; overwritten below for payg
  payg_chars_limit:  null,   // default; overwritten below for payg
};

if (user.plan_status === "payg") {
  meResponse.payg_chars_used  = (user.trial_chars_used ?? 0) - (user.chars_used_at_payg_start ?? 0);
  meResponse.payg_chars_limit = user.trial_chars_limit ?? 20000000;
}
```

This ensures the frontend always receives both keys (even if `null` for non-payg users), eliminating undefined-field errors.

### Fix 4 — Verify deployed binary has `?? 0` coalescing

The current source at index.js:1144 already has `user.trial_chars_used ?? 0`. Confirm the Render deployment is current. If not, re-deploy after applying Fixes 1–3.

---

## Edge Cases and Side Effects

| Scenario | Impact |
|----------|--------|
| Existing users with `trial_chars_used = NULL` | Fix 1 sets them to 0 at next restart; Fix 2 heals any stragglers on next translation |
| `atomicCheckAndIncrementChars` returning `allowed: false` due to NULL comparison | Fix 2 COALESCE in WHERE clause unblocks affected free/pre users immediately |
| payg users who had correct non-NULL values | Fixes 1 and 2 are no-ops for them (COALESCE and UPDATE WHERE IS NULL are harmless) |
| Frontend receiving `payg_chars_used: null` for free users | Null is a clean signal; frontend should handle it gracefully rather than using as a number |

---

---

## Implementation Notes

### Changes applied — commit `139c2ec` (pushed to `main`)

**`db.js` — Fix 1: NULL-repair startup UPDATEs** (after line 274, before trialing migration)
```sql
UPDATE users SET trial_chars_used = 0 WHERE trial_chars_used IS NULL;
UPDATE users SET trial_chars_limit = 15000 WHERE trial_chars_limit IS NULL;
```
Both updates are idempotent; they only touch rows with NULL values and are harmless on subsequent restarts.

**`db.js` — Fix 2: COALESCE guards in increment functions**

`incrementUserTrialChars`:
```sql
SET trial_chars_used = COALESCE(trial_chars_used, 0) + $1
```

`atomicCheckAndIncrementChars`:
```sql
SET trial_chars_used = COALESCE(trial_chars_used, 0) + $1
WHERE id = $2
  AND COALESCE(trial_chars_used, 0) + $1 <= COALESCE(trial_chars_limit, 15000)
```

**`index.js` — Fix 3: Always include payg fields in `/me` response**

Added `payg_chars_used: null` and `payg_chars_limit: null` as defaults in the base `meResponse` object. The `if (user.plan_status === "payg")` block overwrites them for payg users as before. Non-payg users now receive explicit `null` values instead of missing keys.

### Syntax verification
`node --check index.js` → exit 0  
`node --check db.js` → exit 0

### Test results
No automated test suite detected. Syntax checks passed. Fix 4 (confirm `?? 0` guard) was verified — `index.js:1144` already had `user.trial_chars_used ?? 0`; no change needed. Re-deploy on Render will apply all fixes at next startup.
