# Spec: Strengthen `isValidTranslation` — Bad Translation Filtering

**Difficulty: Medium**

The deterministic pattern checks are each a handful of lines, but there are enough edge cases and false-positive risks to require careful design. The `live` → `Mabuhay` semantic issue is categorically different and cannot be caught by pattern matching alone — see the open question at the bottom.

---

## Technical Context

- **Language**: Node.js (CommonJS)
- **Key files**: `segmentation.js` (pure validator), `db.js` (startup migration), `index.js` (pipeline orchestration)
- **Target language pair in production**: English → Tagalog/Filipino (Latin script)
- **Correction flow**: Azure Translate → `isEchoedTranslation` / `isValidTranslation` → Azure Dictionary Lookup (fallback) → best-effort passthrough (no cache)

---

## Root Cause Analysis

### Case 1: `subscribe` → `Email Address *`

Azure Translate returned a UI label from the page it was trained on, complete with the HTML required-field asterisk. This fails for two distinct reasons:

- **Stray `*` in output**: current code only catches `*WORD*` pattern; must also catch any `*` not present in input
- **Multi-word Title-Cased output for 1-word input**: not checked at all

### Case 2: `live` → `Mabuhay`

"Mabuhay" means "Long live!" (a toast/greeting). This is a valid translation of the exclamatory sense of the English polyseme "live". In the streaming-app context, "live" means real-time, which Filipino media typically leaves as the English word "live" anyway.

This is a **context disambiguation failure**, not a structural/pattern defect. No regex can distinguish "live (adjective, real-time)" from "live (verb, to be alive)". See the open question below.

### Case 3: `watch` → `Panoorin` — Correct, no action needed.

---

## Full Edge-Case Catalogue

| Category | Example | Detectable? |
|---|---|---|
| Stray asterisk (required-field marker) | `Email Address *` | Yes — `*` in output but not in input |
| ALL_CAPS_SNAKE_CASE placeholder | `SUBSCRIBE_BUTTON` | Already caught |
| `*PLACEHOLDER*` pattern | `*email*` | Already caught |
| Extreme length explosion | 1 word → 800-char paragraph | Already caught |
| Empty / whitespace-only output | `""` or `"   "` | Yes — `trim().length === 0` |
| HTML/markup leaking | `<a href=...>` | Yes — `/<[a-zA-Z]/` |
| URL in output | `https://...` | Yes — `/https?:\/\//` |
| Encoding artifact (mojibake) | `â€™`, `Ã©` | Yes — known sequences |
| UI label pattern (all Title-Cased, all-ASCII, 3+ words for 1-word input) | `Please Enter Email` | Yes — with caveats |
| Context disambiguation | `live` → `Mabuhay` | No — semantic, out of scope |

---

## Implementation Approach

All new guards go into `isValidTranslation(inputText, outputText)` in `segmentation.js`. The function is called at every validation site in the pipeline (initial Azure result, retry result, and Dictionary Lookup result at line 1333 of `index.js`), so improvements propagate automatically to all three call sites.

### New guards (in order, fail-fast)

```js
// 1. Empty output
if (outputText.trim().length === 0) return false;

// 2. HTML/markup or URL content in output
if (/<[a-zA-Z]/.test(outputText) || /https?:\/\//.test(outputText)) return false;

// 3. Encoding artifacts (common UTF-8 double-decode sequences / mojibake)
if (/â€|Ã[^\s]|Â[^\s]/.test(outputText)) return false;

// 4. Stray asterisk in output that was not in the input
//    Catches "Email Address *" and UI required-field markers
if (outputText.includes("*") && !inputText.includes("*")) return false;

// 5. UI-label pattern: single-word input → 3+ words where every word is
//    Title-Cased AND the entire output is pure ASCII
//    Tagalog "Magandang umaga" (second word lowercase) → passes
//    Bad: "Please Enter Email" (all Title-Cased, all ASCII) → fails
const inputWordCount = inputText.trim().split(/\s+/).filter(Boolean).length;
const outputWords = outputText.trim().split(/\s+/).filter(Boolean);
if (
  inputWordCount === 1 &&
  outputWords.length >= 3 &&
  outputWords.every(w => /^[A-Z][a-z]*$/.test(w)) &&
  /^[\x00-\x7F]+$/.test(outputText)
) {
  return false;
}
```

