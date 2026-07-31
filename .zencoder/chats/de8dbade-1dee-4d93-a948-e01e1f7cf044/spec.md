# Technical Specification: Character Usage Not Reflecting in Sidebar

## Bug Summary

**Reported**: Frontend sidebar shows "Free plan: 0 / 15,000 characters used" while Supabase (DB) has `trial_chars_used = 15000` and `trial_chars_limit = 15000`.

**Difficulty**: Medium — involves tracing data flow across multiple API endpoints, a side-effectful reset mechanism, and potential frontend caching of stale values.

---

## Technical Context

- **Language / Runtime**: Node.js (Express)
- **Database**: PostgreSQL via Supabase (connection via `pg` pool in `.\db.js`)
- **Key Table**: `users` — stores `trial_chars_used` (INTEGER), `trial_chars_limit` (INTEGER, default 15000 for free plan), `free_chars_reset_date` (DATE)
- **Constants**: `FREE_PLAN_LIMIT = 15000` (hardcoded in both `.\db.js:22` and `.\index.js:20`)

---

## Architecture: How Character Usage Flows

### Storage
Usage is stored per-user in the `users` table:
- `trial_chars_used`: characters consumed in the current window
- `trial_chars_limit`: max allowed (15000 for free plan)
- `free_chars_reset_date`: DATE after which `trial_chars_used` resets to 0

### Increment Path
When a translation is processed (`POST /translate`, `.\index.js:1713`):
1. `atomicCheckAndIncrementChars(userId, billableChars)` is called (`.\db.js:823`)
2. SQL atomically increments `trial_chars_used` only if `trial_chars_used + chars <= trial_chars_limit`
3. If the condition fails (`rowCount == 0`), returns `{ allowed: false }` → 402 `FREE_LIMIT_REACHED`
4. If it succeeds, returns `{ allowed: true, user: { trial_chars_used, trial_chars_limit, ... } }`
5. The translate response for free/pre users includes `trial_chars_used` and `trial_chars_limit`

### Reset Path (CRITICAL)
`resetUserCharsIfNeeded(userId)` in `.\db.js:951`:
- Reads `free_chars_reset_date` from DB
- If `new Date() >= new Date(free_chars_reset_date)`: resets `trial_chars_used = 0`, extends date +30 days
- Returns the updated row if reset occurred, `null` otherwise

**This reset is called in TWO places:**
1. `GET /me` (`.\index.js:1136`) — for all free/pre/payg users on every sidebar poll
2. `POST /translate` (`.\index.js:1714`) — before attempting to bill chars

### Sidebar Data Source (API Endpoints)

| Endpoint | Returns `trial_chars_used`? | Reset before returning? |
|---|---|---|
| `POST /auth/login` | ✅ Yes (from DB at login time) | ❌ No |
| `POST /auth/signup` | ✅ Yes (hardcoded `0`) | ❌ No |
| `GET /me` | ✅ Yes (fresh DB read) | ✅ **Yes** — calls `resetUserCharsIfNeeded` first |
| `POST /translate` (free) | ✅ Yes (from `atomicCheckAndIncrementChars`) | ✅ Yes — calls `resetUserCharsIfNeeded` first |
| `GET /debug/me` | ✅ Yes (raw DB read) | ❌ No |

---

## Root Cause Analysis

### Cause A (Most Likely): Frontend uses stale login/signup response

The `POST /auth/login` response (`.\index.js:959`) returns:
```json
{
  "token": "...",
  "user": { "id": ..., "email": "..." },
  "trial_chars_used": 0,
  "trial_chars_limit": 15000
}
```

If the frontend stores this in local storage or component state and never refreshes it by calling `GET /me`, the sidebar will always show the value captured at login time (`0/15000`) regardless of how many translations the user performs.

**Why this fits the symptoms**:
- User logs in (0 chars used) → sidebar reads `trial_chars_used: 0` from login response
- User makes translations → DB updates to 15000
- Sidebar still shows 0/15000 because it's reading from cached login response
- Supabase correctly shows 15000/15000

### Cause B: `/me` reset silently wipes usage before returning

If the user's `free_chars_reset_date` has passed (e.g., account is 30+ days old), every call to `GET /me` triggers `resetUserCharsIfNeeded`, which:
1. Sets `trial_chars_used = 0` in the DB
2. Returns `trial_chars_used: 0` to the frontend

**Why this fits the symptoms**:
- Before calling `/me`: DB shows 15000 → user checks Supabase and sees 15000
- After calling `/me`: reset fires → DB now shows 0, `/me` returns 0
- Sidebar shows 0/15000 immediately after the `/me` call
- If user re-checks Supabase after this, they'd see 0 (but user checked BEFORE)

### Cause C: Translate response not consumed by frontend

The `POST /translate` response for free users includes:
```json
{
  "translations": [...],
  "trial_chars_used": 15000,
  "trial_chars_limit": 15000
}
```
If the frontend ignores `trial_chars_used` / `trial_chars_limit` from translate responses and only updates the sidebar from `/me` calls, the sidebar may be stale between explicit refresh calls.

---

## Identified Backend Issues

