# Free Trial Feature — Implementation Plan

## Agent Instructions

Ask the user questions when anything is unclear or needs their input. This includes:

- Ambiguous or incomplete requirements
- Technical decisions that affect architecture or user experience
- Trade-offs that require business context

Do not make assumptions on important decisions — get clarification first.

---

## Workflow Steps

### [x] Step: Technical Specification

Spec saved to `spec.md`. Complexity: **Hard**.

---

### [x] Phase 1: DB Schema + New DB Functions

**Files**: `db.js`

- [x] Add migration blocks in `initDatabase()` for 6 new `users` columns:
  - `plan_status`, `trial_chars_used`, `trial_chars_limit`, `trial_started_at`, `trial_converted_at`, `subscription_id`
- [x] Update `getUserById()` and `getUserByEmail()` to SELECT new columns
- [x] Add `updateUserTrialStart(userId, subscriptionId)` function
- [x] Add `incrementUserTrialChars(userId, chars)` function (atomic, returns updated row)
- [x] Add `updateUserPlanStatus(userId, planStatus, hasAccess, convertedAt)` function
- [x] Add `cancelUserSubscription(userId)` function

---

### [x] Phase 2: `/start-trial` Endpoint

**Files**: `index.js`

- [x] Import new DB functions
- [x] Implement `POST /start-trial` endpoint:
  - Accept `email`, `password`, `payment_method_id` (new user) or Bearer token + `payment_method_id` (existing user)
  - Create Stripe customer if needed
  - Attach payment method and set as default
  - Create Stripe subscription with `trial_end = now + 365 days` (usage-only gating)
  - Insert subscription record into DB
  - Call `updateUserTrialStart()` on user
  - Return JWT + trial info

---

### [x] Phase 3: Update `GET /me`

**Files**: `index.js`

- [x] Update `/me` to return: `plan_status`, `trial_chars_used`, `trial_chars_limit`, `trial_started_at`, `has_access`

---

### [x] Phase 4: Update `POST /translate` for Trial Enforcement

**Files**: `index.js`

- [x] After existing access check, fetch full user row (for `plan_status`, `trial_chars_used`, `trial_chars_limit`)
- [x] If `plan_status == 'trialing'`:
  - Compute total chars of request
  - If `trial_chars_used >= trial_chars_limit` → return `{ error: 'trial_exhausted', message: '...' }` (HTTP 402)
  - After successful translation → call `incrementUserTrialChars(userId, chars)`
  - If new `trial_chars_used >= trial_chars_limit` → end Stripe trial early via `stripe.subscriptions.update(subscriptionId, { trial_end: 'now' })`
  - Return `trial_chars_used` and `trial_chars_limit` in response for trialing users

---

### [x] Phase 5: Update Stripe Webhook + Add `/cancel-subscription`

**Files**: `index.js`

- [x] Update `customer.subscription.updated` webhook handler:
  - If `status == 'active'`: call `updateUserPlanStatus(userId, 'active', true, now())`
  - If `status` in `['canceled', 'unpaid', 'past_due']`: call `updateUserPlanStatus(userId, status, false, null)`
- [x] Update `customer.subscription.deleted` webhook handler similarly
- [x] Add `POST /cancel-subscription` endpoint:
  - Requires auth
  - Fetch user's `subscription_id` from DB (falls back to subscriptions table)
  - Call `stripe.subscriptions.cancel(subscriptionId)`
  - Call `cancelUserSubscription(userId)`
  - Return success

---

### [ ] Phase 6: Commit and Push

- [ ] `git add -A && git commit -m "feat: add 10k-character card-upfront free trial"`
- [ ] `git push` to https://github.com/fusion20k/haribackend
