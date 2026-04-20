# Spec and Build

## Agent Instructions

Ask the user questions when anything is unclear or needs their input. This includes:

- Ambiguous or incomplete requirements
- Technical decisions that affect architecture or user experience
- Trade-offs that require business context

Do not make assumptions on important decisions — get clarification first.

---

## Workflow Steps

### [x] Step: Technical Specification (approved by user — proceed)

Spec written to `spec.md`. Four billing safety risks identified and fully specified.

---

### [x] Step: Implementation — Risk 4 (Global Azure Cost Guard)

**Simplest change, no logic restructure. Do this first.**

File: `index.js`

Sub-steps:
1. In `/dictionary` handler: after `totalChars` is computed and before the `llmDictionary` call, insert:
   ```js
   const QUOTA = parseInt(process.env.MONTHLY_CHAR_LIMIT) || 10_000_000;
   const usageRow = await getUsage();
   if (usageRow.current_month_usage_chars + totalChars > QUOTA * 0.95) {
     return res.status(503).json({ error: "usage_cap_reached" });
   }
   ```
2. In `/tts` handler: after `ttsChars` is computed and before the Azure Speech `fetch` call, insert the same block using `ttsChars` (not `weightedChars`) as the guard value.
3. Verify: `node --check index.js`

---

### [x] Step: Implementation — Risk 1 (Stripe Meter Event Idempotency)

File: `index.js`

Sub-steps:
1. Add `const crypto = require("crypto");` at top of file if not already imported (check — `crypto` is already used in `db.js` but confirm in `index.js`).
2. In `/translate` handler: at the top of the handler (after `requireAuth`), extract idempotency key:
   ```js
   const idempotencyKey = req.headers["x-idempotency-key"] || crypto.randomUUID();
   const meterIdentifier = `translate:${req.userId}:${idempotencyKey}`;
   ```
3. In the `stripe.billing.meterEvents.create` call in `/translate`, add `identifier: meterIdentifier` to the params object.
4. Repeat for `/dictionary`: `meterIdentifier = \`dictionary:${req.userId}:${idempotencyKey}\``
5. Repeat for `/tts`: `meterIdentifier = \`tts:${req.userId}:${idempotencyKey}\``
6. Verify: `node --check index.js`

---

### [x] Step: Implementation — Risk 2 (Stripe Meter Event Failure Queue)

Files: `db.js`, `index.js`

Sub-steps:

**db.js**:
1. In `initDatabase`, add a new migration block after existing table creations:
   ```sql
   CREATE TABLE IF NOT EXISTS pending_meter_events (
     id                 SERIAL PRIMARY KEY,
     user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     stripe_customer_id VARCHAR(255) NOT NULL,
     event_name         VARCHAR(100) NOT NULL DEFAULT 'translation_chars',
     units              INTEGER NOT NULL,
     identifier         VARCHAR(255) NOT NULL,
     status             VARCHAR(20) NOT NULL DEFAULT 'pending',
     attempts           INTEGER NOT NULL DEFAULT 0,
     last_attempted_at  TIMESTAMPTZ,
     created_at         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
   );
   CREATE INDEX IF NOT EXISTS idx_pending_meter_events_status ON pending_meter_events(status);
   ```
2. Add `insertPendingMeterEvent(userId, stripeCustomerId, eventName, units, identifier)`:
   - INSERT into `pending_meter_events`
3. Add `getPendingMeterEvents(limit = 20)`:
   - SELECT where `status = 'pending'` AND `attempts < 3`, ORDER BY `created_at ASC`, LIMIT
4. Add `updateMeterEventAttempt(id, succeeded)`:
   - If `succeeded`: DELETE the row (successfully delivered, clean up)
   - If not succeeded: INCREMENT `attempts`, set `last_attempted_at = NOW()`; if new `attempts >= 3`, set `status = 'permanently_failed'`
5. Export all 3 new functions in `module.exports`

**index.js**:
6. Import the 3 new functions from `./db`
7. In `/translate` catch block for Stripe meter: replace silent swallow with `await insertPendingMeterEvent(req.userId, freshUser.stripe_customer_id, 'translation_chars', charsToReport, meterIdentifier)`
8. Repeat for `/dictionary` catch block
9. Repeat for `/tts` catch block
10. After `app.listen(...)` in `startServer`, add the background drainer:
    ```js
    if (stripe) {
      setInterval(async () => {
        try {
          const rows = await getPendingMeterEvents(20);
          for (const row of rows) {
            try {
              await stripe.billing.meterEvents.create({
                event_name: row.event_name,
                payload: { value: String(row.units), stripe_customer_id: row.stripe_customer_id },
                identifier: row.identifier,
              });
              await updateMeterEventAttempt(row.id, true);
              console.log(`[meter-drainer] succeeded: id=${row.id}`);
            } catch (e) {
              await updateMeterEventAttempt(row.id, false);
              console.error(`[meter-drainer] retry failed: id=${row.id} attempt=${row.attempts + 1} err=${e.message}`);
            }
          }
        } catch (drainErr) {
          console.error("[meter-drainer] drainer error:", drainErr.message);
        }
      }, 60_000);
    }
    ```