### Issue 1: `GET /me` has a destructive side effect (reset)

`GET /me` is designed to be a read endpoint (sidebar data fetch), but it silently resets `trial_chars_used` to 0 if the billing window has passed (`.\index.js:1136-1140`). This is a side effect on a GET endpoint that the frontend can't distinguish from "user has 0 chars used" vs "reset just happened."

**Impact**: After a reset, the sidebar correctly shows 0, but there's no signal to the frontend that a reset occurred (no `chars_reset: true` field or similar). If the frontend shows 0 and the user has just been reset, they may think their usage wasn't tracked.

### Issue 2: Login response returns DB value without reset check

`POST /auth/login` (`.\index.js:959`) reads `trial_chars_used` directly from `getUserByEmail` without calling `resetUserCharsIfNeeded`. So if a user logs in after their billing window has expired:
- Login response returns the pre-reset value (e.g., 15000)
- Next `/me` call triggers the reset and returns 0
- Sidebar flickers: shows 15000 at login, then 0 on next poll

### Issue 3: `POST /auth/signup` hardcodes `trial_chars_used: 0`

The signup response (`.\index.js:926`) hardcodes 0 instead of reading from the newly created DB row. This is technically correct (new user always starts at 0) but is inconsistent with the login pattern. Not a bug, just a note.

---

## Files to Modify

| File | Change |
|---|---|
| `.\index.js` | Fix `GET /me` to return `chars_reset` flag; fix login to call reset before returning; add a read-only usage field |
| `.\db.js` | Possibly: extract reset logic into its own function with clearer semantics |

---

## Implementation Approach

### Fix 1: Add `chars_reset` flag to `/me` response

In `.\index.js` at the `/me` handler, after calling `resetUserCharsIfNeeded`:
- If a reset occurred, include `chars_reset: true` in the response
- This lets the frontend know the 0 is from a billing window reset, not from missing data

```js
// Proposed change in /me handler (.\index.js ~1136-1140)
let charsReset = false;
if (["free", "pre", "payg"].includes(user.plan_status)) {
  const reset = await resetUserCharsIfNeeded(req.userId);
  if (reset) {
    user = await getUserById(req.userId);
    charsReset = true;
  }
}
// Then add to meResponse:
// chars_reset: charsReset,
```

### Fix 2: Ensure login response also triggers reset check

In `.\index.js` at `POST /auth/login` (~line 953), call `resetUserCharsIfNeeded(user.id)` after fetching the user and before building the response. If reset occurred, re-fetch the user so the login response contains the accurate post-reset values.

```js
// After: const user = await getUserByEmail(email);
// Add:
if (["free", "pre", "payg"].includes(user.plan_status)) {
  const reset = await resetUserCharsIfNeeded(user.id);
  if (reset) {
    user = await getUserById(user.id);
  }
}
```

This ensures the login response always reflects the current billing window, not a stale window.

### Fix 3 (Optional / Diagnostic): Add `/user/usage` read-only endpoint

A new `GET /user/usage` endpoint that reads `trial_chars_used`, `trial_chars_limit`, and `free_chars_reset_date` **without** triggering any resets. This gives the frontend a reliable, side-effect-free way to poll usage.

---

## Data Model / API Changes

No schema changes required. The `users` table already has all needed columns.

**API Response changes:**

`GET /me` response additions:
```json
{
  "trial_chars_used": 0,
  "trial_chars_limit": 15000,
  "chars_reset": true,
  "free_chars_reset_date": "2025-06-23"
}
```

`POST /auth/login` response (behavior change only, same fields):
- `trial_chars_used` will now reflect the post-reset value if the billing window has expired at login time

---

## Verification Approach

1. **Manual test — Reset during login**:
   - Set a test user's `free_chars_reset_date` to yesterday in Supabase
   - Set `trial_chars_used = 15000`
   - Call `POST /auth/login` → verify response contains `trial_chars_used: 0` (after fix)
   - Verify Supabase DB shows `trial_chars_used: 0` and new `free_chars_reset_date`

2. **Manual test — /me reflects current DB value**:
   - Set `trial_chars_used = 7500`, `free_chars_reset_date = future date`
   - Call `GET /me` → verify `trial_chars_used: 7500` returned
   - Verify no DB change occurred (no reset triggered)

3. **Manual test — Reset flag**:
   - Set `free_chars_reset_date = yesterday`, `trial_chars_used = 15000`
   - Call `GET /me` → verify `chars_reset: true` and `trial_chars_used: 0` in response

4. **Lint**: `npm run lint` (if available) or visual inspection of changed handlers

---

## Open Questions

1. **Is the frontend calling `GET /me` on every sidebar render?** If not, all backend fixes are secondary to the frontend needing to poll `/me`. The backend changes above are still improvements but the sidebar bug may be entirely on the frontend side.

2. **Is the frontend reading `trial_chars_used` from the login response and storing it in local storage?** If yes, Fix 2 (reset check in login) becomes critical.

3. **What is the current `free_chars_reset_date` for the affected user?** If it's in the past, Cause B (reset in `/me`) is the active bug right now.
