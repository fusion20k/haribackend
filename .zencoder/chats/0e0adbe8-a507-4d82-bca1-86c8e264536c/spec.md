# Cache Optimization - Technical Specification

## Difficulty: Medium

## Technical Context

- **Language**: JavaScript (Node.js)
- **Framework**: Express.js
- **Database**: PostgreSQL via `pg` pool (Supabase)
- **Translation API**: Lara AI (`@translated/lara`)
- **Key files**: `index.js`, `db.js`, `segmentation.js`, `hash.js`, `database-cleanup.sql`

---

## Current Issues

1. **Normalization is incomplete and happens in the wrong order**
   - `normalizeSegment()` in `segmentation.js` only does `trim()` + collapse whitespace
   - `makeBackendKey()` in `db.js` also only does trim + whitespace collapse
   - The normalized result from `validateSegment()` is returned but **not used** — raw text is sent to Lara and stored as `original_text`
   - Missing: quote/ellipsis normalization, invisible char stripping

2. **Cache keys don't include language codes in the hash**
   - Current: `sourceLang:targetLang:domain:hash(normalizedText)` — hash is text-only
   - Target: `hash(sourceLang|targetLang|normalizedText)` — more collision-resistant and cleaner

3. **Hit count updates are N individual queries**
   - `findTranslationsByKeys` runs one `UPDATE` per cached row found — should batch

4. **No `last_used_at` tracking**
   - Required for LRU-style cleanup of rarely used entries

5. **No cleanup mechanism**
   - No SQL for deleting stale entries older than X months

---

## Implementation Approach

### 1. Enhance `normalizeSegment` in `segmentation.js`
Add normalization steps in order:
- Strip invisible/zero-width chars (U+200B, U+FEFF, U+00AD, etc.)
- Normalize curly/smart quotes → straight quotes
- Normalize ellipsis character (`…`) → `...`
- Trim and collapse whitespace

This function is the single source of truth for normalization — used everywhere.

### 2. Fix translation flow in `index.js`
After validation, normalize each segment using the enhanced `normalizeSegment`:
```
normalizedTexts = textsToTranslate.map(normalizeSegment)
```
Use `normalizedTexts` for:
- Cache key generation
- Lara API call
- `original_text` stored in cache

### 3. Update `makeBackendKey` in `db.js`
Change hash input to include language codes:
```js
const input = `${sourceLang}|${targetLang}|${normalizedText}`;
const hash = simpleHash(input);
return `${domain}:${hash}`;
```
This makes the key self-contained (no raw lang prefix needed — it's in the hash). Domain prefix retained for readability/filtering.

> Note: This changes the key format, invalidating old cache entries. A DB cleanup is recommended (script already exists in `database-cleanup.sql`).

### 4. Batch `hit_count` + `last_used_at` updates in `findTranslationsByKeys`
Replace N individual UPDATEs with a single batched UPDATE:
```sql
UPDATE translations
SET hit_count = hit_count + 1, last_used_at = NOW()
WHERE key = ANY($1)
```

### 5. Add `last_used_at` column + cleanup SQL
- Add `last_used_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP` to the `translations` table in `initDatabase()`
- Add an index on `last_used_at` for efficient cleanup queries
- Add cleanup SQL to `database-cleanup.sql` for removing entries not used in > 90 days

---

## Source Code Changes

| File | Change |
|------|--------|
| `segmentation.js` | Enhance `normalizeSegment` with quotes, ellipsis, invisible chars |
| `index.js` | Normalize segments before key generation, use normalized for Lara + storage |
| `db.js` | Update `makeBackendKey` hash input; batch UPDATE in `findTranslationsByKeys`; add `last_used_at` to schema |
| `database-cleanup.sql` | Add stale entry cleanup SQL block |

---

## Data Model Changes

### `translations` table
- Add column: `last_used_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`
- Add index: `idx_translations_last_used_at ON translations(last_used_at)`
- Key format changes from `src:tgt:domain:hash(text)` to `domain:hash(src|tgt|text)`

---

## Verification

1. Start server locally: `npm start`
2. POST `/translate` with a text — check logs show cache miss → insert
3. POST `/translate` same text again — check logs show cache hit
4. Verify `last_used_at` updates in DB
5. Verify `hit_count` increments in a single query (check logs/DB)
6. Check normalization handles: curly quotes, ellipsis, zero-width spaces
