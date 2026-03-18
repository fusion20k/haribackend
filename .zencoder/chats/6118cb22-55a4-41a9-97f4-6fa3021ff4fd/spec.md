# Technical Specification: /usage Endpoint with Dedicated Usage Table

## Difficulty: Easy-Medium

## Technical Context
- **Language**: JavaScript (Node.js)
- **Framework**: Express
- **Database**: PostgreSQL (Supabase)
- **Existing patterns**: db.js for table creation/queries, analytics.js for usage tracking

## Implementation Approach

Replace the current `/usage` endpoint (which queries `translation_usage` on the fly) with a dedicated `usage` table that maintains a running counter. This is more efficient and aligns with the billing model.

### Files Modified
1. **db.js** — Add `usage` table creation in `initDatabase()`, add helper functions (`getUsage`, `incrementUsage`, `resetUsageIfNeeded`)
2. **index.js** — Replace `/usage` endpoint, add pre-call guard in `/translate`, increment counter after Lara calls

### Files NOT Modified
- **analytics.js** — Keep existing `getMonthlyUsage()` for backward compat; the `/usage` endpoint in index.js will use the new db functions instead

## Data Model Changes

### New Table: `usage`
| Column | Type | Description |
|---|---|---|
| `id` | SERIAL PRIMARY KEY | Always row id=1 (singleton) |
| `current_month_usage_chars` | INTEGER DEFAULT 0 | Running total of chars sent to Lara this billing month |
| `usage_reset_date` | DATE | Next billing cycle reset date |

### Seed Row
Insert a single row with `id=1`, `current_month_usage_chars=0`, `usage_reset_date` set to the 1st of next month (or configurable via env var).

## API Changes

### GET /usage (modified - no auth required)
**Response**: `{ "used": 4200000, "total": 10000000 }`
- Checks and resets if past billing date before returning
- No auth required (matches current behavior)

### POST /translate (modified)
- **Pre-call guard**: Before calling Lara, check if `current_month_usage_chars + requestChars > QUOTA * 0.95`. If so, return `503 { error: "usage_cap_reached" }`
- **Post-call increment**: After successful Lara translation, increment `current_month_usage_chars` by the number of characters actually sent to Lara (cache misses only)

## Verification
- `npm start` — server starts without errors, `usage` table created
- `GET /usage` — returns `{ used, total }` with correct values
- Translate calls increment the counter
- 95% guard returns 503
