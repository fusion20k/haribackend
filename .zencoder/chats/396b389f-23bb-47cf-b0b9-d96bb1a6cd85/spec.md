# Technical Specification: Pay-As-You-Go (PAYG) Plan

## Difficulty Assessment

**Hard** — New Stripe billing mode (metered/usage-based), DB schema changes, multiple endpoint modifications, new billing flows, and frontend coordination.

---

## Technical Context

- **Language/Runtime**: Node.js (Express)
- **Database**: PostgreSQL via `pg` Pool
- **Payments**: Stripe SDK (`stripe` v20)
- **Translation**: Azure Cognitive Translator API
- **Key dependencies**: `stripe`, `pg`, `jsonwebtoken`, `bcrypt`, `axios`

### Current Plan Statuses

| `plan_status` | Description | `trial_chars_limit` | `has_access` |
|---|---|---|---|
| `free` | Default free tier | 25,000 chars / 30 days | TRUE |
| `pre` | Paid monthly subscription (active) | 1,000,000 chars / 30 days | TRUE |
| `active` | Legacy active (treated same as `pre`) | varies | TRUE |
| (null / canceled) | No access | — | FALSE |

New status to add:

| `plan_status` | Description | `trial_chars_limit` | `has_access` |
|---|---|---|---|
| `payg` | Pay-as-you-go, billed per char | 20,000,000 (soft limit) | TRUE |

---

## Pricing Model

- **Azure cost to us**: ~$0.01 per 1,000 characters (input to Azure)
- **User charge**: $0.04 per 1,000 characters (4× markup)
- **Billing mechanism**: Stripe **metered billing** — usage is reported to Stripe after each translation; Stripe invoices the user at the end of each billing period
- **Soft limit**: 20,000,000 characters per billing period (no hard block by default — see open questions)

---

## Implementation Approach

### 1. Stripe Product Setup (Manual, one-time)

A new Stripe Product and Price must be created manually in the Stripe Dashboard (or via the Stripe CLI):

- **Product**: "Hari PAYG Translation"
- **Price type**: Recurring, usage-based (metered)
- **Billing scheme**: `per_unit`
- **Unit amount**: `4` cents ($0.04)
- **Transform quantity**: `divide_by: 1000, round: up` → charges $0.04 per 1,000 chars
- **Usage type**: `metered`
- **Aggregate usage**: `sum` (accumulate within billing period)
- **Interval**: monthly

The resulting Price ID goes in env var `STRIPE_PAYG_PRICE_ID`.

**Reporting usage to Stripe**: After each translation, call:
```js
stripe.subscriptionItems.createUsageRecord(stripeItemId, {
  quantity: charsTranslated,  // raw char count, not divided by 1000
  timestamp: 'now',
  action: 'increment'
})
```
Stripe applies the `transform_quantity` division internally when invoicing.

### 2. Database Schema Changes

New column on `users` table:
```sql
ALTER TABLE users ADD COLUMN stripe_item_id VARCHAR(255);
```

This stores the Stripe **subscription item** ID (not the subscription ID), required for `createUsageRecord()`. The existing `subscription_id` column stores the subscription ID; `stripe_item_id` stores the item ID within that subscription.

Existing columns **reused** for PAYG (no new columns needed):
- `trial_chars_used` — cumulative chars in current billing period (for soft limit enforcement)
- `trial_chars_limit` — set to `20,000,000` for PAYG users
- `free_chars_reset_date` — reset date for the current billing period

When activating PAYG:
```sql
UPDATE users SET
  plan_status = 'payg',
  has_access = TRUE,
  trial_chars_used = 0,
  trial_chars_limit = 20000000,
  free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE,
  subscription_id = $stripeSubscriptionId,
  stripe_item_id = $stripeItemId
WHERE id = $userId
```

### 3. New DB Functions (`db.js`)

