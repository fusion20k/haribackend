# Simple Access Management - Single Field

The **easiest way** to grant or revoke access: just change one checkbox in Supabase.

---

## Grant Access (3 clicks)

1. Open **Supabase Dashboard** → **Table Editor** → `users` table
2. Find the user's row (by email)
3. Click the **has_access** checkbox to check it ✓
4. That's it! User has access.

---

## Revoke Access (3 clicks)

1. Open **Supabase Dashboard** → **Table Editor** → `users` table
2. Find the user's row (by email)
3. Click the **has_access** checkbox to uncheck it ☐
4. That's it! User no longer has access.

---

## Visual Guide

### Users Table - Grant Access
```
┌─────┬──────────────────────┬───────────────┬────────────────────┬──────────────┐
│ id  │ email                │ password_hash │ stripe_customer_id │ has_access   │
├─────┼──────────────────────┼───────────────┼────────────────────┼──────────────┤
│ 1   │ user@example.com     │ $2b$10$...   │ cus_ABC123         │ ☐ → Click!  │
│ 2   │ admin@example.com    │ $2b$10$...   │ cus_XYZ789         │ ✓ Has Access │
└─────┴──────────────────────┴───────────────┴────────────────────┴──────────────┘
```

Just click the checkbox in the **has_access** column!

---

## How It Works

### Access Priority:
1. **has_access = true** → User has access (overrides everything) ✓
2. **has_access = false** → Check subscriptions table (Stripe payment status)

### Use Cases:
- **Manual grant**: Set `has_access = true` for free access
- **Stripe payment**: Leave `has_access = false`, let Stripe manage via subscriptions
- **Revoke manually**: Set `has_access = false`, even if they have paid subscription

---

## No Need for Subscriptions Table

**Simple scenario:** Just use `has_access` field
- Check box = access granted
- Uncheck box = access denied

**Payment scenario:** Leave `has_access = false` and use Stripe subscriptions
- System automatically checks subscriptions table for paid users

---

## Notes

- **Default**: New users have `has_access = false` by default
- **Priority**: `has_access = true` overrides subscription status
- **Instant**: Changes take effect immediately
- **Simple**: No need to manage subscription entries for manual grants

---

## Comparison

| Method | Steps | Difficulty |
|--------|-------|------------|
| **has_access field** | 3 clicks | ⭐ Easiest |
| Subscriptions table | Insert row with 4 fields | ⭐⭐ Medium |
| SQL command | Write & run SQL | ⭐⭐⭐ Complex |

**Recommendation:** Use `has_access` field for manual grants. Let Stripe manage subscriptions table automatically.
