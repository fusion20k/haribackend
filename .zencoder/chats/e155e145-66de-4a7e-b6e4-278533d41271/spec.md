# Technical Specification: Wrong Translations Stored in Cache

## Difficulty: Medium

---

## Technical Context

- **Language / Runtime**: Node.js (CommonJS)
- **Key dependencies**: `pg` (PostgreSQL), `axios` (Azure Translator), `express`
- **Primary files**: `index.js` (translation endpoint ~L751–L1046), `db.js` (`insertTranslations`, `findTranslationsByKeys`, `makeBackendKey`), `segmentation.js` (`normalizeSegment`, `cleanSegment`, `reattachDecorations`, `isEchoedTranslation`)

---

## Root Cause Analysis

### Bug 1 (PRIMARY — Confirmed): Decorations baked into `translated_text`

**Location**: `index.js` ~L932–L941

```js
const finalTranslation = reattachDecorations(tl, decorations); // decorations = cleanedData[index]
translations[index] = finalTranslation;
rowsToInsert.push({
  key,
  original_text: normalizedTexts[index],
  translated_text: finalTranslation,   // ← decorated value stored in DB
  ...
});
```

The cache stores the **decorated** translation (leading/trailing punctuation and emojis reattached) as `translated_text`. But the cache key is computed from `normalizedTexts[index]`, which is the segment with decorations stripped. This creates a mismatch:

- Request 1: segment = `"Email Address *"` → `normalizedText = "email address"`, `trailingPunct = " *"` → Azure returns `"Email Address"` → `finalTranslation = "Email Address *"` → stored in DB as `translated_text = "Email Address *"` under key `hash("email address")`
- Request 2: segment = `"Email Address"` (no asterisk) → same key `hash("email address")` → **cache hit** → serves `"Email Address *"` — **wrong decoration served**

Worse: when `ON CONFLICT DO UPDATE` fires (same key, different request), the cached entry is overwritten with the new request's decorated value, corrupting the cache for all future users of that key.

This is the most likely explanation for the reported symptom: a page section with `"Email Address *"` gets processed, its decorated (or even raw-English) form is stored in the DB. A later request for another segment that normalises to the same key (or the same entry is mutated through a conflict update referencing a wrong decorated value) gets back `"Email Address *"`.

**Additionally**, if Azure returns the cleaned input verbatim but with different casing or minor differences (e.g. `"Email Address"` cleaned input → Azure returns `"Email Address *"` because it preserves form-label notation), `isEchoedTranslation` will NOT detect it as echoed (the asterisk makes `normOut !== normIn`) and `"Email Address *"` will be stored as the translation under whatever key sent that text to Azure — **potentially poisoning an unrelated key** if the decorated form of that key happens to match an earlier segment's decoration pattern.

---

### Bug 2 (Secondary — Confirmed): `normalizeSegment` vs `cleanSegment` key/text discrepancy

**Location**: `index.js` L845–L847 vs L807

The cache key is computed from `normalizeSegment(text)`, which strips only **trailing** punctuation. But the text actually sent to Azure is `cleanSegment(text).cleaned`, which strips **both leading and trailing** punctuation.

Example: segment = `"* Email Address *"`
- Cache key is keyed on `"* email address"` (leading `*` preserved in normalised form)
- Azure receives `"Email Address"` (leading `*` stripped)
- DB stores `original_text = "* email address"` paired with the translation of `"Email Address"`

A future request for `"* Email Address"` (same normalised form) correctly hits this cache. However, a request for `"Email Address"` gets a **different key** (`hash("email address")` vs `hash("* email address")`), so it will miss the cache and call Azure again. The cache entry under the leading-punct key effectively goes stale and wastes space.

More critically: the `original_text` mismatch guard (`cached.original_text !== normalizedTexts[index]`) cannot detect true semantic mismatches — only SHA-256 key collisions (near-impossible). It will NOT catch the case where the decorated value is wrong for the current request's decoration context.

---

### Bug 3 (Secondary): Cache served back with wrong decorations (consequence of Bug 1)

**Location**: `index.js` L879–L881

```js
translations[index] = cached.translated_text;   // ← full decorated value served
```

When a cache hit occurs, the full `translated_text` (with previously baked-in decorations from a different request) is returned to the client. There is no step to strip the old decorations and reattach the current request's decorations.

---

## Summary of Bugs

| # | Severity | Description | Location |
|---|----------|-------------|----------|
| 1 | **Critical** | Decorations reattached before storing → poisoned cache entries | `index.js` L932–L941 |
| 2 | **Medium** | `normalizeSegment` / `cleanSegment` asymmetry (leading punct) causes key/text mismatch | `index.js` L807, L845 |
| 3 | **Medium** | Cache hit serves old decorated translation regardless of current request's decoration context | `index.js` L879–L881 |

