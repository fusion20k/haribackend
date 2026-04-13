# Final Verification Report

## Module Load Check

| Command | Exit Code | Result |
|---|---|---|
| `node -e "require('./db.js')"` | 0 | PASS - Loads cleanly |
| `node -e "require('./index.js')"` | 0 | PASS - Loads cleanly |

---

## Code Review — All Changed Functions

### db.js — initDatabase()
PASS Correct. Idempotent DO IF NOT EXISTS migration block added at lines 213-223 for `chars_used_at_payg_start INTEGER NOT NULL DEFAULT 0`.

### db.js — getUserById() / getUserByEmail()
PASS Correct. Both SELECT queries include `chars_used_at_payg_start` in the column list (lines 439, 457).

### db.js — activatePaygPlan()
PASS Correct. The UPDATE now:
- Sets `chars_used_at_payg_start = trial_chars_used` (snapshot)
- Does NOT touch `trial_chars_used`
- Does NOT touch `free_chars_reset_date`
- Returns `chars_used_at_payg_start` in the RETURNING clause

### db.js — cancelUserSubscription()
PASS Correct. The UPDATE now:
- Sets `trial_chars_used = chars_used_at_payg_start` (restores pre-PAYG value)
- Sets `chars_used_at_payg_start = 0` (clears baseline)
- Does NOT touch `free_chars_reset_date`

### db.js — updateUserPlanStatus() (pre plan branch)
PASS Correct. The 'pre' branch UPDATE no longer touches `trial_chars_used` or `free_chars_reset_date`. Only `trial_chars_limit = 1000000` is changed (plus plan metadata).

### index.js — /me endpoint
PASS Correct. `payg_chars_used` is computed as:
```js
(user.trial_chars_used ?? 0) - (user.chars_used_at_payg_start ?? 0)
```

### index.js — /translate endpoint (PAYG block)
PASS Correct. `paygBaseline` is captured from `user.chars_used_at_payg_start ?? 0` and subtracted:
```js
payg_chars_used: updatedCharsUsed - paygBaseline
```

### index.js — /debug/me endpoint
PASS Correct. `chars_used_at_payg_start: user.chars_used_at_payg_start` is included in the debug response (line 305).

---

## Multi-Switch Scenario Trace (free -> PAYG -> free -> PAYG -> free)

| Step | Action | trial_chars_used | chars_used_at_payg_start | payg_chars_used | free_chars_reset_date | Result |
|---|---|---|---|---|---|---|
| 0 | Sign up | 0 | 0 | — | T+30d | 25k free available |
| 1 | Use 10k (free) | 10000 | 0 | — | T+30d | 15k remaining |
| 2 | Upgrade to PAYG | 10000 | 10000 | 0 | T+30d | Snapshot taken PASS |
| 3 | Use 5k (PAYG) | 15000 | 10000 | 5000 | T+30d | Billed via Stripe PASS |
| 4 | Cancel PAYG | 10000 | 0 | — | T+30d | Pre-PAYG chars restored, cycle window preserved PASS |
| 5 | Use 3k (free) | 13000 | 0 | — | T+30d | 12k remaining PASS |
| 6 | Upgrade to PAYG again | 13000 | 13000 | 0 | T+30d | New snapshot PASS |
| 7 | Use 7k (PAYG) | 20000 | 13000 | 7000 | T+30d | Billed via Stripe PASS |
| 8 | Cancel PAYG again | 13000 | 0 | — | T+30d | Pre-PAYG chars restored PASS |

CONCLUSION: Character integrity is maintained across all plan switches. The abuse scenario is fully closed.

---

## ISSUE FOUND: resetUserCharsIfNeeded() Does Not Reset chars_used_at_payg_start

**Severity: Medium** — Affects PAYG users at their 30-day cycle boundary

### Description

`resetUserCharsIfNeeded()` (db.js lines 729-762) resets `trial_chars_used = 0` and advances
`free_chars_reset_date` when a cycle expires. It does **not** reset `chars_used_at_payg_start`.

This causes a **negative** `payg_chars_used` display value for PAYG users after their cycle resets:

```
payg_chars_used = trial_chars_used - chars_used_at_payg_start
               = 0               - 10000
               = -10000   <-- BUG
```

### Failing Scenario

| Step | trial_chars_used | chars_used_at_payg_start | payg_chars_used |
|---|---|---|---|
| Activate PAYG (10k free chars used) | 10000 | 10000 | 0 |
| Use 5k on PAYG | 15000 | 10000 | 5000 |
| Cycle expires, resetUserCharsIfNeeded fires | 0 | 10000 (NOT reset!) | -10000 BUG |

### Fix Required

In `resetUserCharsIfNeeded()`, add `chars_used_at_payg_start = 0` to the UPDATE (db.js ~line 744):

```sql
UPDATE users
SET trial_chars_used = 0,
    chars_used_at_payg_start = 0,        -- ADD THIS LINE
    free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE
WHERE id = $1
```

This is safe: when the cycle resets, the new PAYG baseline is also zero.
All PAYG chars in the new cycle are still billed independently via Stripe meter events.

---

## Summary

| Item | Status |
|---|---|
| `db.js` module loads without error | PASS |
| `index.js` module loads without error | PASS |
| `activatePaygPlan()` — no char reset, snapshot taken | PASS |
| `cancelUserSubscription()` — restores pre-PAYG chars | PASS |
| `updateUserPlanStatus()` — no char/date reset for pre plan | PASS |
| `getUserById()` / `getUserByEmail()` — include new column | PASS |
| `/me` payg_chars_used calculation | PASS |
| `/translate` payg_chars_used calculation | PASS |
| `/debug/me` includes chars_used_at_payg_start | PASS |
| Multi-switch char integrity (free->PAYG->free x2) | PASS |
| `resetUserCharsIfNeeded()` resets chars_used_at_payg_start | FAIL — action required |