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

### [ ] Phase 3: Test & Verify
- Test signup flow end-to-end
- Test manual access grant
- Verify subscription status checking works

---

## Subscriptions Table Structure

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

**For Manual Access:**
- Set `stripe_subscription_id` to something like `manual_grant_[timestamp]` to make it unique
- Set `status` to `'active'`
- Set `current_period_end` to far future date (e.g., 2099-12-31)

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
