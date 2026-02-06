# Supabase Direct Access Management

Grant or revoke user access directly through **Supabase SQL Editor**.

---

## Step 1: Open Supabase SQL Editor

1. Go to your Supabase project dashboard
2. Click **SQL Editor** in left sidebar
3. Click **New query**

---

## Step 2: Find User ID

First, find the user's ID by their email:

```sql
SELECT id, email, created_at 
FROM users 
WHERE email = 'user@example.com';
```

**Example result:**
```
id  | email              | created_at
----+--------------------+-------------------------
5   | user@example.com   | 2026-02-05 10:30:00
```

**Note the `id` value** (e.g., `5`) - you'll need it in the next step.

---

## Step 3: Grant Access

Use the user's ID from Step 2:

```sql
INSERT INTO subscriptions (
  user_id, 
  stripe_subscription_id, 
  status, 
  current_period_end
)
VALUES (
  5,                                          -- Replace with actual user_id
  'manual_grant_' || extract(epoch from now()),  -- Unique ID
  'active',                                   -- Status = active grants access
  '2099-12-31 23:59:59'                      -- Lifetime access (far future date)
);
```

**Done!** User now has lifetime access to the translation service.

---

## Step 4: Verify Access

Check the subscription was created:

```sql
SELECT 
  s.id,
  s.user_id,
  u.email,
  s.stripe_subscription_id,
  s.status,
  s.current_period_end
FROM subscriptions s
JOIN users u ON u.id = s.user_id
WHERE u.email = 'user@example.com';
```

**Expected result:**
```
id | user_id | email            | stripe_subscription_id    | status | current_period_end
---+---------+------------------+---------------------------+--------+--------------------
12 | 5       | user@example.com | manual_grant_1738730400   | active | 2099-12-31 23:59:59
```

---

## Revoke Access

Change subscription status to `'canceled'`:

```sql
UPDATE subscriptions 
SET 
  status = 'canceled',
  updated_at = CURRENT_TIMESTAMP
WHERE user_id = (
  SELECT id FROM users WHERE email = 'user@example.com'
);
```

---

## View All Users & Access Status

```sql
SELECT 
  u.id AS user_id,
  u.email,
  u.created_at AS signup_date,
  COALESCE(s.status, 'no subscription') AS subscription_status,
  s.current_period_end AS expires,
  CASE 
    WHEN s.status IN ('active', 'trialing') 
      AND (s.current_period_end IS NULL OR s.current_period_end > now())
    THEN '✓ HAS ACCESS'
    ELSE '✗ NO ACCESS'
  END AS access
FROM users u
LEFT JOIN subscriptions s ON s.user_id = u.id
ORDER BY u.created_at DESC;
```

---

## Quick Copy-Paste Templates

### Grant Access (Single Query)

Replace `'USER_EMAIL_HERE'` with actual email:

```sql
-- Grant lifetime access in one query
INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_end)
SELECT 
  id, 
  'manual_grant_' || extract(epoch from now()), 
  'active', 
  '2099-12-31 23:59:59'
FROM users 
WHERE email = 'USER_EMAIL_HERE';
```

### Revoke Access (Single Query)

```sql
-- Revoke access in one query
UPDATE subscriptions 
SET status = 'canceled', updated_at = CURRENT_TIMESTAMP
WHERE user_id = (SELECT id FROM users WHERE email = 'USER_EMAIL_HERE');
```

---

## Important Notes

### Status Values That Grant Access:
- ✓ `'active'` - Active subscription (access granted)
- ✓ `'trialing'` - Trial period (access granted)

### Status Values That Deny Access:
- ✗ `'canceled'` - Subscription canceled
- ✗ `'past_due'` - Payment failed
- ✗ `'unpaid'` - Payment required
- ✗ Any other value

### Required Fields:
- **user_id** - Must exist in `users` table
- **stripe_subscription_id** - Must be unique (use `manual_grant_` + timestamp)
- **status** - Must be `'active'` or `'trialing'` for access
- **current_period_end** - Set to far future (2099-12-31) for lifetime access

---

## Troubleshooting

### "User must sign up first"
The user needs to create an account through the extension first. They don't need to pay - just sign up with email/password.

### "Unique constraint violation on stripe_subscription_id"
User already has a subscription. Either:
1. Update the existing subscription instead of inserting new
2. Delete old subscription first (not recommended)

**Update existing subscription:**
```sql
UPDATE subscriptions 
SET 
  status = 'active',
  current_period_end = '2099-12-31 23:59:59',
  updated_at = CURRENT_TIMESTAMP
WHERE user_id = (SELECT id FROM users WHERE email = 'USER_EMAIL_HERE');
```
