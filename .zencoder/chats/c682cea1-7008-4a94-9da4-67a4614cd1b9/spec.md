# Technical Specification: Free Trial Feature

## Complexity: Hard

## Technical Context

- **Language**: Node.js / JavaScript
- **Framework**: Express.js
- **Database**: PostgreSQL (via `pg` pool)
- **Billing**: Stripe (subscriptions, webhooks)
- **Auth**: JWT (jsonwebtoken + bcrypt)
- **Translation**: Lara AI (`@translated/lara`)

---

## Implementation Approach

### Stripe Trial Strategy

Create a Stripe subscription with `trial_end` set to 30 days from now. This means:
- User has 30 days OR 10,000 characters (whichever comes first).
- When usage hits 10k, call `stripe.subscriptions.update(subId, { trial_end: 'now' })` to immediately end the trial and start billing.
- Stripe fires `customer.subscription.updated` → webhook updates `plan_status = 'active'` and `has_access = TRUE`.
- If payment fails, Stripe fires status `past_due` / `unpaid` → webhook sets `has_access = FALSE`.

### `/start-trial` Flow

Accepts either:
- **New user**: `{ email, password, payment_method_id }` (no auth header)
- **Existing user**: Bearer token + `{ payment_method_id }` (logged-in user starting trial)

Steps:
1. Create user (if new) with hashed password.
2. Create Stripe customer (if not already exists).
3. Attach `payment_method_id` to Stripe customer and set as default.
4. Create Stripe subscription with `trial_end = now + 30 days`, price from `STRIPE_PRICE_ID`.
5. Insert subscription record into `subscriptions` table.
6. Update user: `plan_status = 'trialing'`, `trial_chars_used = 0`, `trial_chars_limit = 10000`, `trial_started_at = now()`, `has_access = TRUE`.
7. Return JWT + user + trial info.

---

## Data Model Changes

### `users` table — new columns

```sql
ALTER TABLE users
  ADD COLUMN plan_status TEXT,
  ADD COLUMN trial_chars_used INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN trial_chars_limit INTEGER NOT NULL DEFAULT 10000,
  ADD COLUMN trial_started_at TIMESTAMPTZ,
  ADD COLUMN trial_converted_at TIMESTAMPTZ,
  ADD COLUMN subscription_id VARCHAR(255);
```

Applied via idempotent `DO $$ ... END $$` blocks in `initDatabase()`.

---

## Source Code Changes

### `db.js`

- `initDatabase()`: add migration blocks for 6 new columns on `users`.
- `getUserById()` / `getUserByEmail()`: update SELECT to include new columns.
- `updateUserTrialStart(userId, subscriptionId)`: sets trial columns + `has_access = TRUE`.
- `incrementUserTrialChars(userId, chars)`: atomically increments `trial_chars_used`, returns updated row.
- `updateUserPlanStatus(userId, planStatus, hasAccess, convertedAt)`: generic status updater for webhook use.
- `cancelUserSubscription(userId)`: sets `plan_status = 'canceled'`, `has_access = FALSE`.

### `index.js`

- **`POST /start-trial`**: new endpoint (described above).
- **`GET /me`**: return `plan_status`, `trial_chars_used`, `trial_chars_limit`, `has_access`.
- **`POST /translate`**: after access check, if `plan_status == 'trialing'`:
  - Compute total chars of incoming request.
  - If `trial_chars_used + chars > trial_chars_limit` → return `{ error: 'trial_exhausted' }`.
  - After successful translation, call `incrementUserTrialChars()`.
  - If new total >= limit, end Stripe trial early (`trial_end: 'now'`).
- **`POST /stripe/webhook`** `customer.subscription.updated`:
  - If `status == 'active'` (trial ended, payment succeeded): `plan_status = 'active'`, `has_access = TRUE`, `trial_converted_at = now()`.
  - If `status` in `['canceled', 'unpaid', 'past_due']`: `plan_status = 'canceled'`, `has_access = FALSE`.
- **`POST /cancel-subscription`**: new endpoint, requires auth, cancels Stripe subscription, updates DB.

---

## API Changes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/start-trial` | Optional JWT | Create account + start trial with card |
| GET | `/me` | JWT | Returns extended trial status |
| POST | `/cancel-subscription` | JWT | Cancel active subscription |

### `/me` response (updated)

```json
{
  "id": 1,
  "email": "user@example.com",
  "plan_status": "trialing",
  "trial_chars_used": 2350,
  "trial_chars_limit": 10000,
  "trial_started_at": "2026-03-01T00:00:00Z",
  "has_access": true
}
```

### `/translate` error for trial exhaustion

```json
{
  "error": "trial_exhausted",
  "message": "You have used your 10,000 free trial characters."
}
```

---

## Verification

- Manual test `/start-trial` with Stripe test card `pm_card_visa`.
- Confirm new user row has trial columns populated.
- Manually set `trial_chars_used` close to limit, confirm `/translate` blocks at 10k.
- Confirm webhook fires and updates `plan_status` to `active`.
- Test `/cancel-subscription` and confirm `has_access = FALSE`.
