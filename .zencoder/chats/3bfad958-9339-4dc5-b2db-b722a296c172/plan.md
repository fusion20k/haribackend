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

Save the output to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\3bfad958-9339-4dc5-b2db-b722a296c172/spec.md` with:

- Technical context (language, dependencies)
- Implementation approach
- Source code structure changes
- Data model / API / interface changes
- Verification approach

If the task is complex enough, create a detailed implementation plan based on `c:\Users\david\Desktop\HariBackend\.zencoder\chats\3bfad958-9339-4dc5-b2db-b722a296c172/spec.md`:

- Break down the work into concrete tasks (incrementable, testable milestones)
- Each task should reference relevant contracts and include verification steps
- Replace the Implementation step below with the planned tasks

Rule of thumb for step size: each step should represent a coherent unit of work (e.g., implement a component, add an API endpoint, write tests for a module). Avoid steps that are too granular (single function).

Save to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\3bfad958-9339-4dc5-b2db-b722a296c172/plan.md`. If the feature is trivial and doesn't warrant this breakdown, keep the Implementation step below as is.

**Stop here.** Present the specification (and plan, if created) to the user and wait for their confirmation before proceeding.

---

### [x] Step: Implement `db.js` changes

Modify `db.js` with all database-layer changes per spec:

1. **`updateUserTrialStart`**: Change SQL to set `plan_status = 'free'`, store `subscription_id`, set `has_access = TRUE`. Remove changes to `trial_chars_limit`, `trial_chars_used`, `trial_started_at`, and `free_chars_reset_date`.

2. **`updateUserPlanStatus`**: Remove the special `if (planStatus === 'active')` branch. Add a new `if (planStatus === 'pre')` branch with `trial_chars_limit = 1000000` and conditional resets of `trial_chars_used` and `free_chars_reset_date` (only when transitioning from non-`pre`). The `'active'` case falls through to the generic branch unchanged.

3. **`cancelUserSubscription`**: Replace `plan_status = 'canceled', has_access = FALSE` with a full reset to `free` (25K limit, 0 used, 30-day reset date, `subscription_id = NULL`).

4. **`initDatabase`**: Add a migration after the existing `trialing → free` migration that converts all `plan_status = 'canceled'` users to `free` with `has_access = TRUE`, `trial_chars_limit = 25000`, `trial_chars_used = 0`, `free_chars_reset_date = NOW() + 30 days`, `subscription_id = NULL`. Add a `console.log` for it.

Verification: Start server, confirm DB init logs success including the new canceled-users migration line.

---

### [x] Step: Implement `index.js` — Stripe webhook handlers

Modify the four Stripe webhook event handlers in `index.js`:

1. **`checkout.session.completed`**: In the `subscription.status === "active"` branch, change `updateUserPlanStatus(userId, "active", ...)` → `updateUserPlanStatus(userId, "pre", ...)`. The `"trialing"` branch already calls `updateUserTrialStart` — no change needed.

2. **`customer.subscription.created`**: Same pattern — change `"active"` → `"pre"` in the `updateUserPlanStatus` call.

3. **`customer.subscription.updated`**: 
   - Change `"active"` → `"pre"` in the `updateUserPlanStatus` call.
   - In the `["canceled", "unpaid", "past_due"]` branch, replace `updateUserPlanStatus(subRow.user_id, subscription.status, false, null)` with `cancelUserSubscription(subRow.user_id)`.

4. **`customer.subscription.deleted`**: Replace `updateUserPlanStatus(subRow.user_id, "canceled", false, null)` with `cancelUserSubscription(subRow.user_id)`.

Verification: Confirm `cancelUserSubscription` is already destructured from `./db` at the top of `index.js` (it is). No import changes needed.

---

### [x] Step: Implement `index.js` — endpoint guards and access logic

Update all endpoint-level guard conditions and access checks in `index.js`:

1. **`/billing/verify-session`**: In the `subscription.status === "active"` branch, change `updateUserPlanStatus(req.userId, "active", ...)` → `updateUserPlanStatus(req.userId, "pre", ...)`.

2. **`/start-trial`**: Change guard from `user.plan_status === "trialing" || user.plan_status === "active" || user.plan_status === "canceled"` to `["pre", "active"].includes(user.plan_status) || !!user.subscription_id`.

3. **`/billing/create-checkout-session`**: Change `if (user.plan_status === "active")` → `if (["active", "pre"].includes(user.plan_status))`.

4. **`/billing/create-trial-checkout-session`**: Change guard from `user.plan_status === "trialing" || user.plan_status === "active" || user.plan_status === "canceled"` to `["pre", "active"].includes(user.plan_status) || !!user.subscription_id`.

5. **`/me`**: Change char reset condition from `user.plan_status === "free" || user.plan_status === "active"` to `["free", "pre"].includes(user.plan_status)`.

---

### [x] Step: Implement `index.js` — `/translate` endpoint

Update all plan-status checks inside the `/translate` handler:

1. **Allow-list check**: `!["free", "trialing", "active"].includes(user.plan_status)` → `!["free", "active", "pre"].includes(user.plan_status)`

2. **Char reset trigger**: `if (user.plan_status === "free" || user.plan_status === "active")` → `if (["free", "pre"].includes(user.plan_status))`

3. **Char tracking block entry**: `if (user && ["free", "trialing", "active"].includes(user.plan_status))` → `if (user && ["free", "pre"].includes(user.plan_status))`

4. **Inside char tracking block**:
   - `monthly_limit_reached` sub-check: `if (user.plan_status === "active")` → `if (user.plan_status === "pre")`
   - Early Stripe trial-end: `if (user.plan_status === "trialing" && stripe && updatedUser.subscription_id)` → `if (user.plan_status === "free" && stripe && updatedUser.subscription_id)`

Verification: Read through the entire `/translate` handler after changes to confirm no remaining references to `"trialing"` or the old `"active"`-as-premium logic.

---

### [x] Step: Final review and report

1. Search `index.js` and `db.js` for any remaining references to `"trialing"` or `"canceled"` that should have been updated. Confirm only legitimate uses remain (e.g., the `trialing → free` migration in `initDatabase`, logging strings, Stripe status string comparisons that correctly route to `updateUserTrialStart`).
2. Start the server with `node index.js` and confirm clean startup with no errors.
3. Write a report to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\3bfad958-9339-4dc5-b2db-b722a296c172/report.md` describing:
   - What was implemented
   - How the solution was tested
   - The biggest issues or challenges encountered
