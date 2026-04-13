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

Save the output to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\6cdfcc62-50dc-40e5-9bc4-175367197fd9/spec.md` with:

- Technical context (language, dependencies)
- Implementation approach
- Source code structure changes
- Data model / API / interface changes
- Verification approach

If the task is complex enough, create a detailed implementation plan based on `c:\Users\david\Desktop\HariBackend\.zencoder\chats\6cdfcc62-50dc-40e5-9bc4-175367197fd9/spec.md`:

- Break down the work into concrete tasks (incrementable, testable milestones)
- Each task should reference relevant contracts and include verification steps
- Replace the Implementation step below with the planned tasks

Rule of thumb for step size: each step should represent a coherent unit of work (e.g., implement a component, add an API endpoint, write tests for a module). Avoid steps that are too granular (single function).

Save to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\6cdfcc62-50dc-40e5-9bc4-175367197fd9/plan.md`. If the feature is trivial and doesn't warrant this breakdown, keep the Implementation step below as is.

**Stop here.** Present the specification (and plan, if created) to the user and wait for their confirmation before proceeding.

---

### [x] Step 1: Fix `cancelUserSubscription` — clean free-plan reset (BUG-02, BUG-03)

**File**: `db.js`, `cancelUserSubscription()`

Change the UPDATE query to:
- Set `trial_chars_used = 0` (was: `chars_used_at_payg_start`) — gives a clean slate on free
- Set `free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE` — fresh 30-day window every time

Keep all other fields: `plan_status='free'`, `has_access=TRUE`, `trial_chars_limit=25000`, `chars_used_at_payg_start=0`, `subscription_id=NULL`, `stripe_item_id=NULL`

**Verification:**
- Pre user with 500k chars_used cancels → `trial_chars_used=0`, `trial_chars_limit=25000`, `free_chars_reset_date` is ~30 days from now
- PAYG user with 2M chars_used cancels → same clean reset
- Free user with no subscription calls cancel → `trial_chars_used=0`, no error

---

### [x] Step 2: Fix webhook revocation guard for null subscription_id (BUG-08)

**File**: `index.js`, `customer.subscription.updated` and `customer.subscription.deleted` handlers

In both handlers, the guard that checks if the webhook's subscription matches the user's current subscription is:
```js
if (currentUser && currentUser.subscription_id === subscription.id)
```

Change to:
```js
if (currentUser && (!currentUser.subscription_id || currentUser.subscription_id === subscription.id))
```

This ensures that if `subscription_id` is NULL (e.g. after a race condition or prior cancel), the revocation still fires instead of being silently skipped.

**Verification:** Simulate webhook arriving for a user whose `subscription_id` is NULL — revocation should proceed.

---

### [x] Step 3: Add idempotency guards to `activatePaygPlan` and `updateUserPlanStatus` (BUG-04, BUG-05)

**File**: `db.js`

**`activatePaygPlan()`**: Change the `WHERE` clause to:
```sql
WHERE id = $3
  AND NOT (plan_status = 'payg' AND subscription_id = $1)
```
This prevents the double-webhook race from re-snapshotting `chars_used_at_payg_start` after chars have already accumulated.

**`updateUserPlanStatus()` for `planStatus = 'pre'`**: Add to the `WHERE` clause:
```sql
AND NOT (plan_status = 'pre' AND subscription_id = COALESCE($5, subscription_id))
```
This prevents the same double-snapshot problem for pre-plan transitions.

Log a warning when the guard fires (rows returned = 0) so it's visible in logs.

**Verification:** Send two `checkout.session.completed` events for the same subscription — second call should produce 0 rows updated and log warning.

---

### [x] Step 4: Fix `switch-plan` — remove premature `cancelUserSubscription` call (BUG-01)

**File**: `index.js`, `POST /billing/switch-plan`

**Current (broken) flow**:
1. Cancel old sub on Stripe
2. `cancelUserSubscription()` → user drops to free immediately
3. Create checkout session

**Fixed flow**:
1. Validate that user is on a paid plan (`pre` or `payg`)
2. Store old `subscription_id` to cancel
3. Create the new checkout session for the target plan
4. Cancel old Stripe subscription (only Stripe-side, no DB change)
5. Return checkout URL — user remains on their current plan until new checkout is completed

The existing `checkout.session.completed` webhook already handles canceling the previous subscription when the new one activates (lines ~188–199 in `index.js`). That path remains unchanged.

Do NOT call `cancelUserSubscription()` during the switch-plan request.

**Verification:**
- Switch pre→payg and abandon checkout → user remains on `pre` (not free)
- Switch payg→pre and abandon checkout → user remains on `payg` (not free)
- Switch pre→payg and complete checkout → user is `payg`, old sub is canceled

---

### [x] Step 5: Fix free/pre billing in `/translate` to use `billableChars` (BUG-06) — SKIPPED per user request (keep totalChars for free/pre)

---

### [x] Step 6: Fix checkout session guards (BUG-07)

**File**: `index.js`

**`/billing/create-checkout-session`**: Current guard:
```js
if (["active", "pre", "payg"].includes(user.plan_status))
```
Change to:
```js
if (["active", "pre", "payg"].includes(user.plan_status) || !!user.subscription_id)
```

**`/billing/create-trial-checkout-session`**: Current guard:
```js
if (["pre", "active"].includes(user.plan_status) || !!user.subscription_id)
```
Change to:
```js
if (["pre", "active", "payg"].includes(user.plan_status) || !!user.subscription_id)
```

**Verification:**
- Free user with `subscription_id` set → checkout rejected with 400
- PAYG user hitting trial-checkout endpoint → rejected with 400

---

### [x] Step 7: Refresh `free_chars_reset_date` on plan upgrades (BUG-09)

**File**: `db.js`

**`updateUserPlanStatus()` for `planStatus = 'pre'`**: Add to the SET clause:
```sql
free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE
```

**`activatePaygPlan()`**: Add to the SET clause:
```sql
free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE
```

This ensures the monthly quota window is anchored to the plan start date, not the original signup date.

**Verification:** Free user who signed up 20 days ago upgrades to pre → `free_chars_reset_date` should be ~30 days from now, not 10 days from now.

---

### [x] Step 8: Add `free_chars_reset_date` to `/me` response (BUG-10)

**File**: `index.js`, `GET /me`

Add `free_chars_reset_date: user.free_chars_reset_date || null` to the `meResponse` object.

**Verification:** `GET /me` response includes `free_chars_reset_date` field for all plan types.

---

### [x] Step 9: Write implementation report

Write a report to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\6cdfcc62-50dc-40e5-9bc4-175367197fd9/report.md` describing:
- What was implemented per step
- Which bugs were fixed (BUG-01 through BUG-10)
- How the solution was verified for each scenario
- Any edge cases or challenges encountered
