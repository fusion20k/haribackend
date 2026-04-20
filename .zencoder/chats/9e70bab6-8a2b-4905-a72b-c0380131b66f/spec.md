# Technical Specification: Billing Safety Fixes

## Complexity Assessment
**Medium** — four targeted, isolated fixes. Each touches 1–3 well-defined locations. No schema rewrites. Highest risk item is Risk 3 (atomic quota), which restructures per-request control flow.

---

## Technical Context

- **Language / Runtime**: Node.js (CommonJS)
- **Key dependencies**: `pg`, `stripe`, `axios`, `express`, `crypto`
- **Billing routes**: `POST /translate`, `POST /dictionary`, `POST /tts`
- **Stripe surface**: `stripe.billing.meterEvents.create` (PAYG only)
- **Quota fields on `users`**: `trial_chars_used`, `trial_chars_limit`, `free_chars_reset_date`
- **Global cost guard**: `usage` table, `getUsage()` / `incrementUsage()` in `db.js`
- **Plans subject to quota**: `free` (25K chars/30d), `pre` (1M chars/30d); `payg` has soft-cap only

---

## Risk 1 — Stripe Meter Event Idempotency

### Problem
`stripe.billing.meterEvents.create` is called in `/translate`, `/dictionary`, and `/tts` with no `identifier` field. If the Stripe HTTP call times out and the caller retries (or if the handler runs twice due to a proxy/LB retry), Stripe will record the usage twice — double-billing the PAYG user.

### Stripe API
`stripe.billing.meterEvents.create` accepts an optional `identifier` string. Within a 10-minute deduplication window, Stripe rejects duplicate events with the same `identifier`. See: https://docs.stripe.com/api/billing/meter-event/create

### Fix
1. At the top of each handler, generate a per-request idempotency key:
   - Accept an optional `X-Idempotency-Key` header from the client (allows true client-retry idempotency).
   - If absent, generate a server-side UUID via `crypto.randomUUID()` (prevents server-internal retries only).
2. Derive the meter event `identifier` as: `` `${route}:${userId}:${idempotencyKey}` ``
   - `route` is the literal string `'translate'`, `'dictionary'`, or `'tts'`
3. Pass as `identifier` in every `stripe.billing.meterEvents.create` call.

### Scope
- `index.js`: three `stripe.billing.meterEvents.create` call sites
- No `db.js` changes needed

### Key format examples
```
translate:42:a1b2c3d4-e5f6-...
dictionary:42:a1b2c3d4-e5f6-...
tts:42:a1b2c3d4-e5f6-...
```

---

## Risk 2 — Stripe Meter Event Failure Handling

### Problem
All three routes catch Stripe meter failures with:
```js
} catch (e) {
  console.error("PAYG Stripe meter event failed (non-fatal):", e.message);
}
```
A Stripe outage or network error silently drops the billing record. Revenue is lost with no recovery path.

### Fix
Implement a **DB-backed retry queue** with a background drainer.

#### New DB table: `pending_meter_events`
```sql
CREATE TABLE IF NOT EXISTS pending_meter_events (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id  VARCHAR(255) NOT NULL,
  event_name      VARCHAR(100) NOT NULL DEFAULT 'translation_chars',
  units           INTEGER NOT NULL,
  identifier      VARCHAR(255) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempted_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pending_meter_events_status ON pending_meter_events(status);
```

`status` values: `'pending'`, `'permanently_failed'`

#### New `db.js` functions
- `insertPendingMeterEvent(userId, stripeCustomerId, eventName, units, identifier)` — inserts a row with `status = 'pending'`
- `getPendingMeterEvents(limit = 20)` — returns rows with `status = 'pending'` and `attempts < 3`, ordered by `created_at ASC`
- `updateMeterEventAttempt(id, failed)` — increments `attempts`, sets `last_attempted_at = NOW()`; if `failed && attempts >= 3`, sets `status = 'permanently_failed'`

#### Modified failure path in `index.js`
On `stripe.billing.meterEvents.create` catch:
```js
} catch (e) {
  console.error("[payg] Stripe meter event failed, queuing for retry:", e.message);
  await insertPendingMeterEvent(req.userId, freshUser.stripe_customer_id, 'translation_chars', charsToReport, meterIdentifier);
}
```

#### Background drainer (in `index.js`, started after DB init)
```js
setInterval(async () => {
  const rows = await getPendingMeterEvents(20);
  for (const row of rows) {
    try {
      await stripe.billing.meterEvents.create({
        event_name: row.event_name,
        payload: { value: String(row.units), stripe_customer_id: row.stripe_customer_id },
        identifier: row.identifier,
      });
      await updateMeterEventAttempt(row.id, false);
      console.log(`[meter-drainer] retried and succeeded: id=${row.id}`);
    } catch (e) {
      await updateMeterEventAttempt(row.id, true);
      console.error(`[meter-drainer] retry failed (attempt ${row.attempts + 1}): id=${row.id} err=${e.message}`);
    }
  }
}, 60_000);
```

After 3 failures, the row is marked `permanently_failed` and logged at `console.error` level for operator alerting (no silent loss).

The drainer only runs if `stripe` is configured (guard with `if (!stripe) return`).

### Scope
- `db.js`: `initDatabase` migration block + 3 new exported functions
- `index.js`: 3 catch blocks + drainer setup after `startServer`
- Exports: add `insertPendingMeterEvent`, `getPendingMeterEvents`, `updateMeterEventAttempt` to `module.exports`

---

## Risk 3 — Race Condition on Quota Check

