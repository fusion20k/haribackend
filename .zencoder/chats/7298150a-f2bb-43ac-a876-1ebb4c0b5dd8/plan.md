# Backend Auth System - Bug Fixes & Manual Access Grant

## Issues to Fix

1. **Backend `/me` endpoint returning 404** - Endpoint exists but may not be deployed
2. **Signup flow not working** - Depends on /me endpoint
3. **Manual access grant needed** - Ability to grant service access without Stripe purchase

## Workflow Steps

### [x] Phase 1: Verify Current Deployment State
- [x] Check if latest code is deployed to Render
- [ ] Verify /me endpoint is accessible (needs user testing)
- [ ] Test signup flow (needs user testing)

### [x] Phase 2: Add Manual Access Grant
- [x] Add script to manually create subscription entries in Supabase
- [x] Document subscription table structure
- [x] Create admin utility to grant/revoke access
- [x] Create Supabase SQL Editor guide for direct database access
- [x] Add `has_access` boolean field to users table for simple toggle access
- [x] Set all database timestamps to EST timezone (America/New_York)
- [x] Create migration script to convert existing timestamps from UTC to EST
- [x] Provide SQL migration commands for Supabase SQL Editor

### [ ] Phase 3: Test & Verify
- Test signup flow end-to-end
- Test manual access grant
- Verify subscription status checking works

---

## Access Control Methods

### Method 1: Simple Checkbox (Recommended for Manual Grants)
**Users table** - `has_access` field:
- ✓ Check the box → Access granted
- ☐ Uncheck the box → Access denied
- **Priority**: This field overrides subscription status
- **Use case**: Manual access grants, free trials, testing

### Method 2: Subscriptions Table (Automatic via Stripe)
**Subscriptions table** structure:
```sql
CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
  status VARCHAR(50) NOT NULL,  -- 'active', 'trialing', 'canceled', 'past_due', etc.
  current_period_end TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```
- **Automatic**: Managed by Stripe webhooks
- **Use case**: Paid subscriptions, recurring billing

---

## Implementation Tasks

### Task 1: Verify Deployment ✓
- [x] Check if code is pushed to GitHub
- [ ] Verify Render has deployed latest commit
- [ ] Test endpoints with curl/Postman

### Task 2: Create Manual Grant Script
- [ ] Create `grant-access.js` utility script
- [ ] Takes email as input
- [ ] Creates manual subscription entry
- [ ] Add to repository

### Task 3: Documentation
- [ ] Document how to use grant-access script
- [ ] Add example SQL queries for manual DB operations
- [ ] Update README with access management instructions

---

## Next Steps

Waiting for user confirmation to proceed with Phase 1 verification.
