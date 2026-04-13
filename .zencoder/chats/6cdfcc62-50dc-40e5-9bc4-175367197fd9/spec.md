# Technical Specification: PAYG Billing for Cache + Live Translations

## Difficulty: Medium

---

## Current Behavior Analysis

### `/translate` endpoint — PAYG billing (lines 1381–1416 of `index.js`)

```js
const totalChars = normalizedTexts.reduce((sum, s) => sum + s.length, 0);
// ...later...
await incrementUserTrialChars(req.userId, totalChars);
const charsToReport = Math.ceil(totalChars / 1000);
// Stripe meter event with charsToReport
```

**What `totalChars` includes:**
- All segments that were **cache hits** ✓
- All segments that were **live Azure translations** ✓
- All segments in `skipIndices` (non-translatable: numbers, emojis, punctuation-only) — passed through unchanged
- Includes punctuation/decorations that were stripped before translation

**What `azureChars` includes (global usage counter, NOT billing):**
- Only segments sent to Azure (cache misses)
- Uses `cleanedData[index].cleaned.length` (punctuation-stripped)

**Current verdict:** Cache hits ARE charged today. However, the billing metric (`totalChars` via `normalizedTexts`) is inconsistent with the actual text processed (`cleanedData.cleaned`), and `skipIndices` non-translatable segments inflate the charge.

---

## Issues Identified

### Issue 1 — Metric inconsistency
`totalChars` uses `normalizedTexts` lengths (from `validateSegment`, which lowercases and trims but keeps words intact). `azureChars` uses `cleanedData.cleaned` lengths (from `cleanSegment`, which also strips leading/trailing punctuation). The billing char count should use the same metric as what's actually processed.

### Issue 2 — Non-translatable segments inflate billing
Segments in `skipIndices` (no alphabetic chars) are returned as-is and counted in `totalChars`. They should not count toward billable chars since no translation work is performed.

### Issue 3 — No visibility into cache vs live breakdown
The single `totalChars` meter event conflates cache hits and live translations. PAYG billing would be clearer (and extendable to different rates) if `cacheChars` and `liveChars` are tracked separately.

### Issue 4 — Per-request `Math.ceil` rounding over-charges small requests
A 5-char request gets rounded up to 1 kilochar (1 unit). 200 requests of 5 chars = 200 units billed but only 1 unit of actual usage. This is inherent to integer Stripe meter values, but the calculation should at least use the most accurate char count possible.

### Issue 5 — `/dictionary` endpoint billing metric
`totalChars = word.length + english.length + contextStr.length` mixes input fields of varying relevance. The dictionary always calls the LLM — the billable work is the word lookup, not the context string length. This is a secondary concern but worth documenting.

---

## Implementation Approach

### Changes to `/translate` — PAYG billing section

After the translation flow completes (after `existingMap`, `toTranslate`, and optional Azure call), calculate:

```js
// Chars from cache hits (translatable, not skipped, not multi-word, found in cache)
let cacheChars = 0;
let liveChars = 0;

for (let i = 0; i < cleanedData.length; i++) {
  if (skipIndices.has(i)) continue;           // non-translatable: don't charge
  if (hitStatuses[i] && !multiWordIndices.has(i)) {
    cacheChars += cleanedData[i].cleaned.length;  // cache hit
  }
}
for (const item of toTranslate) {
  liveChars += item.text.length;              // cache miss / live Azure call
}

const billableChars = cacheChars + liveChars;
```

Then replace the PAYG billing block:

```js
if (user && user.plan_status === "payg") {
  await incrementUserTrialChars(req.userId, billableChars);

  const freshUser = await getUserById(req.userId);
  if (freshUser?.stripe_customer_id && stripe && billableChars > 0) {
    const charsToReport = Math.ceil(billableChars / 1000);
    setImmediate(async () => {
      try {
        await stripe.billing.meterEvents.create({
          event_name: "translation_chars",
          payload: {
            value: String(charsToReport),
            stripe_customer_id: freshUser.stripe_customer_id,
          },
        });
        console.log(`[payg] billed user=${req.userId} cache=${cacheChars} live=${liveChars} total=${billableChars} units=${charsToReport}`);
      } catch (e) {
        console.error("PAYG Stripe meter event failed (non-fatal):", e.message);
      }
    });
  }

  const charsUsedBefore = user.trial_chars_used ?? 0;
  const updatedCharsUsed = charsUsedBefore + billableChars;
  // ... rest of response unchanged
}
```

Also update the `free`/`pre` plan billing block to use `billableChars` (instead of `totalChars`) for consistency.

### Changes to `/dictionary` — PAYG billing section

The `/dictionary` endpoint has no cache — it always calls the LLM. The billable chars should represent the word being looked up, not the context. Simplify:

```js
const billableChars = word.trim().length;  // charge for the word being looked up
```

This is cleaner than charging for `word + english + context` lengths.

---

## Files to Modify

| File | Section | Change |
|------|---------|--------|
| `index.js` | `/translate` lines ~1100–1140 | Add `cacheChars`/`liveChars` calculation after translation flow |
| `index.js` | `/translate` lines ~1381–1416 | Replace `totalChars` with `billableChars` in PAYG block |
| `index.js` | `/translate` lines ~1419–1438 | Replace `totalChars` with `billableChars` in free/pre block |
| `index.js` | `/dictionary` lines ~1489 | Change `totalChars` to `word.trim().length` |
| `index.js` | `/dictionary` lines ~1531–1564 | Use updated `totalChars` in PAYG block |

---

## Data Model / API Changes

None. No schema changes required. The `trial_chars_used` field continues to accumulate billable chars. The Stripe meter event format is unchanged — only the value computed changes.

---

## Verification Approach

1. **All-cache scenario**: Send a `/translate` request with all segments already in cache. Confirm Stripe meter event fires with `cacheChars > 0`.
2. **All-live scenario**: Send a `/translate` request with no cached segments. Confirm `liveChars > 0` and meter event fires.
3. **Mixed scenario**: Verify `billableChars = cacheChars + liveChars` and meter event value = `Math.ceil(billableChars / 1000)`.
4. **Skip-only scenario**: Send only numbers/emojis. Confirm `billableChars = 0` and no meter event fires.
5. **`/dictionary`**: Confirm meter event fires with `word.trim().length / 1000` (rounded up).
6. **Logging**: Check server logs for `[payg] billed` lines showing cache/live breakdown.
7. **Lint**: Run `npm run lint` if available to confirm no syntax errors.