### Problem
For `free` and `pre` users, quota enforcement is a read-then-write:
1. **Read** `trial_chars_used`, `trial_chars_limit` from DB
2. If used < limit → proceed
3. Call Azure (takes 100–500ms)
4. **Write** `incrementUserTrialChars(userId, chars)`

Two concurrent requests can both pass step 2 with the same stale read, then both call Azure, then both increment — consuming up to 2× the remaining quota.

### Fix
Replace the two-step read+check with a single atomic SQL UPDATE for `free` and `pre` plans:

```sql
UPDATE users
SET trial_chars_used = trial_chars_used + $1
WHERE id = $2
  AND trial_chars_used + $1 <= trial_chars_limit
RETURNING id, trial_chars_used, trial_chars_limit, plan_status, subscription_id, stripe_customer_id
```

- If `rowCount === 1` → quota was available; row now shows the committed new value. Proceed.
- If `rowCount === 0` → quota exceeded atomically. Return 402.

This "reserve-then-use" pattern: chars are debited **before** the Azure call. If Azure fails after reservation, the chars are consumed. **Decision (confirmed by user): no refund-on-error. Reserve-then-use is final.** This is acceptable — the alternative (post-billing) has the race.

#### New `db.js` function
```js
async function atomicCheckAndIncrementChars(userId, chars)
// Returns { allowed: boolean, user: row | null }
// allowed=false means quota exceeded; user is null in that case
```

#### Handler restructuring (`free`/`pre` path)
Before (current):
```js
// Step A (early): read user, check quota
if (charsUsed >= charsLimit) return 402;
// ... call Azure ...
// Step B (late): increment
const updatedUser = await incrementUserTrialChars(req.userId, billableChars);
```

After:
```js
// Single atomic step: check AND increment
const { allowed, user: updatedUser } = await atomicCheckAndIncrementChars(req.userId, billableChars);
if (!allowed) return 402 quota_exceeded;
// ... call Azure ...
// No second increment needed — already done atomically
```

**Important**: `billableChars` for `/translate` is known before the Azure call because it depends on segment lengths, not Azure responses. Compute it up front (already done at line 1583 conceptually — `cacheChars + liveChars`). For `/dictionary` and `/tts`, `totalChars`/`weightedChars` are also computed before the external call. So all three endpoints can do the atomic increment before hitting Azure.

#### Applies to
- `/translate` — `free` and `pre` branches
- `/dictionary` — `free` and `pre` branches
- `/tts` — `free` and `pre` branches
- **Not `payg`** — payg has no hard quota; its `incrementUserTrialChars` can remain post-call

#### Error response for quota exceeded via atomic path
Use the same 402 body as the existing check (plan-appropriate `trial_exhausted` vs `monthly_limit_reached`), but the user object used for `plan_status` comparison comes from the pre-request `getUserById` read (still needed for plan routing).

### Scope
- `db.js`: 1 new function `atomicCheckAndIncrementChars`, exported
- `index.js`: restructure `free`/`pre` quota path in all 3 handlers; remove post-call `incrementUserTrialChars` for `free`/`pre`

---

## Risk 4 — Global Azure Cost Guard on `/dictionary` and `/tts`

### Problem
`/translate` checks the global `usage` table before calling Azure (lines 1327–1331):
```js
const QUOTA = parseInt(process.env.MONTHLY_CHAR_LIMIT) || 10_000_000;
const usageRow = await getUsage();
if (usageRow.current_month_usage_chars + totalChars > QUOTA * 0.95) {
  return res.status(503).json({ error: "usage_cap_reached" });
}
```
`/dictionary` and `/tts` have no equivalent guard. A burst of dictionary/TTS requests can silently exceed the Azure monthly budget.

### Fix
Add the identical guard to `/dictionary` (before `llmDictionary` call) and `/tts` (before the Azure Speech fetch). Use the same variable names, same 95% threshold, same 503 response.

For `/dictionary`, the guard char count is `totalChars` (already computed as `word.trim().length + english.trim().length + contextStr.trim().length`).

For `/tts`, the guard char count is `ttsChars` (raw `text.length`, not weighted — same rationale as Risk 4 column in prior spec: `incrementUsage` tracks raw Azure-billed chars).

### Scope
- `index.js`: 2 insertion points (one in `/dictionary`, one in `/tts`)
- No `db.js` changes needed

---

## Data Model Changes Summary

| Table | Change |
|-------|--------|
| `pending_meter_events` | New table (Risk 2) |

All other changes are code-only.

---

## Files to Modify

| File | Risks |
|------|-------|
| `db.js` | Risk 2 (table migration + 3 functions), Risk 3 (1 function) |
| `index.js` | Risk 1 (3 call sites), Risk 2 (3 catch blocks + drainer), Risk 3 (3 handlers restructured), Risk 4 (2 guard blocks) |

---

## Verification Approach

1. **Risk 1**: Log the `identifier` passed to Stripe; confirm format `route:userId:uuid` in server logs for `/translate`, `/dictionary`, `/tts`.
2. **Risk 2**: Temporarily throw in the Stripe call; verify row appears in `pending_meter_events`; verify drainer picks it up within 60s and logs success/failure.
3. **Risk 3**: Simulate two concurrent requests that together exceed a user's remaining quota (e.g., 200 chars left, two requests of 150 chars); verify only one succeeds (201 status), the other gets 402.
4. **Risk 4**: Set `MONTHLY_CHAR_LIMIT=1` in `.env`; call `/dictionary` and `/tts`; verify both return 503 `usage_cap_reached`.
5. **Syntax check**: `node --check index.js && node --check db.js`