- `activatePaygPlan(userId, subscriptionId, stripeItemId)` — sets `plan_status = 'payg'`, stores item ID, resets chars
- `updateUserStripeItemId(userId, stripeItemId)` — update item ID independently if needed
- `initDatabase()` — add `stripe_item_id` column migration

### 4. New API Endpoint (`index.js`)

**`POST /billing/create-payg-checkout-session`** (auth required)

- Creates a Stripe Checkout Session in `subscription` mode
- Uses `STRIPE_PAYG_PRICE_ID` (the metered price)
- No trial period
- Redirects to existing `/checkout-success` and `/checkout-cancel` pages
- Guards: blocks if user already on `payg` or `pre`/`active` plan
- Returns `{ checkoutUrl }` same as existing checkout sessions

### 5. Stripe Webhook Changes (`index.js`)

The existing `checkout.session.completed` and `customer.subscription.created` / `customer.subscription.updated` / `customer.subscription.deleted` handlers need PAYG awareness:

- **Detect PAYG**: check if `subscription.items.data[0].price.id === process.env.STRIPE_PAYG_PRICE_ID`
- **On PAYG subscription created/activated**: call `activatePaygPlan()`, extract `stripeItemId` from `subscription.items.data[0].id`
- **On PAYG subscription canceled/deleted**: call `cancelUserSubscription()` (same as existing — reverts to `free`)
- **On PAYG subscription updated**: update subscription record; re-activate PAYG if status returns to `active`

### 6. `/translate` Endpoint Changes (`index.js`)

**Allowed plan check** — add `"payg"` to the allowed statuses:
```js
// Current:
if (!["free", "active", "pre"].includes(user.plan_status)) { ... }
// New:
if (!["free", "active", "pre", "payg"].includes(user.plan_status)) { ... }
```

**Soft limit check for PAYG** — warn but do NOT block:
```js
if (user.plan_status === "payg") {
  // Reset chars if billing period has rolled over
  const reset = await resetUserCharsIfNeeded(req.userId);
  if (reset) user = await getUserById(req.userId);

  const charsUsed = user.trial_chars_used ?? 0;
  const softLimit = user.trial_chars_limit ?? 20_000_000;
  // Include warning in response if over soft limit, but allow translation to proceed
}
```

**After translation — report to Stripe + track chars**:
```js
if (user.plan_status === "payg") {
  // Track ALL chars (cached + fresh) in DB and bill ALL to Stripe
  await incrementUserTrialChars(req.userId, totalChars);

  // Report ALL chars to Stripe metered billing (non-blocking, best-effort)
  const freshUser = await getUserById(req.userId);
  if (freshUser?.stripe_item_id && stripe) {
    setImmediate(async () => {
      try {
        await stripe.subscriptionItems.createUsageRecord(
          freshUser.stripe_item_id,
          { quantity: totalChars, timestamp: 'now', action: 'increment' }
        );
      } catch (e) {
        console.error("PAYG Stripe usage report failed (non-fatal):", e.message);
      }
    });
  }

  const updatedCharsUsed = (user.trial_chars_used ?? 0) + totalChars;
  const softLimit = user.trial_chars_limit ?? 20_000_000;
  const response = { translations, payg_chars_used: updatedCharsUsed, payg_chars_limit: softLimit };
  if (updatedCharsUsed >= softLimit) {
    response.payg_soft_limit_warning = "You have exceeded the 20M character soft limit. Contact support if needed.";
  }
  return res.json(response);
}
```

> **Note**: We report ALL chars (totalChars — both cached and Azure-sent) to Stripe for billing, matching the user's requirement that every returned translation counts toward the PAYG bill.

### 7. `/me` Endpoint Changes (`index.js`)