**Threshold rationale for guard 5 — why 3+ words, not 2+:**
A 2-word Tagalog phrase is extremely common (e.g., `Walang Anuman` — "You're welcome"). Blocking at 2 words causes unacceptable false positives. A 3-word all-Title-Cased all-ASCII output for a single English input word is nearly always a UI label.

**The 2-word UI-label gap** (e.g., `Email Address` with no asterisk): would pass guard 5. It is caught by guard 4 whenever the asterisk is present. Without the asterisk, it slips through — this is an acceptable trade-off given false-positive risk at the 2-word threshold.

### DB migration in `initDatabase` (`db.js`)

Add immediately after the existing `phraseCheck` block, following the same check-then-delete pattern:

```js
const badTranslationCheck = await client.query(`
  SELECT 1 FROM translations
  WHERE translated_text LIKE '%*%'
     OR translated_text LIKE '%<%'
     OR translated_text LIKE '%http%'
  LIMIT 1
`);
if (badTranslationCheck.rows.length > 0) {
  const result = await client.query(`
    DELETE FROM translations
    WHERE translated_text LIKE '%*%'
       OR translated_text LIKE '%<%'
       OR translated_text LIKE '%http%'
  `);
  console.log(`Cache purged: ${result.rowCount} bad-translation entries removed.`);
}
```

### Files changed

| File | Change |
|---|---|
| `segmentation.js` | 5 new guards inside `isValidTranslation` |
| `db.js` | Startup migration to purge existing bad cached entries |

---

## API / Interface Changes

None. `isValidTranslation` signature is unchanged. `module.exports` in `segmentation.js` is unchanged.

---

## Verification Approach

Test cases for the new guards (Node REPL or quick-test script):

| Input | Output | Expected |
|---|---|---|
| `subscribe` | `Email Address *` | `false` — guard 4 (stray asterisk) |
| `subscribe` | `Email Address` | `true` — 2 words, below threshold |
| `subscribe` | `Please Enter Email` | `false` — guard 5 (3 Title-Cased ASCII words) |
| `subscribe` | `mag-subscribe` | `true` |
| `hello` | `(empty string)` | `false` — guard 1 |
| `hello` | `<b>Kumusta</b>` | `false` — guard 2 |
| `hello` | `https://example.com` | `false` — guard 2 |
| `morning` | `Magandang umaga` | `true` — second word lowercase, passes guard 5 |
| `run` | `Tumakbo Na Kayo Dito` | `false` — guard 5 (4 Title-Cased ASCII words) |

Startup verification: confirm the server log contains "Cache purged: N bad-translation entries removed." then run `SELECT COUNT(*) FROM translations WHERE translated_text LIKE '%*%'` and confirm it returns 0.

---

## Open Question — needs user decision before implementation

### The `live` → `Mabuhay` disambiguation problem

`Mabuhay` passes all structural checks — it is a legitimate single-word Tagalog translation. The issue is semantic: Azure chose the wrong sense of the English polyseme "live".

**Option A — Accept as known limitation.**
Context-aware translation of ambiguous words requires sentence context that the current single-word-segment pipeline does not provide. Azure will always guess, and sometimes guess wrong. This is the simplest path.

**Option B — LLM post-validation per word.**
After Azure translates a single-word segment, call the LLM asking "Is this the most common/neutral Tagalog translation for this word in a streaming-app context?" Adds ~1–2 s latency and cost per cache-miss word.

**Option C — Small override/blocklist JSON file.**
Maintain a short map of known bad en→tl overrides, e.g. `{ "live": "live" }` (Filipino streaming media keeps the English word). Low-maintenance, brittle if the list grows.

**Recommendation**: Option A (accept limitation) as the default, with Option C as an optional lightweight safety net for the handful of words clearly wrong in the streaming-app domain. Please confirm which direction you want before implementation proceeds.
