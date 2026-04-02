# Implementation Report: Wrong Translations Stored in Cache

## What Was Implemented

Three confirmed bugs in the translation cache system were fixed, plus one edge-case improvement to echo detection.

### Bug 1 (Critical) — Decorations baked into `translated_text`

**File**: `index.js` (primary path L934–941, retry path L962–969)

`rowsToInsert` previously stored `finalTranslation` (the decorated value — punctuation and emojis reattached) as `translated_text`. This meant every cache entry was poisoned with the decorations of whichever request first populated it.

**Fix**: Store `tl` (the raw Azure output, no decorations) as `translated_text`. Decorations are now reattached at read time, not write time.

### Bug 2 (Medium) — `normalizeSegment` / `cleanSegment` key asymmetry

**File**: `index.js` (L845–847), `db.js` (`makeBackendKey`)

Cache keys were generated from `normalizeSegment(text)`, which strips only **trailing** punctuation. But the text sent to Azure is `cleanSegment(text).cleaned`, which strips **both** leading and trailing punctuation. This caused key/text mismatches for segments with leading punctuation (e.g., `"* Shopping"`).

**Fix**:
- Key generation now uses `cleanedData[i].cleaned.toLowerCase()` — the exact same form sent to Azure.
- `original_text` in `rowsToInsert` also uses `decorations.cleaned.toLowerCase()` for consistency.
- The mismatch guard on cache hits now compares against `cleanedData[index].cleaned.toLowerCase()`.

### Bug 3 (Medium) — Cache hit serves old decorated value

**File**: `index.js` (L880)

When serving a cache hit, the code returned `cached.translated_text` directly. After Bug 1 is fixed, this is the raw Azure output — but without decorations, which need to be applied per-request.

**Fix**: Cache hit path now calls `reattachDecorations(cached.translated_text, cleanedData[index])` so the current request's decorations (leading/trailing punctuation, emojis) are applied to the clean cached translation.

### Cache Invalidation — `v2:` key prefix

**File**: `db.js` (`makeBackendKey`, `initDatabase`)

The key format was changed from `${domain}:${hash}` to `v2:${domain}:${hash}`. This automatically invalidates all existing (decorated) cache entries without needing to inspect their values. On startup, `initDatabase` now deletes any rows where `key NOT LIKE 'v2:%'`, cleaning up stale pre-fix entries. This is additive to the existing weak-hash purge.

### Edge Case — `isEchoedTranslation` strips emojis and punctuation from Azure output

**File**: `segmentation.js` (`isEchoedTranslation`)

Previously, if Azure echoed back the input with emojis or punctuation appended (e.g., `"Email Address 😊"`), it would not be detected as an echo because `normOut !== normIn`. The fix strips `EMOJI_REGEX` and `PUNCT_TRIM_REGEX` from the Azure output before comparison, making echo detection robust to decoration leakage in Azure responses.

---

## How the Solution Was Tested

Testing was performed via manual code inspection and trace-through of the three original bug scenarios described in the spec:

1. **Same normalized text, different decorations** (`"Email Address"`, `"Email Address *"`, `"Email Address,"`): All three now map to the same `v2:` key (keyed on `"email address"`) and the DB stores the same clean `translated_text`. Each response gets its own decorations reattached at serve time.

2. **Cache hit with different decoration context**: First request populates cache with `tl` (raw). Second request hits cache and calls `reattachDecorations(cached.translated_text, cleanedData[index])`, correctly applying the second request's decoration context.

3. **Leading punctuation segment** (`"* Shopping"`): Key is now computed from `"shopping"` (the cleaned form), matching what Azure receives. `original_text` stores `"shopping"`. Decorations `"* "` are reattached on read.

4. **Emoji-only segments**: `isTranslatable` returns false (no `[a-zA-Z]`), so they go to `skipIndices` and the original text is returned unchanged — no DB access, no Azure call.

5. **Mixed emoji+text** (`"Buy now 🛒"`): `cleanSegment` strips the emoji, `"Buy now"` is sent to Azure and keyed. On response, `reattachDecorations` reattaches `" 🛒"` to the translation.

6. **Node import check**: `node -e "require('./db'); require('./segmentation')"` — no import errors.

---

## Biggest Challenges

- **Cache invalidation without a schema change**: The key format change (`v2:` prefix) was the cleanest way to force a cold cache without altering the DB schema or adding a migration table. The existing startup purge pattern (detecting old weak-hash keys via regex) was extended with a `NOT LIKE 'v2:%'` check.

- **Keeping `original_text` consistent with the new key scheme**: After fixing key generation to use the cleaned form, the `original_text` column and the mismatch guard both needed to be updated to use the same cleaned form — otherwise the guard would always fire and every cache hit would be treated as a miss.

- **`isEchoedTranslation` receiving pre-cleaned input but raw Azure output**: The function signature documents `cleanInput` as already stripped, but `cleanOutput` is the raw Azure response. Stripping emojis and punctuation only from `cleanOutput` (not `cleanInput`) preserves the intended behavior while handling decoration leakage from Azure.
