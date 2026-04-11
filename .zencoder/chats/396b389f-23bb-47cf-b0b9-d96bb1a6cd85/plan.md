# Spec and build

## Agent Instructions

Ask the user questions when anything is unclear or needs their input. This includes:

- Ambiguous or incomplete requirements
- Technical decisions that affect architecture or user experience
- Trade-offs that require business context

Do not make assumptions on important decisions — get clarification first.

---

## Workflow Steps

### [x] Step: Technical Specification

Assess the task's difficulty, as underestimating it leads to poor outcomes.

- easy: Straightforward implementation, trivial bug fix or feature
- medium: Moderate complexity, some edge cases or caveats to consider
- hard: Complex logic, many caveats, architectural considerations, or high-risk changes

Create a technical specification for the task that is appropriate for the complexity level:

- Review the existing codebase architecture and identify reusable components.
- Define the implementation approach based on established patterns in the project.
- Identify all source code files that will be created or modified.
- Define any necessary data model, API, or interface changes.
- Describe verification steps using the project's test and lint commands.

Save the output to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\396b389f-23bb-47cf-b0b9-d96bb1a6cd85/spec.md` with:

- Technical context (language, dependencies)
- Implementation approach
- Source code structure changes
- Data model / API / interface changes
- Verification approach

If the task is complex enough, create a detailed implementation plan based on `c:\Users\david\Desktop\HariBackend\.zencoder\chats\396b389f-23bb-47cf-b0b9-d96bb1a6cd85/spec.md`:

- Break down the work into concrete tasks (incrementable, testable milestones)
- Each task should reference relevant contracts and include verification steps
- Replace the Implementation step below with the planned tasks

Rule of thumb for step size: each step should represent a coherent unit of work (e.g., implement a component, add an API endpoint, write tests for a module). Avoid steps that are too granular (single function).

Save to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\396b389f-23bb-47cf-b0b9-d96bb1a6cd85/plan.md`. If the feature is trivial and doesn't warrant this breakdown, keep the Implementation step below as is.

**Stop here.** Present the specification (and plan, if created) to the user and wait for their confirmation before proceeding.

---

### [x] Step: DB Schema Migration & PAYG DB Functions

Add `stripe_item_id` column to `users` table in `initDatabase()` and implement new PAYG-specific DB functions in `db.js`.

**Changes to `db.js`**:
- Add `stripe_item_id VARCHAR(255)` column migration (idempotent `DO $$ IF NOT EXISTS` block) inside `initDatabase()`
- Update `getUserById` and `getUserByEmail` SELECT queries to include `stripe_item_id`
- Add `activatePaygPlan(userId, subscriptionId, stripeItemId)` function — sets `plan_status = 'payg'`, `trial_chars_used = 0`, `trial_chars_limit = 20000000`, `free_chars_reset_date = now + 30 days`, stores subscription + item IDs
- Export new function from `module.exports`

**Verification**: `node --check db.js`; manually inspect that migration SQL is idempotent.

---

### [x] Step: New PAYG Checkout Endpoint

Add `POST /billing/create-payg-checkout-session` to `index.js`.

**Changes to `index.js`**:
- Import `activatePaygPlan` from `./db`
- Add new route that:
  - Requires auth (`requireAuth`)
  - Guards against users already on `payg` plan; allows `pre`/`active` users to switch (they still pay for current period)
  - Creates a Stripe Checkout Session using `STRIPE_PAYG_PRICE_ID` (metered price, `mode: "subscription"`, no trial)
  - Returns `{ checkoutUrl }` consistent with existing checkout endpoints
- Add `STRIPE_PAYG_PRICE_ID` to `.env.example`

**Verification**: `node --check index.js`; test endpoint returns 400 for already-subscribed users and 503 when Stripe not configured.

---

### [x] Step: Stripe Webhook PAYG Handling

Update the `/stripe/webhook` handler in `index.js` to detect and handle PAYG subscriptions.

**Changes to `index.js`**:
- In `checkout.session.completed`: after retrieving the subscription, check if `subscription.items.data[0].price.id === process.env.STRIPE_PAYG_PRICE_ID`. If so, call `activatePaygPlan(userId, subscription.id, subscription.items.data[0].id)` instead of the existing trial/active flow
- In `customer.subscription.created`: same PAYG detection and `activatePaygPlan()` call
- In `customer.subscription.updated`: detect PAYG; if status becomes `active`, call `activatePaygPlan()`; if `canceled/unpaid/past_due`, call `cancelUserSubscription()` (existing behavior)
- In `customer.subscription.deleted`: no change needed (existing `cancelUserSubscription()` covers it)

**Verification**: Test with Stripe CLI webhook forwarding (`stripe listen --forward-to localhost:10000/stripe/webhook`) using test events.

---

### [x] Step: Translate Endpoint PAYG Support

Update `POST /translate` in `index.js` to allow PAYG users, enforce the soft limit, and report metered usage to Stripe.

**Changes to `index.js`**:
- Add `"payg"` to the allowed plan status check (line ~765)
- Add PAYG soft-limit check (with `resetUserCharsIfNeeded`) before translation proceeds
- After successful translation, when `user.plan_status === "payg"`:
  - Call `incrementUserTrialChars(req.userId, totalChars)` for soft-limit tracking
  - Fire-and-forget (via `setImmediate`) a `stripe.subscriptionItems.createUsageRecord()` call using `user.stripe_item_id` and `totalChars` quantity (bill ALL chars, not just Azure-sent)
  - Return `payg_chars_used` and `payg_chars_limit` in response alongside `translations`
  - If over soft limit, include `payg_soft_limit_warning` (warn only, do NOT block)

**Verification**: Translate as PAYG user → check Stripe dashboard for usage record; check DB `trial_chars_used` increments.

---

### [x] Step: /me Endpoint PAYG Fields

Update `GET /me` in `index.js` to return PAYG usage and cost estimate.

**Changes to `index.js`**:
- Add `"payg"` to the plan statuses that trigger `resetUserCharsIfNeeded` (line ~537)
- When `user.plan_status === "payg"`, add to response:
  - `payg_chars_used` (alias for `trial_chars_used`)
  - `payg_chars_limit` (alias for `trial_chars_limit`)

**Verification**: Call `/me` as PAYG user → response contains `payg_chars_used` and `payg_chars_limit` fields.

---

### [x] Step: Write Report

After all implementation steps are complete, write a report to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\396b389f-23bb-47cf-b0b9-d96bb1a6cd85/report.md` describing:
- What was implemented
- How the solution was tested
- The biggest issues or challenges encountered
