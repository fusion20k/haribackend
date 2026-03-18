# Implementation Report: /usage Endpoint with Dedicated Usage Table

## What was implemented

### 1. New `usage` database table (db.js)
- Created in `initDatabase()` with columns: `id`, `current_month_usage_chars`, `usage_reset_date`
- Singleton row (id=1) seeded on first init with `ON CONFLICT DO NOTHING`
- Reset date computed from `LARA_BILLING_RESET_DAY` env var (defaults to 1st of month)

### 2. Three new db helper functions (db.js)
- `resetUsageIfNeeded()` — checks if current date >= reset date, resets counter and rolls forward
- `getUsage()` — calls resetUsageIfNeeded then returns the usage row
- `incrementUsage(chars)` — atomically increments `current_month_usage_chars`

### 3. Replaced `/usage` endpoint (index.js)
- Now reads from the `usage` table via `getUsage()`
- Returns `{ used, total }` where total comes from `LARA_MONTHLY_CHAR_LIMIT` env var (default 10M)

### 4. Pre-call guard in `/translate` (index.js)
- Before Lara API calls, checks `current_month_usage_chars + requestChars > QUOTA * 0.95`
- Returns `503 { error: "usage_cap_reached" }` if over 95%

### 5. Post-call increment in `/translate` (index.js)
- After successful Lara translation, increments usage by the total chars of cache-miss segments only

### 6. Environment variables
- `LARA_BILLING_RESET_DAY` — day of month for billing cycle reset (default: 1)
- `LARA_MONTHLY_CHAR_LIMIT` — monthly character quota (default: 10,000,000)
- Both added to `.env.example`

## How the solution was tested
- Syntax validation via `node -c` on both db.js and index.js — passed
- No runtime test (requires DATABASE_URL and Lara credentials)

## Challenges
- The project already had a `/usage` endpoint using analytics-based calculation. Replaced it with the dedicated table approach as specified, keeping the old `getMonthlyUsage()` in analytics.js for backward compatibility.
