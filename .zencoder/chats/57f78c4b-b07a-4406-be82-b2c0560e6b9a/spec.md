# Technical Specification: Fix Inaccurate Translation Caching

## Difficulty: Medium

The root cause is clear and the fix is well-scoped, but it touches the core caching pipeline that serves every translation request and requires a data purge.

---

## Problem Statement

Multiple distinct English source texts (e.g., "submit a helpdesk ticket", "powered by", "skip", "contact", "loading") all have `translated_text = "Email Address *"` in the `translations` table. Users see wrong translations served from cache.

---

## Root Cause Analysis

### 1. Weak 32-bit hash in `simpleHash` (PRIMARY)

`db.js:simpleHash` uses a DJB2-variant hash truncated to a 32-bit signed integer via `hash & hash`. The hex output has at most ~4.3 billion distinct values. By the birthday paradox, collision probability reaches:
- ~1% at 10,000 entries
- ~50% at 77,000 entries

When a collision occurs, two completely unrelated texts share the same cache key.

### 2. No `original_text` verification on cache lookup (CRITICAL)

`findTranslationsByKeys` queries only by `key`:

```sql
SELECT key, translated_text, hit_count FROM translations WHERE key = ANY($1)
```

The `original_text` column is stored but **never checked** during lookup. When a hash collision occurs, the wrong `translated_text` is returned silently — no defense-in-depth exists.

### 3. `ON CONFLICT (key, domain) DO NOTHING` makes bad data permanent

In `insertTranslations`, the first translation cached for a given key wins forever. If that first entry is wrong (due to collision or any other bug), it can never be corrected by subsequent correct translations.

### 4. `normalizeSegment` trailing-space inconsistency

`normalizeSegment` strips trailing punctuation characters (`*`, `.`, `!`, etc.) but does NOT strip the whitespace that precedes them:
- `"Email Address *"` → `"email address "` (trailing space)
- `"Email Address"` → `"email address"` (no trailing space)

These produce different hashes, so this isn't the collision cause, but it means the normalization isn't fully canonical — two semantically-identical texts get different cache keys, wasting cache entries and creating potential for subtle bugs.

### 5. Cache key does not include `original_text` for collision resolution

The `translations` table has a unique index on `(key, domain)`. The key is `${domain}:${hex_hash}`. There is no way to distinguish colliding texts at the schema level.

### How the bug manifests

1. "Email Address *" is translated first. `cleanSegment` strips ` *` decorations → sends `"Email Address"` to Azure → Azure returns a translation → `reattachDecorations` appends ` *` back → cached as `translated_text = "Email Address *"` with key `K`.
2. A different text ("submit a helpdesk ticket") later hashes to the same key `K`.
3. `findTranslationsByKeys` finds the row by key, returns `"Email Address *"` without checking `original_text`.
4. The user sees "Email Address *" displayed where "submit a helpdesk ticket" should be translated.

---

## Technical Context

- **Runtime**: Node.js v18, Express
- **Database**: PostgreSQL (Supabase)
- **Key dependencies**: `pg`, `crypto` (built-in, unused currently), `axios`
- **No test framework or linter configured** (`package.json` has only `start` and `dev` scripts)

---

## Implementation Approach

### Fix 1: Replace `simpleHash` with SHA-256

Replace `simpleHash` in `db.js` with `crypto.createHash('sha256')`. Use the first 16 hex characters (64 bits) as the hash — collision probability drops to negligible (~1 in 10^15 at 100K entries). No new dependencies needed; `crypto` is built into Node.js.

### Fix 2: Add `original_text` verification on cache lookup

Modify `findTranslationsByKeys` to also return `original_text`. In the `/translate` endpoint, when building `existingMap`, verify that the cached row's `original_text` matches the current `normalizedText`. On mismatch, treat as a cache miss.

This is defense-in-depth: even with SHA-256, verifying original_text catches any future edge case.

### Fix 3: Change `ON CONFLICT DO NOTHING` → `ON CONFLICT DO UPDATE`

In `insertTranslations`, switch to `ON CONFLICT (key, domain) DO UPDATE SET translated_text = EXCLUDED.translated_text, original_text = EXCLUDED.original_text`. This allows corrections to overwrite stale/wrong entries.

### Fix 4: Fix `normalizeSegment` trailing-space bug

Add a final `.trim()` call after the trailing-punctuation strip in `normalizeSegment`, so `"email address "` and `"email address"` produce the same normalized form and share the same cache key.

### Fix 5: Purge existing cache data

All existing rows in the `translations` table were cached under the old weak hash. They should be truncated. The cache will naturally repopulate with correct translations under the new hash.

This can be done as part of `initDatabase()` — a one-time migration that detects old-format keys and truncates the table.

---

## Source Code Changes

| File | Change |
|------|--------|
| `db.js` | Replace `simpleHash` with SHA-256; update `makeBackendKey`; update `findTranslationsByKeys` to return `original_text`; change `insertTranslations` to `ON CONFLICT DO UPDATE`; add one-time cache purge in `initDatabase` |
| `hash.js` | Update `simpleHash` to SHA-256 (or remove if only `db.js` is used) |
| `index.js` | Update `existingMap` construction to verify `original_text` matches `normalizedText` before treating as cache hit |
| `segmentation.js` | Add `.trim()` at end of `normalizeSegment` |

---

## Data Model Changes

No schema changes. The existing `translations` table columns (`key`, `original_text`, `translated_text`, `domain`) are sufficient. The unique index `idx_translations_key_domain` on `(key, domain)` remains.

The only data change is a one-time `TRUNCATE translations` to purge bad cache entries.

---

## API / Interface Changes

**None.** The `/translate` endpoint request/response format is unchanged. The Chrome extension does not need any modifications. The fix is entirely server-side.

---

## Frontend Extension Impact

No changes needed. The API contract (`POST /translate` with `{ sourceLang, targetLang, segments, domain }` → `{ translations: [...] }`) is unchanged.

---

## Verification Approach

1. **Unit verification**: Write a small script that hashes several known texts with the new SHA-256-based function and confirms no collisions, and that `normalizeSegment` produces consistent output (no trailing spaces).
2. **Integration check**: Start the server locally, confirm `initDatabase` runs the cache purge, and make a test `/translate` request to verify translations are fetched from Azure and cached correctly.
3. **Cache verification**: After a translation is cached, make the same request again and confirm it returns the cached result (cache hit). Make a different request and confirm it returns a different translation (no cross-contamination).
4. **Regression check**: Verify that the server starts without errors and all existing endpoints still respond correctly (`/health`, `/me`, `/translate`).
