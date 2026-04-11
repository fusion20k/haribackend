# Technical Specification: Introduce `"pre"` Plan Status

## Complexity Assessment
**Medium** — Multiple isolated changes across two files. Logic is clear but spread across webhook handlers, endpoint guards, char-tracking logic, and DB functions.

---

## Technical Context

- **Language**: Node.js (CommonJS)
- **Dependencies**: `pg` (PostgreSQL), `stripe`, `jsonwebtoken`, `bcrypt`, `express`
- **Files changed**: `index.js`, `db.js`

---

## Plan Status Semantics (Final)

| Status | Who | `has_access` | Char tracking | Char limit | Rolling reset |
|--------|-----|:---:|:---:|:---:|:---:|
| `free` | New users, Stripe-trialing users (not yet charged), and canceled subscribers | TRUE | YES | 25,000 | 30-day rolling |
| `pre` | Paid Stripe subscribers (Stripe `status === "active"` only) | TRUE | YES | 1,000,000 | 30-day rolling |
| `active` | Internal / admin only | TRUE | NO | ∞ | NO |
| `canceled` | **No longer set going forward** — cancellation falls back to `free` | — | — | — | — |
| `trialing` | **No longer set going forward** — Stripe trialing = user stays on `free` | — | — | — | — |

### Key Rules
- Stripe `status === "trialing"`: user stays/goes to `"free"` (25K chars, subscription_id is stored for future cancellation)
- Stripe `status === "active"`: user is set to `"pre"` (1M chars, rolling 30-day reset)
- Stripe `status === "canceled"` / `"unpaid"` / `"past_due"`: user falls back to `"free"` (25K chars, reset to 0, new 30-day window)
- `"active"` users (admin): no char tracking whatsoever — no limit checks, no resets

---

## Implementation Approach

### `db.js` Changes

