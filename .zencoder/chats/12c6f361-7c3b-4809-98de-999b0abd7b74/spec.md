# Technical Specification: Resequence `users.id` to Sequential Values

## Difficulty: Medium

---

## Technical Context

- **Database**: PostgreSQL (Supabase)
- **Target table**: `users` (columns include `id` INT4 PRIMARY KEY, `email`, and many others)
- **Problem**: The `id` column has gaps (e.g., 7, 16, 18, 22, 23, 24, 26–34) due to deleted rows
- **Goal**: Reassign `id` values to be sequential (1, 2, 3, ...) ordered by current `id`, then reset the sequence

## Tables with FK References to `users(id)`

All three use `ON DELETE CASCADE`:

| Child Table             | FK Column  |
|-------------------------|------------|
| `subscriptions`         | `user_id`  |
| `translation_usage`     | `user_id`  |
| `pending_meter_events`  | `user_id`  |

---

## External Systems Investigation

### 1. JWT Tokens — ⚠️ HIGH RISK

**Finding:** All three authentication endpoints sign JWTs that embed `users.id` directly:

```js
// /auth/signup, /auth/login, /start-trial, /admin/login
jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" })
```

The `requireAuth` middleware then extracts `req.userId = payload.userId` and passes it into every DB query (`getUserById`, `incrementUserTrialChars`, `atomicCheckAndIncrementChars`, etc.).

**Risk:** Any user currently logged in has a JWT containing the **old** `userId`. After resequencing:

- Old IDs like `34` no longer exist → `getUserById(34)` returns `null` → user gets 401/500 errors (effectively logged out — benign)
- Old IDs like `7` still exist but now map to a **different user** (the 7th-lowest-id user, who was previously e.g. id=22) → **this is a security issue**: the bearer of the old JWT would read/write the wrong user's account

**Mitigation (required):** Rotate `JWT_SECRET` immediately after running the SQL script. Since tokens are stateless, changing the secret instantly invalidates all outstanding tokens. Users re-login and get new tokens with correct new IDs. This is the only reliable mitigation without a token blacklist.

---

### 2. Stripe Subscription Metadata — ✅ SAFE FOR RENEWALS, ⚠️ MINOR RISK AT CHECKOUT TIME

**Finding:** Every checkout/subscription creation call embeds `users.id` into Stripe metadata:

```js
// /billing/create-checkout-session, /billing/create-trial-checkout-session,
// /billing/create-payg-checkout-session, /billing/switch-plan, /start-trial
metadata: { userId: user.id.toString() }
subscription_data: { metadata: { userId: user.id.toString() } }
```

**Webhook behavior — critical distinction:**

| Webhook event | How it resolves userId | Safe after resequence? |
|---|---|---|
| `checkout.session.completed` | Reads `session.metadata.userId` from Stripe | ⚠️ Only if no checkout was in-flight |
| `customer.subscription.created` | Reads `subscription.metadata.userId` from Stripe | ⚠️ Only fires once at creation |
| `customer.subscription.updated` | `getSubscriptionByStripeId()` → local `subscriptions.user_id` | ✅ Safe — uses local DB |
| `customer.subscription.deleted` | `getSubscriptionByStripeId()` → local `subscriptions.user_id` | ✅ Safe — uses local DB |

**Key insight:** Billing renewal webhooks (`subscription.updated`, `subscription.deleted`) do **not** use Stripe metadata — they look up the user via the local `subscriptions` table, which we update as part of the resequence. **Ongoing billing is safe.**

The only Stripe risk is an in-flight checkout session that was opened before the resequence runs and completes after — the `checkout.session.completed` webhook would read a stale `userId` from Stripe's metadata. This is a narrow time-window race condition.

**Mitigation:** Run the SQL script during a low-traffic window. Any in-flight checkouts would need to be re-attempted by the user (they would simply not be credited for the purchase until re-login and retry, which customer support could handle).

---

### 3. No Other External Systems Found

