# Technical Specification: Unified Character Billing

## Complexity Assessment
**Hard** — involves multiple services with inconsistent counting logic, both per-user quota tracking and global server-side quota tracking, Stripe metered billing, and PAYG/premium/free plan differences across three endpoints.

---

## Technical Context

- **Language / Runtime**: Node.js (CommonJS)
- **Key dependencies**: `pg`, `stripe`, `axios`, `express`, `jsonwebtoken`, `bcrypt`
- **Azure Services in use**:
  - Azure Translator (`/translate` endpoint → `azureTranslate`, `azureDictionaryLookup`)
  - Azure OpenAI (`/dictionary` endpoint → `llmDictionary`)
  - Azure TTS (`/tts` endpoint → Azure Speech REST API)
- **Billing plans** (`users.plan_status`):
  - `free` — 25,000 chars/30 days, `trial_chars_limit = 25000`
  - `pre` — premium/paid, 1,000,000 chars/30 days, `trial_chars_limit = 1000000`
  - `payg` — pay-as-you-go, no cap; Stripe metered billing per 1K chars
  - `active` — legacy/unused transitional state; **no quota enforcement applied** (leave as-is)
- **Quota fields** on `users`:
  - `trial_chars_used` — running total of chars consumed this billing window
  - `trial_chars_limit` — per-plan cap (25K free, 1M premium, 20M payg soft-cap)
  - `chars_used_at_payg_start` — baseline to compute net PAYG usage display
  - `free_chars_reset_date` — date when `trial_chars_used` resets to 0
- **Global server-side quota** in `usage` table (`incrementUsage`):
  - Tracks raw Azure Translator chars only (protects against blowing the app-level Azure quota)
  - Checked before each translate request (95% threshold → 503)

---

## Current State Analysis

### `/translate` endpoint
- Computes `totalChars` = sum of all normalized text lengths (including non-translatable/skipped segments).
- Computes `cacheChars` = chars of cache-hit single-word segments (excluding skipped).
- Computes `liveChars` = chars actually sent to Azure Translator.
- Computes `billableChars = cacheChars + liveChars`.
- **PAYG**: charges `billableChars` to `trial_chars_used` and reports `billableChars` to Stripe metered billing.
- **free/pre**: charges **`totalChars`** (not `billableChars`) to `trial_chars_used`. ← **Bug/inconsistency**
- `incrementUsage` (global server quota): called with `azureChars` (only live Azure calls, not cache). ✓ Correct for cost guard.
- **Cache hits are billed** to PAYG users. ✓ Intended.
- Cache hits are NOT counted in `incrementUsage`. ✓ Correct (they cost nothing on Azure).

### `/dictionary` endpoint
- Uses Azure OpenAI LLM.
- `totalChars = word.trim().length` — only the word, not the `english` or `context` inputs. ← **Underbilling risk**: LLM processes all three inputs.
- Checks free/pre quota before serving. ✓
- Charges `totalChars` to `trial_chars_used` for free/pre and PAYG. ✓ (but undercounts)
- **Does NOT call `incrementUsage`**. ← **Gap**: global cost guard doesn't account for LLM calls.
- Users with `plan_status = 'active'` get through without any char charge. ← **Minor**: `active` appears legacy/unused.

### `/tts` endpoint
- Uses Azure Speech TTS.
- `ttsChars = text.length`, `weightedChars = ttsChars * 2` (TTS priced 2× per char on Azure).
- Checks free/pre quota before serving. ✓
- Charges `weightedChars` to `trial_chars_used` for free/pre and PAYG. ✓
- Bills `weightedChars` to Stripe for PAYG. ✓
- **Does NOT call `incrementUsage`**. ← **Gap**: global cost guard doesn't account for TTS calls.
- Users with `plan_status = 'active'` get through without any char charge. ← **Minor**.

### Global quota (`incrementUsage` / `usage` table)
- Only tracks Azure Translator live-call chars.
- Protects against server-level Azure overage (95% threshold = 503).
- Does **not** include LLM or TTS costs.

---

## Gaps / Inconsistencies Found

