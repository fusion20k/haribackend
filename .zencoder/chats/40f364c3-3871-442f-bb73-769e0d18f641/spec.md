# Technical Specification: Backend Translation Response Validation

## Difficulty: Easy–Medium

The core change is straightforward (add a validator, call it in two places), but requires careful tuning of regex patterns to avoid false positives on legitimate translations.

---

## Technical Context

- **Language**: Node.js (CommonJS)
- **Key files**: `index.js`, `segmentation.js`
- **Translation provider**: Azure Cognitive Translator (`azureTranslate`)
- **No new dependencies needed**

### Root Cause

Azure Translator uses internal placeholder substitution during preprocessing (e.g., masking email addresses, URLs, and named entities as tokens like `EMAIL_ADDRESS_1`, `PHONE_NUMBER_2`). In some edge cases these tokens are not detokenized before the response is returned, causing garbage like `Makipag-ugnayan kay EMAIL_ADDRESS_1` to reach clients instead of the real translation.

The client-side Chrome extension already added defense-in-depth validation. This spec covers the **backend-side** defense.

---

## Implementation Approach

### 1. Add `isValidTranslation(inputText, outputText)` to `segmentation.js`

A new exported function that returns `false` if the translation response is considered corrupt/leaked. Checks (applied in order, short-circuit on first failure):

| Check | Condition | Notes |
|---|---|---|
| Placeholder token pattern | `/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/` — matches `EMAIL_ADDRESS_1`, `PHONE_NUMBER`, `URL_1`, etc. | Must have at least one underscore to avoid flagging normal all-caps abbreviations like "USA", "CEO" |
| Lone asterisk tokens | `/\*[A-Z0-9_]+\*/` — matches `*EMAIL*`, `*TOKEN_1*` | Some APIs use asterisk-wrapped placeholders |
| Absurd length ratio | `output.length > input.length * 8 && output.length > 100` | Guards against runaway expansion; factor of 8 is generous enough not to false-positive on short inputs with long valid translations |

If any check triggers, the function returns `false` and the caller falls back to the **original (untranslated) input text** for that segment — same behavior as echo detection.

### 2. Call the validator in `/translate` route (index.js)

Two locations in the translation processing loop (both first-pass and word-level retry):

**First-pass loop** (around line 1182):
```
newTranslations.forEach((tl, i) => {
  const { index, key, text, decorations } = toTranslate[i];
  const echoed = isEchoedTranslation(text, tl);
  // ← ADD: validate before any use
  if (!isValidTranslation(text, tl)) { ... fallback ... }
  ...
```

**Retry loop** (around line 1215):
```
retryTranslations.forEach((tl, ri) => {
  ...
  // ← ADD: same check
```

Invalid translations:
- Are **not cached** to the DB (same as echoed translations)
- Are **not counted** toward character usage for that segment? ← Actually: character usage is counted at the batch level (`azureChars`) before per-translation validation, so no change needed there. Billing is for the Azure API call, not per valid result.
- Log a warning: `[translate] placeholder leak detected, falling back: "${text}" → "${tl}"`
- Fall back to `textsToTranslate[index]` (original input)

---

## Source Code Changes

### `segmentation.js`
- **Add** exported function `isValidTranslation(inputText, outputText)`
- **Export** it in `module.exports`

### `index.js`
- **Import** `isValidTranslation` from `./segmentation`
- **Call** `isValidTranslation(text, tl)` in the first-pass `newTranslations.forEach` loop, before the echo check or immediately after (order doesn't matter; both result in fallback)
- **Call** same in the retry `retryTranslations.forEach` loop

### No DB schema changes required.
### No new files required.

---

## API / Interface Changes

None. The response shape is unchanged. Affected segments silently receive the original text as the "translation" (same as echo fallback behavior today).

---

## Verification Approach

1. **Manual test**: craft a segment whose Azure result would contain `EMAIL_ADDRESS_1` (mock `azureTranslate` or intercept in test) — verify fallback to original.
2. **Regex unit check**: call `isValidTranslation` directly with known bad strings and confirm `false`:
   - `"Makipag-ugnayan kay EMAIL_ADDRESS_1"`
   - `"Tumawag sa PHONE_NUMBER_2 para sa tulong"`
   - `"*URL_TOKEN* ay hindi available"`
3. **Verify no false positives** on strings like `"Ang CEO ng kumpanya"`, `"Pumunta sa USA"` — should still return `true`.
4. **Run server** (`node index.js`) and verify startup with no errors.
5. No automated test suite exists in this project; verification is manual/log-based.
