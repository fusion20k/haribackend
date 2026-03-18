# Technical Specification: Translation Segment Cleaning & Echo Detection

## Difficulty: Medium

## Technical Context
- **Language**: JavaScript (Node.js)
- **Dependencies**: No new dependencies needed. All text processing uses native JS regex/string methods.
- **Files to modify**: `segmentation.js`, `index.js`

## Problem
The Lara API sometimes echoes back English text unchanged for segments that are pure punctuation, emoji-only, or short common phrases. These get stored in the cache as "translated" when they're actually untranslated, causing the extension to display English where Tagalog should be.

## Implementation Approach

### 1. Add text cleaning utilities to `segmentation.js`

- **`stripPunctuation(text)`**: Strip leading/trailing punctuation and whitespace using the regex from the guidelines.
- **`stripEmojis(text)`**: Remove all emoji characters from text (Unicode ranges for emojis).
- **`cleanSegment(text)`**: Combine strip punctuation + strip emojis. Returns `{ original, cleaned, leadingPunct, trailingPunct, emojis }` so punctuation/emojis can be reattached.
- **`isTranslatable(cleaned)`**: Returns false if the cleaned text is empty or purely non-alphabetic (only numbers/symbols/punctuation remaining).
- **`reattachDecorations(translatedClean, decorations)`**: Reattach original leading punctuation, trailing punctuation, and emojis to the translated result.
- **`isEchoedTranslation(cleanInput, cleanOutput)`**: Case-insensitive comparison of normalized input vs output to detect when Lara just echoed the text back.

### 2. Update `normalizeSegment()` for cache key consistency

Update the normalization to match the frontend's approach:
- lowercase → trim → collapse whitespace → strip trailing punctuation → normalize quotes/ellipsis
- The existing function already does most of this except lowercase and stripping trailing punctuation.

### 3. Modify `/translate` endpoint in `index.js`

**Pre-translation:**
- For each segment, call `cleanSegment()` to get cleaned text + decorations.
- If cleaned text is not translatable (`isTranslatable()` returns false), mark it as "skip" — return original text as-is, don't cache.
- Only send translatable cleaned texts to Lara.

**Post-translation:**
- For each Lara result, call `isEchoedTranslation()` to compare cleaned input vs cleaned output.
- If echoed: for word-level segments, retry once. If still echoed, return original text, don't cache.
- If echoed: for sentence segments, return original text, don't cache.
- If valid translation: call `reattachDecorations()` to restore original punctuation/emojis to the translated text.
- Store the reattached result in cache.

### 4. Support `isWordLevel` flag from request

The extension will send an `isWordLevel` boolean in the request body. When true, echoed translations trigger a single retry. The flag is just used for retry logic — no schema changes needed.

## Source Code Structure Changes

### `segmentation.js` — New exports:
- `stripPunctuation(text)`
- `stripEmojis(text)`
- `cleanSegment(text)`
- `isTranslatable(text)`
- `reattachDecorations(translated, decorations)`
- `isEchoedTranslation(input, output)`
- Update `normalizeSegment()` to add lowercase + strip trailing punctuation

### `index.js` — Modify `/translate` handler:
- Import new functions from segmentation.js
- Add pre-processing loop (clean + check translatability)
- Modify Lara call to only send cleaned translatable texts
- Add post-processing (echo detection, retry for words, reattach decorations)
- Only cache valid (non-echoed) translations

## Data Model Changes
None. The existing `translations` table schema is sufficient. The `original_text` field will store the full original text, and `translated_text` will store the reattached (punctuation/emoji restored) translation.

## API Changes
- `/translate` request body gains optional `isWordLevel: boolean` field (backward compatible).
- Response shape unchanged: `{ translations: string[] }`.

## Verification Approach
- Manual testing with `npm start` and curl/Postman requests
- Test cases:
  1. Pure punctuation segment `"!!!"` → returned as-is, not cached
  2. Emoji-only `"🎉🎊"` → returned as-is, not cached
  3. Normal sentence `"Great job! 🎉"` → cleaned to "Great job", translated, emojis reattached
  4. Echo detection: if Lara returns same text → not cached
  5. Word-level `"exploring"` with `isWordLevel: true` → if echoed, retry once
  6. Cache key normalization matches frontend (lowercase, trimmed, collapsed whitespace)
