# Access Management Guide

## Manual Access Control

You can manually grant or revoke user access without going through Stripe payment.

### Prerequisites

User must sign up first through the normal signup flow. This creates their account in the `users` table.

---

## Grant Access to a User

**Command:**
```bash
node grant-access.js user@example.com
```

**What it does:**
- Finds user by email
- Creates a subscription entry with status `'active'`
- Sets expiration to 2099-12-31 (lifetime access)
- Uses a unique ID like `manual_grant_1738728192000`

**Output:**
```
✓ Found user: user@example.com (ID: 1)

✓ Access granted successfully!
   Subscription ID: manual_grant_1738728192000
   Status: active
   Expires: 2099-12-31 23:59:59 (lifetime)
```

---

## Revoke Access from a User

**Command:**
```bash
node revoke-access.js user@example.com
```

**What it does:**
- Finds user's latest subscription
- Changes status to `'canceled'`
- User will no longer have access to `/translate`

---

## Direct Database Access (Supabase)

### View All Users & Their Access Status

```sql
SELECT 
  u.id,
  u.email,
  u.created_at,
  s.status AS subscription_status,
  s.current_period_end
FROM users u
LEFT JOIN subscriptions s ON s.user_id = u.id
ORDER BY u.created_at DESC;
```

### Manually Grant Access via SQL

```sql
-- Find user ID
SELECT id, email FROM users WHERE email = 'user@example.com';

-- Grant access (replace 123 with actual user_id)
INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_end)
VALUES (123, 'manual_grant_' || extract(epoch from now()), 'active', '2099-12-31 23:59:59');
```

### Manually Revoke Access via SQL

```sql
-- Find subscription
SELECT id, user_id, status FROM subscriptions WHERE user_id = 123;

-- Revoke access (replace 456 with actual subscription id)
UPDATE subscriptions 
SET status = 'canceled', updated_at = CURRENT_TIMESTAMP 
WHERE id = 456;
```

---

## Subscription Status Values

The `status` field determines if a user has access:

**Access Granted:**
- `'active'` - Active subscription (grants access) ✓
- `'trialing'` - Trial period (grants access) ✓

**Access Denied:**
- `'canceled'` - Subscription canceled ✗
- `'past_due'` - Payment failed ✗
- `'unpaid'` - Payment required ✗
- `'incomplete'` - Setup incomplete ✗

---

## Subscriptions Table Structure

```sql
CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
  status VARCHAR(50) NOT NULL,
  current_period_end TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Key Points:**
- `user_id` - Links to users table
- `stripe_subscription_id` - Must be unique (use `manual_grant_[timestamp]` for manual grants)
- `status` - Must be `'active'` or `'trialing'` for access
- `current_period_end` - Checked if present; set to far future for lifetime access

---

## Troubleshooting

### "User not found"
User must sign up first. Have them go through the normal signup flow in the extension.

### "User already has subscription"
Run the revoke script first, or update the existing subscription status manually.

### Database Connection Issues
Ensure `.env` file has correct `DATABASE_URL` pointing to your Supabase PostgreSQL database.
