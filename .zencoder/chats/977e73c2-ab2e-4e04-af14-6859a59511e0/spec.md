# Technical Specification: Fix `/usage` Endpoint to Return Real Lara Usage

## Difficulty: Medium
The task is conceptually simple but complicated by the fact that Lara has no documented usage/billing API endpoint.

## Technical Context
- **Language**: JavaScript (Node.js)
- **Dependencies**: `@translated/lara` (v1.7.4), `axios`, `express`, `pg`
- **Lara SDK base URL**: `https://api.laratranslate.com`
- **Lara SDK auth**: HMAC signing with `LARA_ACCESS_KEY_ID` / `LARA_ACCESS_KEY_SECRET` → JWT token

## Problem
The current `/usage` endpoint (in `index.js` line 622) calls `getMonthlyUsage()` from `analytics.js`, which queries the local `translation_usage` PostgreSQL table for characters sent to Lara this month. This returns ~76k while the Lara dashboard shows ~3M — a 40x discrepancy.

## Root Cause
- Backend only tracks characters that flow through its `/translate` endpoint
- Character counting may differ from Lara's internal counting
- The backend tracking was likely added after significant usage had already occurred

## API Research Findings
- **Lara SDK** (`@translated/lara`): No `getUsage()` or similar method exists. SDK exposes: translate, documents, images, memories, glossaries, detect, getLanguages.
- **Lara REST API docs**: No documented usage/billing/quota endpoint.
- **Lara dashboard** (`app.laratranslate.com`): Uses React Router loader at route `/getUsageQuota` with session-based auth. Response shape: `{ textTranslationQuota: { currentValue, threshold }, documentTranslationQuota, interpreterQuota }`.
- **Lara API base**: `https://api.laratranslate.com` with HMAC auth → JWT bearer tokens.

## Implementation Approach

### Strategy: Probe for undocumented usage endpoint, with fallback

1. **Primary**: Write a probe script to test undocumented endpoints on `api.laratranslate.com` (e.g., `/v2/usage`, `/v2/account`, `/v2/quota`, `/v2/account/usage`) using the SDK's auth mechanism.
2. **If found**: Update `/usage` route to call that endpoint.
3. **Fallback**: If no usage API exists, update `/usage` to clearly indicate the data source limitation and suggest the user check Lara dashboard. Optionally add `LARA_MONTHLY_CHAR_LIMIT` env var support for the total.

### Implementation Details

#### Files to modify:
- `index.js` — Update `/usage` route handler
- `analytics.js` — Update `getMonthlyUsage()` or add new function for Lara API usage

#### Data Model / API Changes:
- `/usage` response shape stays the same: `{ used, total, percentage }`
- New env var (optional): `LARA_MONTHLY_CHAR_LIMIT` (already referenced in analytics.js)

## Verification
- `npm start` — server starts without errors
- `GET /usage` — returns response with real Lara usage data
- No lint/typecheck scripts configured in this project
