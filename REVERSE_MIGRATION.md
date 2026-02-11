# URGENT: Reverse Timestamp Migration

The previous migration went the wrong direction. Run this SQL in **Supabase SQL Editor** to fix it:

---

## Fix Timestamps - Run in Supabase SQL Editor

```sql
-- Reverse users table migration
UPDATE users 
SET created_at = created_at AT TIME ZONE 'America/New_York' AT TIME ZONE 'UTC'
WHERE created_at IS NOT NULL;

-- Reverse subscriptions table (created_at)
UPDATE subscriptions 
SET created_at = created_at AT TIME ZONE 'America/New_York' AT TIME ZONE 'UTC'
WHERE created_at IS NOT NULL;

-- Reverse subscriptions table (updated_at)
UPDATE subscriptions 
SET updated_at = updated_at AT TIME ZONE 'America/New_York' AT TIME ZONE 'UTC'
WHERE updated_at IS NOT NULL;

-- Reverse subscriptions table (current_period_end)
UPDATE subscriptions 
SET current_period_end = current_period_end AT TIME ZONE 'America/New_York' AT TIME ZONE 'UTC'
WHERE current_period_end IS NOT NULL;

-- Reverse translations table
UPDATE translations 
SET created_at = created_at AT TIME ZONE 'America/New_York' AT TIME ZONE 'UTC'
WHERE created_at IS NOT NULL;
```

This will bring the timestamps back to where they were before.

---

## Better Approach: Use TIMESTAMPTZ

The issue is that PostgreSQL TIMESTAMP (without timezone) can cause confusion. Here's a better long-term solution:

### Option 1: Store as UTC, Display as EST (Recommended)
- Keep database timestamps in UTC
- Convert to EST when displaying to users
- This is the standard industry practice

### Option 2: Use TIMESTAMPTZ columns
- Migrate columns from TIMESTAMP to TIMESTAMPTZ
- Store with timezone information
- PostgreSQL handles conversions automatically

---

## Immediate Action

1. Run the SQL above to reverse the incorrect migration
2. Leave timestamps as they were originally
3. Handle timezone display in the application layer if needed
