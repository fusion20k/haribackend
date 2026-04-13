# Implementation Report: PAYG Billing Refinement

This report describes the changes made to the billing logic for the `/translate` and `/dictionary` endpoints to ensure consistent and fair charging for PAYG and trial users.

## What was implemented

### 1. Refined `/translate` Billing Metric
- **Consistent Character Count**: Switched from using `normalizedTexts` (which included punctuation and original formatting) to `cleanedData[i].cleaned.length` (which matches the text actually processed for translation).
- **Excluded Non-Translatable Segments**: Segments that contain no translatable characters (e.g., numbers, punctuation only, emojis) are now identified via `skipIndices` and excluded from `billableChars`.
- **Cache vs. Live Breakdown**: Added explicit tracking for `cacheChars` (segments found in the database) and `liveChars` (segments sent to Azure). 
- **Enhanced Logging**: Added a detailed log entry for PAYG users: `[payg] billed user=X cache=Y live=Z total=A units=B`.

### 2. Refined `/dictionary` Billing Metric
- **Simplified Billing**: Changed the billable character count from the sum of `word + english + context` to just `word.trim().length`. Since the dictionary service primarily focuses on the word lookup, this provides a more predictable and fair cost for users regardless of the amount of context provided.

### 3. Unified Billing Path
- Updated both the PAYG and the Free/Pre-paid blocks in both endpoints to use the new `billableChars` / `totalChars` metric, ensuring consistency across all plan types.

## How the solution was verified

- **Code Review**: Verified that `skipIndices` are correctly bypassed and that only translatable segments contribute to `cacheChars`.
- **Logic Consistency**: Confirmed that `liveChars` is derived directly from the `toTranslate` array, which contains the segments actually sent to the Azure Translation API.
- **Reporting Accuracy**: Verified that Stripe meter events are calculated using `Math.ceil(billableChars / 1000)`, ensuring units are correctly reported in kilochars.
- **Endpoint Parity**: Ensured that `/dictionary` uses the trimmed word length for its billing, matching the technical specification.

## Edge cases and challenges encountered

- **Multi-word cache hits**: The logic was carefully implemented to ensure that only single-word cache hits contribute to `cacheChars`. Multi-word segments are always treated as `liveChars` because they currently bypass the standard cache check and are sent to Azure for better context handling.
- **Rounding**: Per-request rounding (`Math.ceil`) is required by Stripe's integer-only meter values. While this can lead to slight over-charging for very small requests, using the cleaned character count minimizes the impact by not charging for non-translatable overhead.
- **Cache Mismatch**: Added a warning log for cases where a cache key exists but the `original_text` doesn't match the expected cleaned input, treating such cases as misses to ensure translation quality at the cost of a live call.
