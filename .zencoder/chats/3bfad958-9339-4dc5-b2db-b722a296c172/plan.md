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

### [x] Step: db.js — Schema migrations and new DB functions

Modify `db.js`:

1. In `initDatabase()`, add idempotent migrations:
   - Add `free_chars_reset_date DATE` column to `users` if missing.
   - Migrate all `plan_status = 'trialing'` users → `'free'`, set `trial_chars_limit = 25000`, seed `free_chars_reset_date` to next calendar month start.
   - Seed `free_chars_reset_date` for any existing `plan_status = 'free'` users where it is NULL.
2. Update `createUser()` INSERT to also set `plan_status = 'free'`, `has_access = TRUE`, `trial_chars_limit = 25000`, `trial_chars_used = 0`, `free_chars_reset_date = next month start`.
3. Add new exported function `resetFreeUserCharsIfNeeded(userId)`: if today >= `free_chars_reset_date`, reset `trial_chars_used = 0` and advance `free_chars_reset_date` by one calendar month; return updated row or null.
4. Add `free_chars_reset_date` to the SELECT list in `getUserById` and `getUserByEmail`.
5. Update `updateUserTrialStart()` hardcoded `trial_chars_limit = 10000` → `25000`.

Verification: server starts without error; migration log messages appear; `createUser` sets correct defaults.

---

### [x] Step: index.js — Access gate, /auth/signup, /me

Modify `index.js`:

1. Import `resetFreeUserCharsIfNeeded` from `./db`.
2. `userHasActiveSubscription()`: add `"free"` as an access-granting condition (user with `plan_status === "free"` always has access).
3. `POST /auth/signup`:
   - Remove the hard `if (!stripe) return 503` guard — Stripe is now optional at signup (still create Stripe customer if configured, but don't block).
   - Return `hasAccess: true`, `plan_status: "free"`, `trial_chars_used: 0`, `trial_chars_limit: 25000` in the response body.
4. `GET /me`:
   - Call `resetFreeUserCharsIfNeeded(req.userId)` when `user.plan_status === "free"` and re-fetch user if a reset occurred.
   - Return `hasAccess: true` for free-plan users.
   - Change fallback `trial_chars_limit ?? 10000` → `?? 25000`.

Verification: new signup response matches spec; `/me` for free user returns correct fields.

---

### [x] Step: index.js — /translate free plan support

Modify `POST /translate` in `index.js`:

1. Extend the access gate to allow `plan_status === "free"` (alongside `"trialing"` and `"active"`).
2. For `"free"` (and `"trialing"`) users: call `resetFreeUserCharsIfNeeded` before the char exhaustion check; re-read `trial_chars_used`/`trial_chars_limit` from the returned row if a reset happened.
3. Extend the exhaustion check from `=== "trialing"` to `["free", "trialing"].includes(user.plan_status)`. Update the error message to reference 25,000 characters. Do **not** attempt to cancel a Stripe subscription for `"free"` users.
4. Extend the post-translation char increment block from `=== "trialing"` to `["free", "trialing"].includes(user.plan_status)`. Keep the Stripe `trial_end: "now"` call guarded by `user.plan_status === "trialing"`.
5. Fix `billing/verify-session` stale fallback: `trial_chars_limit: 10000` → `25000`.

Verification: free-plan user can translate; chars increment; exhaustion returns 402 `trial_exhausted`; active user gets unlimited translations; global quota gate unchanged.

---

### [x] Step: Final verification and report

1. Start server locally (`node index.js`) — confirm no startup errors and migration log lines appear.
2. Manually verify the three key flows (new signup, free translate + exhaustion, active user translate).
3. Commit all changes.
4. Write report to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\3bfad958-9339-4dc5-b2db-b722a296c172/report.md`.
