# Technical Specification: Proactive Character Usage Reset

## Complexity Assessment

**Medium** — The root cause is clear and isolated. The fix is a small, well-scoped addition (one new DB function + one scheduler call). There are no architectural changes required and no new dependencies.

---

## Technical Context

- **Language**: Node.js (CommonJS)
- **Framework**: Express
- **Database**: PostgreSQL via Supabase (`pg` pool)
- **Key files**: `db.js` (data layer), `index.js` (server / routes)

### Relevant data model columns (table: `users`)

| Column | Type | Purpose |
|---|---|---|
| `trial_chars_used` | INTEGER | Running total of chars consumed (all plan types) |
| `chars_used_at_payg_start` | INTEGER | Baseline snapshot when PAYG plan activated; `payg_chars_used = trial_chars_used - chars_used_at_payg_start` |
| `free_chars_reset_date` | DATE | The date on or after which both counters should be reset to 0 |
| `plan_status` | VARCHAR | `'free'` / `'pre'` / `'payg'` |

---

## Root Cause

`resetUserCharsIfNeeded(userId)` in `db.js` (line 941) is a **lazy, per-request reset**. It executes only when a specific user makes an API call to `/me`, `/translate`, `/dictionary`, or `/tts`. Users who have not made any request since their `free_chars_reset_date` passed are never reset, leaving stale past dates visible in Supabase.

For PAYG users the lazy reset logic is correct (no plan_status filter prevents it from firing), but PAYG users can also go inactive and therefore never receive the reset.

There is **no proactive, scheduled mechanism** that sweeps all users with an overdue `free_chars_reset_date`.

---

## Implementation Approach

Add a **scheduled batch reset** that runs inside the server process on a fixed interval. This complements — but does not remove — the existing lazy per-user reset.

### New function: `resetAllUsersCharsIfNeeded()` in `db.js`

Executes a single bulk UPDATE:

```sql
UPDATE users
SET trial_chars_used        = 0,
    chars_used_at_payg_start = 0,
    free_chars_reset_date   = (NOW() + INTERVAL '30 days')::DATE
WHERE free_chars_reset_date IS NOT NULL
  AND free_chars_reset_date <= CURRENT_DATE
RETURNING id, plan_status
```

- Targets **all plan types** (free, pre, payg) — no plan_status filter needed.
- For PAYG users after reset: `payg_chars_used = trial_chars_used - chars_used_at_payg_start = 0 - 0 = 0`. This is correct.
- Returns the list of affected rows for logging.
- Is idempotent: running it multiple times in the same day is safe because `free_chars_reset_date` is advanced 30 days on the first run, so subsequent runs within the same period produce zero rows.

### Scheduler in `index.js`

Inside `startServer()`, alongside the existing `setInterval` meter-drainer, add a second `setInterval` that calls `resetAllUsersCharsIfNeeded()` every **30 minutes**. On server start, call it once immediately (without waiting for the first interval) to catch any users whose reset date passed while the server was offline.

---

## Source Code Changes

### `db.js`
- **Add** `async function resetAllUsersCharsIfNeeded()` after the existing `resetUserCharsIfNeeded` function.
- **Export** it in the `module.exports` object at the bottom of the file.

### `index.js`
- **Import** `resetAllUsersCharsIfNeeded` from `./db` in the destructured require at the top.
- In `startServer()`, after `initDatabase()` completes and the server starts listening, add:
  1. An immediate call `resetAllUsersCharsIfNeeded()` (fire-and-forget, catches up on any missed resets).
  2. A `setInterval(() => resetAllUsersCharsIfNeeded(), 30 * 60 * 1000)` to run every 30 minutes.

No other files need to change. The existing lazy `resetUserCharsIfNeeded` calls on individual endpoints are correct and can remain as-is (they provide an immediate in-request guarantee before incrementing chars).

---

## Data Model / API / Interface Changes

None. No new columns, no new endpoints, no schema migrations. Existing Supabase columns are sufficient.

---

## Verification Approach

1. **Manual DB check**: After deploying, query Supabase for users where `free_chars_reset_date < CURRENT_DATE`. The count should drop to 0 within the first scheduler run.
2. **Log inspection**: The new function should log how many users were reset on each run (e.g., `[char-reset] reset N users`). Verify the log appears at startup and every 30 minutes.
3. **Lint**: Run `npm run lint` (or equivalent, if configured) to confirm no style issues.
4. **Smoke test**: Manually set a test user's `free_chars_reset_date` to yesterday in Supabase, then wait for the next scheduler tick (or restart the server) and confirm the date advances and `trial_chars_used` / `chars_used_at_payg_start` become 0.