11. Verify: `node --check index.js && node --check db.js`

---

### [x] Step: Implementation — Risk 3 (Atomic Quota Check+Increment)

**Most complex change — restructures control flow in 3 handlers. Read spec.md § Risk 3 before starting.**

Decision confirmed: no refund-on-error. If Azure fails after chars are reserved, chars are lost. Do not add rollback logic.

Files: `db.js`, `index.js`

Sub-steps:

**db.js**:
1. Add `atomicCheckAndIncrementChars(userId, chars)` after `incrementUserTrialChars`:
   ```js
   async function atomicCheckAndIncrementChars(userId, chars) {
     const client = await pool.connect();
     try {
       const result = await client.query(
         `UPDATE users
          SET trial_chars_used = trial_chars_used + $1
          WHERE id = $2
            AND trial_chars_used + $1 <= trial_chars_limit
          RETURNING id, trial_chars_used, trial_chars_limit, plan_status, subscription_id, stripe_customer_id`,
         [chars, userId]
       );
       if (result.rowCount === 0) return { allowed: false, user: null };
       return { allowed: true, user: result.rows[0] };
     } catch (error) {
       console.error("Error in atomicCheckAndIncrementChars:", error);
       throw error;
     } finally {
       client.release();
     }
   }
   ```
2. Add `atomicCheckAndIncrementChars` to `module.exports`

**index.js — /translate handler** (reference lines in current file):
3. Move `billableChars` computation (currently lines 1570–1583) to immediately after the `toTranslate` array is built (currently ends around line 1391). Place it just before the `if (toTranslate.length > 0)` block. The computation only uses `cleanedData`, `hitStatuses`, `skipIndices`, `multiWordIndices`, and `toTranslate` — all available at that point:
   ```js
   let cacheChars = 0;
   let liveChars = 0;
   for (let i = 0; i < cleanedData.length; i++) {
     if (skipIndices.has(i)) continue;
     if (hitStatuses[i] && !multiWordIndices.has(i)) {
       cacheChars += cleanedData[i].cleaned.length;
     }
   }
   for (const item of toTranslate) {
     liveChars += item.text.length;
   }
   const billableChars = cacheChars + liveChars;
   ```
   Remove the duplicate `let cacheChars`, `let liveChars`, `const billableChars` lines from their original position (lines 1570–1583).

4. Remove the early quota check block for `free`/`pre` (currently lines 1293–1318):
   ```js
   // DELETE this entire block:
   if (user && ["free", "pre"].includes(user.plan_status)) {
     if (["free", "pre"].includes(user.plan_status)) {
       const reset = await resetUserCharsIfNeeded(req.userId);
       if (reset) { user = await getUserById(req.userId); }
     }
     const charsUsed = user.trial_chars_used ?? 0;
     const charsLimit = user.trial_chars_limit ?? 25000;
     if (charsUsed >= charsLimit) { ... return 402 ... }
   }
   ```
   NOTE: The `resetUserCharsIfNeeded` call within that block must be preserved — move it to just before the atomic increment (step 5 below).

5. In place of the removed block, after `billableChars` is computed and before `if (toTranslate.length > 0)`, insert for `free`/`pre`:
   ```js
   let translateUpdatedUser = null;
   if (user && ["free", "pre"].includes(user.plan_status)) {
     const reset = await resetUserCharsIfNeeded(req.userId);
     if (reset) { user = await getUserById(req.userId); }
     const { allowed, user: au } = await atomicCheckAndIncrementChars(req.userId, billableChars);
     if (!allowed) {
       return res.status(402).json({
         error: user.plan_status === "pre" ? "monthly_limit_reached" : "trial_exhausted",
         message: user.plan_status === "pre"
           ? "You have used your 1,000,000 monthly characters. Your limit resets in 30 days."
           : "You have used your 25,000 free characters.",
         trial_chars_used: user.trial_chars_used,
         trial_chars_limit: user.trial_chars_limit,
       });
     }
     translateUpdatedUser = au;
     if (translateUpdatedUser.trial_chars_used >= translateUpdatedUser.trial_chars_limit) {
       if (user.plan_status === "free" && stripe && translateUpdatedUser.subscription_id) {
         try {
           await stripe.subscriptions.update(translateUpdatedUser.subscription_id, { trial_end: "now" });
           console.log(`Trial ended early for user ${req.userId} after hitting char limit`);
         } catch (stripeErr) {
           console.error("Failed to end Stripe trial early:", stripeErr.message);
         }
       }
     }
   }
   ```

