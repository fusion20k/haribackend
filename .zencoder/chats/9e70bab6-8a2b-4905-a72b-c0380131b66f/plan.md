# Spec and build

## Agent Instructions

Ask the user questions when anything is unclear or needs their input. This includes:

- Ambiguous or incomplete requirements
- Technical decisions that affect architecture or user experience
- Trade-offs that require business context

Do not make assumptions on important decisions — get clarification first.

---

## Workflow Steps

### [x] Step: Technical Specification

See `spec.md` for the full analysis. Confirmed decisions:
1. `/dictionary` charges `word + english + context` character length (full LLM input).
2. `/tts` user quota uses `ttsChars * 2`; `incrementUsage` uses raw `ttsChars` (no weighting).
3. `active` plan users: leave as-is, no quota enforcement added.

---

### [x] Step: Migrate `translation_usage` table — add `service_type` column

**File:** `db.js` → inside `initDatabase()`, after the last `DO $$ BEGIN IF NOT EXISTS` block for `translation_usage` columns.

Add a new migration block using the same `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE ...) THEN ALTER TABLE ... END IF; END $$` pattern:

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

No index needed — `service_type` is low-cardinality and only used in aggregations.

**Verification:** Server starts without DB error; `\d translation_usage` shows `service_type` column.

---

### [x] Step: Update `logTranslationUsage` in `analytics.js` to accept and store `service_type`

**File:** `analytics.js` → `logTranslationUsage` function.

1. Add `serviceType = 'translator'` as a 7th parameter (default keeps all existing callers working without changes).
2. In the `segments.forEach` loop, push `serviceType` as the 8th value per row (`offset` becomes `i * 8`).
3. Update the `INSERT` SQL:
   - Column list: add `service_type` after `character_count`.
   - Placeholder list: change `$${offset + 7}` → add `$${offset + 8}` for `service_type`.

Existing call in `/translate` passes 6 positional args — the new 7th (`serviceType`) will default to `'translator'` automatically. No changes needed to that call site yet (it will be updated in the `/translate` step for clarity, but it works either way).

**Verification:** A translation request inserts a row with `service_type = 'translator'` in `translation_usage`.

---

### [x] Step: Fix `/translate` — charge `billableChars` to free/pre users instead of `totalChars`

**File:** `index.js` → `POST /translate` handler, near line 1619.

**Change 1 — free/pre char increment:**
```js
// Before:
const updatedUser = await incrementUserTrialChars(req.userId, totalChars);
// After:
const updatedUser = await incrementUserTrialChars(req.userId, billableChars);
```
`billableChars` is already computed above (`cacheChars + liveChars`) and correctly excludes non-translatable skipped segments.

**Change 2 — `logTranslationUsage` call (already present ~line 1560):**
Update to pass the new `serviceType` argument explicitly:
```js
logTranslationUsage(
  req.userId,
  normalizedTexts,
  hitStatuses,
  validatedDomain,
  sourceLang,
  targetLang,
  'translator'   // ← add this
);
```

No changes to PAYG path, `incrementUsage`, or quota pre-check — those are correct.

**Verification:**
- Free user translates 10 words (8 cache hits, 2 live, 0 skipped): `trial_chars_used` increases by `cacheChars + liveChars`, not by total normalized length.
- Confirm `translation_usage` row has `service_type = 'translator'`.

---

### [x] Step: Fix `/dictionary` — full input char count, `incrementUsage`, and analytics logging

**File:** `index.js` → `POST /dictionary` handler.

**Change 1 — char count formula** (near line 1689):
```js
// Before:
const totalChars = word.trim().length;
// After:
const totalChars = word.trim().length + english.trim().length + contextStr.trim().length;
```
`contextStr` is already safely derived from `context` as a string above this line.

**Change 2 — call `incrementUsage` after the LLM call succeeds** (after `entry = await llmDictionary(...)`, before the per-plan billing blocks):
```js
await incrementUsage(totalChars);
```
This adds LLM chars to the global server cost guard.

**Change 3 — add `logTranslationUsage` call** (after the `incrementUsage` call, fire-and-forget):
```js
logTranslationUsage(
  req.userId,
  [word.trim()],
  [false],
  'dictionary',
  'tl',
  'en',
  'llm'
);
```
`source_lang = 'tl'` and `target_lang = 'en'` are hardcoded because the dictionary endpoint is always Tagalog→English. `hitStatuses = [false]` because LLM results are never cached.

No changes needed to the quota pre-check, PAYG Stripe meter event, or free/pre `incrementUserTrialChars` calls — they already use `totalChars` (which is now the corrected full-input length).

**Verification:**
- Request with `word = "mahal"` (5), `english = "expensive"` (9), `context = "in a store"` (10) → `totalChars = 24`; `trial_chars_used` increases by 24; `incrementUsage` increases by 24; `translation_usage` row inserted with `service_type = 'llm'`.
- Previously `totalChars` would have been 5 (word only).

---

### [x] Step: Fix `/tts` — call `incrementUsage` with raw chars and add analytics logging

**File:** `index.js` → `POST /tts` handler, after the `if (!response.ok)` error block and before the per-plan billing blocks (around line 1906).

**Change 1 — call `incrementUsage` with raw `ttsChars`** (not weighted):
```js
await incrementUsage(ttsChars);
```
`ttsChars = text.length` is already computed near the top of the handler. `weightedChars = ttsChars * 2` continues to be used for user quota and Stripe billing — unchanged.

**Change 2 — add `logTranslationUsage` call** (after `incrementUsage`, fire-and-forget):
```js
logTranslationUsage(
  req.userId,
  [text],
  [false],
  'tts',
  'fil',
  'fil',
  'tts'
);
```
TTS is monolingual, so `source_lang` and `target_lang` are both `'fil'`. `hitStatuses = [false]` — TTS results are never cached.

No changes to the PAYG Stripe meter event (already uses `weightedChars`) or the free/pre `incrementUserTrialChars` calls (already uses `weightedChars`).

**Verification:**
- TTS request with `text = "Magandang umaga"` (15 chars): `incrementUsage` increases by 15 (raw); `trial_chars_used` increases by 30 (weighted `* 2`); Stripe billed `ceil(30/1000) = 1` unit for PAYG; `translation_usage` row inserted with `service_type = 'tts'`.

---

### [x] Step: Syntax check and verification

Run:
```
node --check index.js
node --check db.js
node --check analytics.js
```

All three must exit with code 0 (no syntax errors).

Write `report.md` covering:
- What was changed in each file and why
- Which bugs were fixed (overcharge on free/pre translate; undercount on dictionary; missing global guard on LLM/TTS)
- How each change was verified
- Any edge cases or risks noted