- **No external API calls** embed `users.id` (Azure Translator, Azure OpenAI calls use user context internally but don't send IDs externally)
- **No caches** persist `users.id` (the `paymentsCache` in `index.js` is in-memory and keyed by Stripe session ID, not user ID)
- **No emails** or notifications embed `users.id`
- **No client-side persisted identifiers** other than the JWT token itself

---

## Recommendation

**It is safe to proceed with the following two-step process:**

1. **Run the SQL resequence script** (see below)
2. **Immediately rotate `JWT_SECRET`** in the environment variables and restart the server

Step 2 is mandatory. Without it, existing logged-in users could access wrong accounts. With it, the worst-case outcome is that active users need to log in again.

**Suggested maintenance window:** Choose a time of day with low user activity. Warn users if possible (e.g., extension update message). Total downtime is seconds — just a server restart.

---

## Implementation Approach

Use Supabase's `SET session_replication_role = 'replica'` to bypass FK trigger enforcement during the update, avoiding the need to drop and recreate constraints (which would require knowing exact constraint names).

### Steps

1. **Begin a transaction** — all changes are atomic; rollback on any error
2. **Bypass FK checks** — `SET session_replication_role = 'replica'`
3. **Create a temporary mapping table** — maps each `old_id → new_id` using `ROW_NUMBER() OVER (ORDER BY id)`
4. **Update child tables** — set `user_id = new_id` in `subscriptions`, `translation_usage`, `pending_meter_events` using a JOIN on the mapping
5. **Update `users.id`** — via a temporary staging column to avoid PK self-collision:
   - `ALTER TABLE users ADD COLUMN _new_id INTEGER`
   - `UPDATE users SET _new_id = new_id FROM mapping`
   - `ALTER TABLE users DROP CONSTRAINT users_pkey`
   - `UPDATE users SET id = _new_id`
   - `ALTER TABLE users DROP COLUMN _new_id`
   - `ALTER TABLE users ADD PRIMARY KEY (id)`
6. **Restore FK enforcement** — `SET session_replication_role = 'default'`
7. **Reset the sequence** — `SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))`
8. **Commit**
9. **Rotate `JWT_SECRET`** env var → restart server (outside the SQL script, done by operator)

---

## Source Code Structure

**Single new file to create:**

```
resequence-user-ids.sql
```

No application code (`db.js`, `index.js`) needs modification — this is a one-time database maintenance script run directly in the Supabase SQL Editor. The JWT secret rotation is an environment variable change, not a code change.

---

## SQL Script (Implementation Target)

```sql
BEGIN;

-- Bypass FK constraint triggers (Supabase/Postgres superuser feature)
SET session_replication_role = 'replica';

-- Build old → new ID mapping
CREATE TEMP TABLE _id_remap AS
SELECT
  id                                        AS old_id,
  ROW_NUMBER() OVER (ORDER BY id)::INTEGER  AS new_id
FROM users;

-- Update child tables
UPDATE subscriptions        SET user_id = r.new_id FROM _id_remap r WHERE user_id = r.old_id;
UPDATE translation_usage    SET user_id = r.new_id FROM _id_remap r WHERE user_id = r.old_id;
UPDATE pending_meter_events SET user_id = r.new_id FROM _id_remap r WHERE user_id = r.old_id;

-- Stage new IDs on users to avoid PK self-collision
ALTER TABLE users ADD COLUMN _new_id INTEGER;
UPDATE users SET _new_id = r.new_id FROM _id_remap r WHERE id = r.old_id;

-- Swap the PK
ALTER TABLE users DROP CONSTRAINT users_pkey;
UPDATE users SET id = _new_id;
ALTER TABLE users DROP COLUMN _new_id;
ALTER TABLE users ADD PRIMARY KEY (id);

-- Restore FK enforcement
SET session_replication_role = 'default';

-- Reset sequence so next INSERT gets MAX(id)+1
SELECT setval('users_id_seq', (SELECT MAX(id) FROM users));

COMMIT;
```

**After running the script (manual step):**
```
# In your deployment environment (Render / Railway / etc.):
# 1. Update JWT_SECRET to a new random value
# 2. Redeploy / restart the server
```

---

## Data Model / API Changes

- **No application code changes** — `users.id` is still an integer PK; existing queries are unaffected
- **`users_id_seq`** is reset so new rows auto-increment from the correct next value
- **No data loss** — all rows preserved; only the `id` values change
- **All active sessions invalidated** (intentional — users must re-login after JWT_SECRET rotation)

---

## Assumptions & Risks

| Item | Risk | Mitigation |
|---|---|---|
| Active JWT tokens | HIGH — wrong-user access possible | Rotate `JWT_SECRET` immediately after script |
| In-flight Stripe checkouts | LOW — only during the maintenance window | Run during low-traffic hours |
| Billing renewal webhooks | NONE — resolved via local `subscriptions` table | No action needed |
| `session_replication_role` availability | Low — standard Supabase superuser feature | Verify in Supabase SQL editor |
| Sequence name `users_id_seq` | Low — standard SERIAL convention | Verify: `SELECT * FROM information_schema.sequences WHERE sequence_name LIKE 'users%'` |

---

## Verification Steps

After running the script:

```sql
-- 1. Confirm IDs are now sequential with no gaps
SELECT id FROM users ORDER BY id;

-- 2. Confirm child table FKs are intact (no orphaned rows)
SELECT COUNT(*) FROM subscriptions        s LEFT JOIN users u ON s.user_id = u.id WHERE u.id IS NULL;
SELECT COUNT(*) FROM translation_usage    t LEFT JOIN users u ON t.user_id = u.id WHERE u.id IS NULL;
SELECT COUNT(*) FROM pending_meter_events p LEFT JOIN users u ON p.user_id = u.id WHERE u.id IS NULL;

-- 3. Confirm sequence is set correctly
SELECT last_value FROM users_id_seq;

-- 4. Confirm row count is unchanged
SELECT COUNT(*) FROM users;
```

All orphan counts should be **0**. `last_value` should equal `MAX(users.id)`.

After JWT_SECRET rotation: verify that an old token returns 401 and a fresh login works correctly.