---

## Implementation Approach

### Core fix: Store clean translations in cache; reattach decorations at serve time

**Principle**: The `translated_text` column should store the **raw** Azure translation output (no decorations). Decorations are reattached when the value is read from cache, using the current request's `cleanedData[index]`.

#### Step 1: Change what `insertTranslations` stores

In the `rowsToInsert.push(...)` call (and the equivalent in the retry block), store `tl` (the raw Azure output) instead of `finalTranslation`:

```js
// BEFORE
rowsToInsert.push({
  key,
  original_text: normalizedTexts[index],
  translated_text: finalTranslation,         // decorated
  domain: validatedDomain,
});

// AFTER
rowsToInsert.push({
  key,
  source_lang: sourceLang,
  target_lang: targetLang,
  original_text: normalizedTexts[index],
  translated_text: tl,                       // raw Azure output, no decorations
  domain: validatedDomain,
});
```

#### Step 2: Reattach decorations when serving from cache

```js
// BEFORE (cache hit path)
translations[index] = cached.translated_text;

// AFTER
translations[index] = reattachDecorations(cached.translated_text, cleanedData[index]);
```

#### Step 3: Fix `normalizeSegment` / `cleanSegment` asymmetry (key generation)

The key should be derived from the **cleaned text** (same text that goes to Azure), not the normalised text. This makes the key semantically consistent with what is actually translated.

```js
// BEFORE
const keys = normalizedTexts.map((text) =>
  makeBackendKey(sourceLang, targetLang, text, validatedDomain)
);

// AFTER
const keys = cleanedData.map((cd) =>
  makeBackendKey(sourceLang, targetLang, cd.cleaned.toLowerCase(), validatedDomain)
);
```

And update `original_text` to store the cleaned (lowercased) form so the mismatch guard still works:
```js
original_text: cleanedData[index].cleaned.toLowerCase(),
```

> **Note**: Changing the key scheme will invalidate all existing cache entries. The DB's translation cache should be truncated after deployment, or the key scheme versioned (e.g., domain prefix changed to `v2:default`). The code already has a truncation path triggered by detecting old-format keys.

---

## Source Code Changes

| File | Change |
|------|--------|
| `index.js` | Cache hit path: reattach decorations from `cleanedData[index]` before assigning to `translations[index]` (L880) |
| `index.js` | `rowsToInsert.push(...)` in primary path: use `tl` (raw Azure output) instead of `finalTranslation` for `translated_text` (L934–L941) |
| `index.js` | `rowsToInsert.push(...)` in retry path: same change (L962–L969) |
| `index.js` | Key generation: use `cleanedData[i].cleaned.toLowerCase()` instead of `normalizedTexts[i]` (L845–L847) |
| `index.js` | `original_text` in `rowsToInsert`: use `cleanedData[index].cleaned.toLowerCase()` |
| `db.js` | No schema changes required; `translated_text` column continues to store text |
| `db.js` (optional) | Add a startup migration to truncate the cache (or bump the key prefix) to clear stale decorated entries |

---

## Data Model / API / Interface Changes

- **No API changes**. The `/translate` response format is unchanged.
- **Cache schema unchanged**. `translated_text` continues to hold a TEXT value; it just stores the clean translation instead of the decorated one.
- **Cache invalidation required** on deploy: existing decorated cache entries will be served and re-decorated, producing double-decoration bugs (e.g., `"pamimili *"` reattached with `" *"` again → `"pamimili * *"`). The safest approach is to truncate the `translations` table on first boot after the fix, or to change the domain key prefix to force a cold cache.

---

## Verification Approach

1. **Manual test**: Send a batch with the same normalized text but different decorations (e.g., `["Email Address", "Email Address *", "Email Address,"]`). Verify the DB stores the same clean `translated_text` for all three, and each response has correctly decorated output.
2. **Manual test**: Send a segment, confirm it reaches Azure. Send the same segment again, confirm it returns from cache with the correct decorated form matching the new request's context.
3. **Manual test**: Send a segment with leading punctuation (e.g., `"* Shopping"`). Verify the key and the stored `original_text` use the cleaned form.
4. **DB inspection**: After a translation request, query `SELECT key, original_text, translated_text FROM translations ORDER BY created_at DESC LIMIT 10` and confirm `translated_text` contains no leading/trailing punctuation or emojis.
5. **Regression**: Verify `translations` array in the HTTP response still has correct decorated output for both cache hits and cache misses.
6. Run `node -e "require('./db'); require('./segmentation')"` to confirm no import errors after changes.