- Add `"payg"` to the plan statuses that trigger `resetUserCharsIfNeeded`
- Return PAYG-specific fields when `plan_status === "payg"`:
  ```json
  {
    "payg_chars_used": 1234567,
    "payg_chars_limit": 20000000
  }
  ```
  (Character count only — no dollar estimate per user's preference)

### 8. `resetUserCharsIfNeeded` — No changes needed

This function already handles any plan by resetting `trial_chars_used` to `0` when `free_chars_reset_date` passes, which works identically for PAYG users.

---

## Source Code Files Modified

| File | Changes |
|---|---|
| `db.js` | `initDatabase()` adds `stripe_item_id` column; new `activatePaygPlan()` function; update `getUserById` / `getUserByEmail` SELECT to include `stripe_item_id` |
| `index.js` | New `/billing/create-payg-checkout-session` endpoint; webhook PAYG handling; `/translate` PAYG access check + usage reporting; `/me` PAYG fields |

---

## API Changes

### New Endpoint

**`POST /billing/create-payg-checkout-session`**
- Auth: Bearer token required
- Body: none
- Response: `{ checkoutUrl: string }`
- Errors: `400` if already on payg/pre/active plan, `503` if Stripe not configured

### Modified Endpoints

**`POST /translate`** — new response fields for PAYG users:
```json
{
  "translations": [...],
  "payg_chars_used": 12345,
  "payg_chars_limit": 20000000
}
```

**`GET /me`** — new response fields for PAYG users:
```json
{
  "plan_status": "payg",
  "payg_chars_used": 12345,
  "payg_chars_limit": 20000000,
  "trial_chars_used": 12345,
  "trial_chars_limit": 20000000
}
```

---

## Environment Variables

New variable to add to `.env`:
```
STRIPE_PAYG_PRICE_ID=price_your_payg_metered_price_id_here
```

---

## Frontend (Chrome Extension) Coordination

The extension needs to handle `plan_status: "payg"` in all places where plan status is read.

### 1. Plan Detection
- Treat `payg` as full-access (like `pre`)
- Display "Pay-As-You-Go" label rather than "Premium" or "Free Trial"

### 2. Usage Display
- `/me` response will include `payg_chars_used`, `payg_chars_limit`, `payg_cost_estimate_usd`
- Show estimated cost (e.g., "Est. this month: $0.49") instead of char limit progress bar

### 3. Upgrade Flow
- Show PAYG option in billing UI alongside existing Premium plan
- Call `POST /billing/create-payg-checkout-session` to get checkout URL
- Open checkout URL in a new tab (same as existing Premium checkout)

### 4. Post-Translation Response
- `/translate` response will include `payg_chars_used` / `payg_chars_limit` for PAYG users
- Extension should update displayed usage after each translation

### 5. Error Handling
- New error code `payg_soft_limit_reached` (HTTP 402) — show "Contact support to increase your limit"

---

## Decisions (Confirmed by User)

1. **Soft limit behavior**: Warned but allowed to continue — no hard block at 20M chars.
2. **Which chars to bill**: ALL chars returned to the user (both cache hits and cache misses) count toward the PAYG bill. This means Stripe usage records report total chars, not just Azure-sent chars.
3. **PAYG → cancellation behavior**: User reverts to `free` plan (25K chars/month).
4. **Upgrade path**: `pre`/`active` plan users CAN switch to PAYG (they still pay for their current period).
5. **Cost estimate in /me**: Return just the character count, not dollar estimates.

---

## Verification Approach

1. **Lint**: `node --check index.js db.js` (no linter configured in project)
2. **Manual smoke test**:
   - Sign up as new user → `plan_status: "free"`
   - Call `/billing/create-payg-checkout-session` → get checkout URL
   - Complete Stripe test checkout → webhook fires → `plan_status: "payg"` in DB
   - Call `/translate` → translations returned, `payg_chars_used` incremented
   - Check Stripe dashboard → usage record created on subscription item
   - Call `/me` → `payg_cost_estimate_usd` returned
   - Cancel subscription in Stripe → webhook fires → user reverts to `free`
3. **DB verification**: `SELECT id, email, plan_status, stripe_item_id, trial_chars_used, trial_chars_limit FROM users WHERE id = <id>`