| # | Issue | Severity |
|---|-------|----------|
| 1 | `/translate` free/pre charged `totalChars` (includes non-translatable skips) instead of `billableChars` | **High** — overcharges free/pre users vs. PAYG |
| 2 | `/dictionary` only counts `word.length`, not full LLM input | **High** — underbills actual Azure OpenAI cost |
| 3 | `/dictionary` and `/tts` do not call `incrementUsage` | **Medium** — global cost guard is blind to 2/3 services |
| 4 | `/translate` charges free/pre `totalChars` vs. PAYG `billableChars` (inconsistent formula) | **High** — same as #1 |
| 5 | No per-service breakdown in `translation_usage` analytics | **Low** — harder to audit costs per service |
| 6 | `active` plan users bypass all char counting (legacy state) | **Low** — appears unused in practice |
| 7 | Pre-check quota enforcement is non-atomic (race condition on concurrent requests) | **Low** — edge case, acceptable for now |

---

## Unified Billing Proposal

### Principle
> **Bill the same chars for the same service across all plans.** Cache hits and live calls are both billed to users (they consume quota regardless of whether we paid Azure for them). Only live Azure calls count against the global server cost guard.

### Per-service char formula

| Service | User quota chars | Stripe PAYG units | Global `incrementUsage` |
|---------|-----------------|-------------------|------------------------|
| Translator (live) | `text.length` per segment | `ceil(sum / 1000)` | `sum` (live only) ✓ already correct |
| Translator (cache hit) | `text.length` per segment | `ceil(sum / 1000)` | `0` (no Azure cost) ✓ already correct |
| Dictionary / LLM | `word.length + english.length + context.length` | `ceil(totalChars / 1000)` | `totalChars` (raw, no weighting) ← add |
| TTS | `text.length * 2` (weighted) | `ceil(weightedChars / 1000)` | `text.length` (raw, no weighting) ← add |

**Rationale for TTS split:** User quota uses `* 2` to reflect that TTS consumes quota 2× faster (fairness to the service's higher Azure cost), but `incrementUsage` tracks raw Azure-billed characters (the Azure TTS pricing is per character sent, not weighted), so raw `text.length` is the accurate cost-guard figure.

### Plan enforcement

| Plan | Cap | Reset | Action at cap |
|------|-----|-------|---------------|
| `free` | 25,000 chars / 30 days | `free_chars_reset_date` | 402 `trial_exhausted` |
| `pre` | 1,000,000 chars / 30 days | `free_chars_reset_date` | 402 `monthly_limit_reached` |
| `payg` | None (soft warn at 20M) | `free_chars_reset_date` | Stripe meter; soft warning |

### Cache hit billing policy
Cache hits **are** billed to user quota (all plans). This is correct — the user benefits from the translation regardless of where it came from. Only the server's Azure cost guard (`incrementUsage`) excludes cache hits.

---

## Data Model Changes

### `translation_usage` table — add `service_type` column
```sql
ALTER TABLE translation_usage
  ADD COLUMN IF NOT EXISTS service_type VARCHAR(20) NOT NULL DEFAULT 'translator';
```
Values: `'translator'`, `'llm'`, `'tts'`

This allows per-service cost analytics without schema rework.

### `db.js` `initDatabase`
Add migration block for `service_type` column (same pattern as existing column-add migrations).

---

## Files to Modify

| File | Changes |
|------|---------|
| `db.js` | Add `service_type` migration in `initDatabase` |
| `index.js` | Fix 5 billing issues (see Implementation Plan) |
| `analytics.js` | Update `logTranslationUsage` to accept and store `service_type` |

---

## Verification Approach

1. Manual smoke test: create a free user, call `/translate`, `/dictionary`, `/tts` in sequence; verify `trial_chars_used` increments correctly for each.
2. Verify PAYG Stripe meter events fire with correct char counts for all three services.
3. Verify `incrementUsage` is called by `/dictionary` and `/tts`.
4. Verify `/translate` free/pre users are charged `billableChars` not `totalChars`.
5. Verify premium (`pre`) users are hard-stopped at 1,000,000 chars/month.
6. Check `npm run lint` / `node --check index.js` for syntax errors (no test framework found in `package.json`).