6. Replace the post-Azure `free`/`pre` branch (currently lines 1620–1638):
   ```js
   // DELETE this block:
   if (user && ["free", "pre"].includes(user.plan_status)) {
     const updatedUser = await incrementUserTrialChars(req.userId, billableChars);
     if (updatedUser && updatedUser.trial_chars_used >= updatedUser.trial_chars_limit) { ... }
     return res.json({ translations, trial_chars_used: ..., trial_chars_limit: ... });
   }
   ```
   Replace with:
   ```js
   if (user && ["free", "pre"].includes(user.plan_status)) {
     return res.json({
       translations,
       trial_chars_used: translateUpdatedUser ? translateUpdatedUser.trial_chars_used : null,
       trial_chars_limit: translateUpdatedUser ? translateUpdatedUser.trial_chars_limit : null,
     });
   }
   ```
   (The Stripe `trial_end: "now"` logic moved to step 5 above; the `payg` branch at lines 1585–1618 is untouched.)

**index.js — /dictionary handler** (reference lines in current file):
7. Remove early quota check block (currently lines 1692–1714) — the block that reads `charsUsed`/`charsLimit` and returns 402 for `free`/`pre`. Keep the `payg` reset-check block (lines 1717–1722) untouched.
8. Before the `llmDictionary` call (currently line 1726), insert:
   ```js
   let dictUpdatedUser = null;
   if (user && ["free", "pre"].includes(user.plan_status)) {
     const reset = await resetUserCharsIfNeeded(req.userId);
     if (reset) { user = await getUserById(req.userId); }
     const { allowed, user: au } = await atomicCheckAndIncrementChars(req.userId, totalChars);
     if (!allowed) {
       return res.status(402).json({
         error: user.plan_status === "pre" ? "monthly_limit_reached" : "trial_exhausted",
         message: user.plan_status === "pre"
           ? "You have used your 1,000,000 monthly characters. Your limit resets in 30 days."
           : "You have used your 25,000 free characters.",
         trial_chars_used: user.trial_chars_used,
         trial_chars_limit: user.trial_chars_limit,
       });
     }
     dictUpdatedUser = au;
   }
   ```
9. In the post-call `free`/`pre` branch (currently lines 1778–1784):
   ```js
   // DELETE:
   const updatedUser = await incrementUserTrialChars(req.userId, totalChars);
   return res.json({ ...entry, trial_chars_used: updatedUser ? ..., trial_chars_limit: ... });
   // REPLACE WITH:
   return res.json({
     ...entry,
     trial_chars_used: dictUpdatedUser ? dictUpdatedUser.trial_chars_used : null,
     trial_chars_limit: dictUpdatedUser ? dictUpdatedUser.trial_chars_limit : null,
   });
   ```
   (The `payg` branch at lines 1743–1775 is untouched.)

**index.js — /tts handler** (reference lines in current file):
10. Remove early quota check block (currently lines 1857–1880) — the block that reads `charsUsed`/`charsLimit` and returns 402 for `free`/`pre`. Keep the `payg` reset-check block (lines 1882–1887) untouched.
11. Before the Azure Speech `fetch` call (currently line 1899), insert:
    ```js
    let ttsUpdatedUser = null;
    if (user && ["free", "pre"].includes(user.plan_status)) {
      const reset = await resetUserCharsIfNeeded(req.userId);
      if (reset) { user = await getUserById(req.userId); }
      const { allowed, user: au } = await atomicCheckAndIncrementChars(req.userId, weightedChars);
      if (!allowed) {
        return res.status(402).json({
          error: user.plan_status === "pre" ? "monthly_limit_reached" : "trial_exhausted",
          message: user.plan_status === "pre"
            ? "You have used your 1,000,000 monthly characters. Your limit resets in 30 days."
            : "You have used your 25,000 free characters.",
          trial_chars_used: user.trial_chars_used,
          trial_chars_limit: user.trial_chars_limit,
        });
      }
      ttsUpdatedUser = au;
    }
    ```
12. In the post-call `free`/`pre` branch (currently lines 1949–1951):
    ```js
    // DELETE:
    if (user && ["free", "pre"].includes(user.plan_status)) {
      await incrementUserTrialChars(req.userId, weightedChars);
    }
    ```
    The response for TTS is the audio buffer (not JSON), so no trial_chars_used field is returned — simply removing the `incrementUserTrialChars` call is the complete change here. `ttsUpdatedUser` is computed but not sent in the response body (TTS returns binary audio).
    (The `payg` branch at lines 1929–1947 is untouched.)
13. Import `atomicCheckAndIncrementChars` in the destructured require from `./db` at the top of `index.js`.
14. Verify: `node --check index.js && node --check db.js`

---

### [x] Step: Verification

1. Run `node --check index.js` — must exit 0
2. Run `node --check db.js` — must exit 0
3. Manual smoke-test checklist (document results):
   - Risk 1: Call `/translate` as PAYG user; check server log for `identifier` field in meter event log line
   - Risk 2: Temporarily make Stripe throw; call `/translate`; confirm row in `pending_meter_events`; restore, wait 60s, confirm drainer log
   - Risk 3: With a free user near quota, send two concurrent requests; confirm only one succeeds
   - Risk 4: Set `MONTHLY_CHAR_LIMIT=1`; call `/dictionary` and `/tts`; confirm 503 `usage_cap_reached`
