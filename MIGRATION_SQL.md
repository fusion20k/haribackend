# Migrate Existing Timestamps to EST

Run this SQL directly in **Supabase SQL Editor** to convert all existing timestamps from UTC to EST.

---

## Option 1: Run in Supabase SQL Editor (Recommended)

1. Go to **Supabase Dashboard** → **SQL Editor**
2. Create **New query**
3. Copy and paste this SQL:

```sql
-- Migrate users table
UPDATE users 
SET created_at = created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'
WHERE created_at IS NOT NULL;

-- Migrate subscriptions table (created_at)
UPDATE subscriptions 
SET created_at = created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'
WHERE created_at IS NOT NULL;

-- Migrate subscriptions table (updated_at)
UPDATE subscriptions 
SET updated_at = updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'
WHERE updated_at IS NOT NULL;

-- Migrate subscriptions table (current_period_end)
UPDATE subscriptions 
SET current_period_end = current_period_end AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'
WHERE current_period_end IS NOT NULL;

-- Migrate translations table
UPDATE translations 
SET created_at = created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'
WHERE created_at IS NOT NULL;
```

4. Click **Run** (or press Ctrl+Enter)
5. Check results - you'll see how many rows were updated

---

## Option 2: Run Migration Script Locally

**Requirements:**
- Add your Supabase DATABASE_URL to `.env` file

**Steps:**

1. Add to `.env`:
```
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@[YOUR-PROJECT].supabase.co:5432/postgres
```

2. Run migration:
```bash
node migrate-timestamps-to-est.js
```

3. Type `y` to confirm

---

## What Gets Updated

### Users Table
- `created_at` → Converted from UTC to EST

### Subscriptions Table
- `created_at` → Converted from UTC to EST
- `updated_at` → Converted from UTC to EST
- `current_period_end` → Converted from UTC to EST

### Translations Table
- `created_at` → Converted from UTC to EST

---

## Example Results

**Before (UTC):**
```
created_at: 2024-02-11 19:30:00
```

**After (EST):**
```
created_at: 2024-02-11 14:30:00  (5 hours earlier)
```

---

## Verify Migration

After running, check a few timestamps:

```sql
SELECT id, email, created_at FROM users ORDER BY id LIMIT 5;
SELECT id, created_at, updated_at FROM subscriptions LIMIT 5;
SELECT id, created_at FROM translations LIMIT 5;
```

Timestamps should now show in EST (will look 5 hours earlier than before).

---

## Important Notes

- ✅ **Safe operation** - Only updates timestamps, doesn't delete data
- ✅ **Idempotent** - Can be run multiple times safely
- ✅ **No downtime** - Database remains accessible during migration
- ⚠️ **One-time only** - Only run this once, or timestamps will be converted twice

---

## Recommended Approach

**Use Supabase SQL Editor** (Option 1) - it's the simplest and most direct method.