#### 1. `updateUserTrialStart` — Stripe trialing → stay on `free`
This function is called when Stripe fires a `trialing` event. Since trialing users have not paid, they stay on `free`. Change:
- `plan_status = 'trialing'` → `plan_status = 'free'`
- Remove `trial_chars_limit = 25000` (already their limit; don't touch)
- Remove `trial_chars_used` reset (preserve current usage)
- Remove `trial_started_at` update (no longer tracking trial start for business logic)
- Keep `subscription_id = $1` (store it so we can cancel via Stripe if they exhaust free chars)
- Keep `has_access = TRUE`
- Do NOT modify `free_chars_reset_date` (preserve their current reset window)

New SQL:
```sql
UPDATE users
SET plan_status = 'free',
    subscription_id = $1,
    has_access = TRUE
WHERE id = $2
RETURNING id, email, plan_status, trial_chars_used, trial_chars_limit, trial_started_at, has_access
```

#### 2. `updateUserPlanStatus` — add `'pre'` branch, simplify `'active'` branch
- Add `if (planStatus === 'pre')` branch: sets `trial_chars_limit = 1000000`, resets `trial_chars_used = 0` and `free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE` only when transitioning from a non-`pre` status (`CASE WHEN plan_status != 'pre' THEN ... END`).
- Remove the special `if (planStatus === 'active')` branch entirely — `active` falls through to the generic branch (no char tracking fields are modified for admin users).

New `'pre'` branch SQL:
```sql
UPDATE users
SET plan_status = $1,
    has_access = $2,
    trial_converted_at = $3,
    subscription_id = COALESCE($5, subscription_id),
    trial_chars_limit = 1000000,
    trial_chars_used = CASE WHEN plan_status != 'pre' THEN 0 ELSE trial_chars_used END,
    free_chars_reset_date = CASE WHEN plan_status != 'pre' THEN (NOW() + INTERVAL '30 days')::DATE ELSE free_chars_reset_date END
WHERE id = $4
RETURNING id, email, plan_status, has_access, trial_converted_at, subscription_id
```

#### 3. `cancelUserSubscription` — fall back to `free` instead of `canceled`
Replace the current `plan_status = 'canceled', has_access = FALSE` with a full reset to `free`:
```sql
UPDATE users
SET plan_status = 'free',
    has_access = TRUE,
    trial_chars_limit = 25000,
    trial_chars_used = 0,
    free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE,
    subscription_id = NULL
WHERE id = $1
RETURNING id, email, plan_status, has_access
```

#### 4. `initDatabase` — two new migrations
Add after existing migrations:

**Migration A** — convert orphaned `canceled` users to `free`:
```sql
UPDATE users
SET plan_status = 'free',
    has_access = TRUE,
    trial_chars_limit = 25000,
    trial_chars_used = 0,
    free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE,
    subscription_id = NULL
WHERE plan_status = 'canceled'
```

**Migration B** — existing migration converting `trialing → free` already present; keep as-is.

---

### `index.js` Changes

#### 5. Webhook: `checkout.session.completed`
- `subscription.status === "trialing"` branch: no code change — `updateUserTrialStart` is still called, and now correctly sets `free`
- `subscription.status === "active"` branch: change `updateUserPlanStatus(userId, "active", true, new Date(), subscription.id)` → `updateUserPlanStatus(userId, "pre", true, new Date(), subscription.id)`

#### 6. Webhook: `customer.subscription.created`
- `subscription.status === "trialing"` branch: no code change
- `subscription.status === "active"` branch: change `"active"` → `"pre"` in `updateUserPlanStatus` call

#### 7. Webhook: `customer.subscription.updated`
- `subscription.status === "trialing"` branch: no code change
- `subscription.status === "active"` branch: change `"active"` → `"pre"` in `updateUserPlanStatus` call
- `["canceled", "unpaid", "past_due"]` branch: replace `updateUserPlanStatus(subRow.user_id, subscription.status, false, null)` with `cancelUserSubscription(subRow.user_id)` (and import `cancelUserSubscription` — it is already imported)

#### 8. Webhook: `customer.subscription.deleted`
- Replace `updateUserPlanStatus(subRow.user_id, "canceled", false, null)` with `cancelUserSubscription(subRow.user_id)`

#### 9. `/billing/verify-session`
- `subscription.status === "trialing"` branch: no code change
- `subscription.status === "active"` branch: change `updateUserPlanStatus(req.userId, "active", true, new Date(), subscription.id)` → `updateUserPlanStatus(req.userId, "pre", true, new Date(), subscription.id)`

#### 10. `/start-trial` endpoint — guard update
Old guard: `user.plan_status === "trialing" || user.plan_status === "active" || user.plan_status === "canceled"`
New guard: `["pre", "active"].includes(user.plan_status) || !!user.subscription_id`

Rationale: `free` users with no `subscription_id` can start a trial. `free` users who already have a `subscription_id` are already in a Stripe trial. `pre` and `active` users already have a subscription.

#### 11. `/billing/create-checkout-session` — guard update
Old: `if (user.plan_status === "active")`
New: `if (["active", "pre"].includes(user.plan_status))`

#### 12. `/billing/create-trial-checkout-session` — guard update
Old guard: `user.plan_status === "trialing" || user.plan_status === "active" || user.plan_status === "canceled"`
New guard: `["pre", "active"].includes(user.plan_status) || !!user.subscription_id`

#### 13. `/me` endpoint — char reset logic
Old: `if (user.plan_status === "free" || user.plan_status === "active")`
New: `if (["free", "pre"].includes(user.plan_status))`

(`active` admin users are unlimited — no reset needed)

#### 14. `/translate` endpoint — four changes
1. **Plan status allow-list** (line ~764):
   `!["free", "trialing", "active"].includes(user.plan_status)` → `!["free", "active", "pre"].includes(user.plan_status)`

2. **Char reset check** (line ~821):
   `if (user.plan_status === "free" || user.plan_status === "active")` → `if (["free", "pre"].includes(user.plan_status))`

3. **Char tracking block** (line ~820):
   `if (user && ["free", "trialing", "active"].includes(user.plan_status))` → `if (user && ["free", "pre"].includes(user.plan_status))`

4. **Inside char tracking block**:
   - `monthly_limit_reached` message: `if (user.plan_status === "active")` → `if (user.plan_status === "pre")`
   - Early Stripe trial-end: `if (user.plan_status === "trialing" && stripe && updatedUser.subscription_id)` → `if (user.plan_status === "free" && stripe && updatedUser.subscription_id)`
     (A `free` user with a `subscription_id` is in a Stripe trial — ending it early causes Stripe to charge or cancel them)

#### 15. `/cancel-subscription` endpoint
No change needed — already calls `cancelUserSubscription(req.userId)`, which now resets to `free`.

---

## API / Interface Changes

No endpoint signature or response shape changes. Client-visible `plan_status` values change as follows:

| Previously | Now |
|---|---|
| `"trialing"` (from Stripe trialing webhook) | `"free"` |
| `"active"` (from Stripe active webhook) | `"pre"` |
| `"canceled"` (after cancellation) | `"free"` |
| `"active"` (admin users) | `"active"` (unchanged) |

---

## Verification Approach

No automated test framework present. Verify manually:

1. **Server startup** — `node index.js`: confirm DB init runs without errors, both new migrations log success.
2. **Stripe trialing webhook** (`customer.subscription.created` / `updated` with `status: "trialing"`) → confirm user stays `plan_status = 'free'`, `subscription_id` is set, chars unchanged.
3. **Stripe active webhook** (`customer.subscription.updated` with `status: "active"`) → confirm user becomes `plan_status = 'pre'`, `trial_chars_limit = 1000000`, `trial_chars_used = 0`, `free_chars_reset_date` set 30 days out.
4. **Stripe canceled webhook** (`customer.subscription.deleted`) → confirm user returns to `plan_status = 'free'`, `has_access = TRUE`, `trial_chars_limit = 25000`, `trial_chars_used = 0`.
5. **`/translate` as `pre` user** → chars increment, blocked at 1M with `monthly_limit_reached` error.
6. **`/translate` as `active` (admin) user** → chars are NOT incremented, no limit check.
7. **`/translate` as `free` user with `subscription_id`** → chars increment; when limit hit, Stripe trial is ended early via `subscriptions.update({ trial_end: "now" })`.
8. **`/me` as `pre` user past `free_chars_reset_date`** → `trial_chars_used` resets to 0.
9. **`/me` as `active` (admin) user** → no char reset triggered.
10. **Canceled-users migration** — seed a row with `plan_status = 'canceled'` before startup, confirm it becomes `free` after `initDatabase` runs.
