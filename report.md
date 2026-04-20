# Change Report

## Syntax Check Results

All three files pass `node --check` with exit code 0:

- `node --check index.js` — **PASS**
- `node --check db.js` — **PASS**
- `node --check analytics.js` — **PASS**

---

## Changes by File

### `db.js`

**What changed:** Added a safe idempotent migration block inside `initDatabase()` to add the `service_type` column to the `translation_usage` table.

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'translation_usage' AND column_name = 'service_type'
  ) THEN
    ALTER TABLE translation_usage ADD COLUMN service_type VARCHAR(20) NOT NULL DEFAULT 'translator';
  END IF;
END $$;
```

**Why:** The analytics table had no way to distinguish whether a logged row came from the translator, dictionary LLM, or TTS engine. This column enables per-service usage breakdowns.

**Edge cases / risks:**
- The `IF NOT EXISTS` guard makes this migration safe to run on a database that already has the column (e.g., after a restart).
- `DEFAULT 'translator'` ensures existing rows get a sensible value; it also keeps the column `NOT NULL` without a backfill step.
- No index was added — `service_type` is low-cardinality and only queried in aggregations, so a full scan is acceptable.

---

### `analytics.js`

**What changed:** `logTranslationUsage` gained a 7th parameter `serviceType = 'translator'` (default).

- The `segments.forEach` loop now pushes `serviceType` as the 8th value per row.
- The `INSERT` SQL was updated: `service_type` added to the column list; placeholder numbering shifted from `i * 7` to `i * 8` offsets with `$${offset + 8}` for `service_type`.

**Why:** Without this change, every row inserted into `translation_usage` would have had the column default value regardless of which service generated it, making the column useless for filtering.

**Backward compatibility:** The new parameter defaults to `'translator'`, so every existing caller that passes only 6 arguments continues to work without modification.

**Edge cases / risks:**
- Any future caller that omits the 7th argument will log `service_type = 'translator'`, which may silently misclassify a new service. New endpoint integrations must remember to pass the correct value explicitly.

---

### `index.js` — `/translate` handler

**Bug fixed:** Free and pre-paid users were being charged `totalChars` (the full normalized segment count including skipped/non-translatable segments) instead of `billableChars` (`cacheChars + liveChars`), causing overcharging.

**What changed:**

1. `incrementUserTrialChars(req.userId, totalChars)` → `incrementUserTrialChars(req.userId, billableChars)`.
2. The existing `logTranslationUsage` call was updated to pass `'translator'` as the explicit 7th argument.

**Why:** `billableChars` is computed as `cacheChars + liveChars` and correctly excludes segments that were skipped (e.g., numbers, punctuation, already-translated text). `totalChars` included those skipped segments, so users were paying for characters the engine never processed.

**What was not changed:** The PAYG path, `incrementUsage`, and the pre-check quota comparison — all were already correct.

**Edge cases / risks:**
- If `billableChars` is 0 (all segments skipped), `incrementUserTrialChars` is called with 0, which is a no-op. This is correct behaviour.
- Cache hits are still counted in `billableChars` (`cacheChars`). This is intentional: cache lookups still consume quota to prevent abuse.

---

### `index.js` — `/dictionary` handler

**Bug 1 fixed:** `totalChars` was computed as `word.trim().length` only, ignoring the `english` hint and `context` strings that are passed as part of the LLM prompt. This caused significant undercounting of actual LLM token consumption.

**What changed — char count formula:**

```js
// Before:
const totalChars = word.trim().length;
// After:
const totalChars = word.trim().length + english.trim().length + contextStr.trim().length;
```

**Bug 2 fixed:** `/dictionary` never called `incrementUsage`, so its LLM calls were invisible to the global server-cost guard.

**What changed — global cost guard:**

```js
await incrementUsage(totalChars);
```

Added after the LLM call succeeds, before per-plan billing blocks.

**Bug 3 fixed:** `/dictionary` never logged to `translation_usage`, making it impossible to audit dictionary LLM spend per user.

**What changed — analytics logging:**

```js
logTranslationUsage(req.userId, [word.trim()], [false], 'dictionary', 'tl', 'en', 'llm');
```

`source_lang = 'tl'` and `target_lang = 'en'` are hardcoded (dictionary is always Tagalog→English). `hitStatuses = [false]` because LLM results are never from cache.

**Verification example:** `word = "mahal"` (5) + `english = "expensive"` (9) + `context = "in a store"` (10) → `totalChars = 24`. Previously this would have been 5.

**Edge cases / risks:**
- `contextStr` is derived from `context` early in the handler using `String(context || '')`, so it is always a safe string even when the caller omits the field.
- The `logTranslationUsage` call is fire-and-forget (no `await`). A DB failure will not surface to the user, matching the pattern used throughout the codebase.

---

### `index.js` — `/tts` handler

**Bug 1 fixed:** `/tts` never called `incrementUsage`, so TTS API calls were invisible to the global server-cost guard.

**What changed — global cost guard:**

```js
await incrementUsage(ttsChars);
```

Uses raw `ttsChars` (not `weightedChars`). The weighting factor (`* 2`) exists only for user quota and Stripe billing to account for TTS being more expensive per character than translation; the global cost guard tracks raw input size.

**Bug 2 fixed:** `/tts` never logged to `translation_usage`.

**What changed — analytics logging:**

```js
logTranslationUsage(req.userId, [text], [false], 'tts', 'fil', 'fil', 'tts');
```

TTS is monolingual, so both `source_lang` and `target_lang` are `'fil'`. `hitStatuses = [false]` — TTS results are never cached.

**What was not changed:** The PAYG Stripe meter event (already uses `weightedChars`) and free/pre `incrementUserTrialChars` (already uses `weightedChars`) — both were correct.

**Verification example:** `text = "Magandang umaga"` (15 chars) → `incrementUsage` receives 15 (raw); `trial_chars_used` increases by 30 (`weightedChars`); Stripe billed `ceil(30/1000) = 1` unit for PAYG.

**Edge cases / risks:**
- The two accounting paths (raw for `incrementUsage`, weighted for user quota/Stripe) must remain in sync. If the weighting factor ever changes, both the user billing path and the `incrementUsage` call should be reviewed together.

---

## Summary of Bugs Fixed

| Bug | Endpoint | Impact |
|-----|----------|--------|
| Free/pre users charged `totalChars` instead of `billableChars` | `/translate` | Overcharging on requests with skipped segments |
| `totalChars` counted only the word, not the full LLM input | `/dictionary` | Undercount; quota and cost guard were bypassed for most of the actual LLM input |
| `incrementUsage` never called | `/dictionary`, `/tts` | LLM and TTS calls were invisible to the global server-cost guard |
| No analytics logging | `/dictionary`, `/tts` | Zero visibility into per-user LLM/TTS spend |
| `translation_usage` table had no `service_type` column | DB schema | Could not distinguish translator vs. LLM vs. TTS rows in analytics |
