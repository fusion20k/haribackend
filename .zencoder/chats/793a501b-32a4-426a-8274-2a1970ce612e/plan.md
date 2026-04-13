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

Save the output to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\793a501b-32a4-426a-8274-2a1970ce612e/spec.md` with:

- Technical context (language, dependencies)
- Implementation approach
- Source code structure changes
- Data model / API / interface changes
- Verification approach

If the task is complex enough, create a detailed implementation plan based on `c:\Users\david\Desktop\HariBackend\.zencoder\chats\793a501b-32a4-426a-8274-2a1970ce612e/spec.md`:

- Break down the work into concrete tasks (incrementable, testable milestones)
- Each task should reference relevant contracts and include verification steps
- Replace the Implementation step below with the planned tasks

Rule of thumb for step size: each step should represent a coherent unit of work (e.g., implement a component, add an API endpoint, write tests for a module). Avoid steps that are too granular (single function).

Save to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\793a501b-32a4-426a-8274-2a1970ce612e/plan.md`. If the feature is trivial and doesn't warrant this breakdown, keep the Implementation step below as is.

**Stop here.** Present the specification (and plan, if created) to the user and wait for their confirmation before proceeding.

---

### [x] Step 1: Schema migration + DB read functions

**Files**: `db.js`

- Add `chars_used_at_payg_start INTEGER NOT NULL DEFAULT 0` column migration to `initDatabase()` (idempotent `DO $$ IF NOT EXISTS` block)
- Add `chars_used_at_payg_start` to the SELECT column list in `getUserById()` and `getUserByEmail()`

**Verify**: Module loads without error — `node -e "require('./db.js')" 2>&1`

---

### [x] Step 2: Fix `activatePaygPlan()` — remove char reset, add snapshot

**Files**: `db.js`

- Replace `trial_chars_used = 0` with `chars_used_at_payg_start = trial_chars_used` (snapshot current usage before PAYG starts)
- Remove `free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE` (preserve existing cycle window)
- Add `chars_used_at_payg_start` to the RETURNING clause

**Verify**: Check the SQL UPDATE query manually; `node -e "require('./db.js')"` loads clean

---

### [x] Step 3: Fix `cancelUserSubscription()` — remove char reset

**Files**: `db.js`

- Replace `trial_chars_used = 0` with `trial_chars_used = chars_used_at_payg_start` (restore to pre-PAYG value — only free usage counts toward the 25k limit)
- Remove `free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE` (preserve cycle window)
- Add `chars_used_at_payg_start = 0` (clear the PAYG display baseline)

**Verify**: Confirm user returning from PAYG to free has `trial_chars_used` restored to their pre-PAYG value

---

### [x] Step 4: Fix `updateUserPlanStatus()` — remove char reset for `pre` plan

**Files**: `db.js`

- Remove `trial_chars_used = CASE WHEN plan_status != 'pre' THEN 0 ELSE trial_chars_used END` (preserve cycle chars on upgrade to premium)
- Remove `free_chars_reset_date = CASE WHEN plan_status != 'pre' THEN (NOW() + INTERVAL '30 days')::DATE ELSE free_chars_reset_date END` (preserve cycle window)

**Verify**: The `pre`-branch UPDATE query no longer touches `trial_chars_used` or `free_chars_reset_date`

---

### [x] Step 5: Fix `payg_chars_used` display in API responses

**Files**: `index.js`

- `/me` endpoint: change `payg_chars_used = user.trial_chars_used ?? 0` to `(user.trial_chars_used ?? 0) - (user.chars_used_at_payg_start ?? 0)`
- `/translate` endpoint (PAYG response block): change `payg_chars_used: updatedCharsUsed` to `payg_chars_used: updatedCharsUsed - (user.chars_used_at_payg_start ?? 0)`
- `/debug/me` endpoint: add `chars_used_at_payg_start` to the debug user object

**Verify**: The display values make sense (≥ 0, represent only PAYG-period chars); no undefined/NaN

---

### [x] Step 6: Final verification

- Confirm `node -e "require('./db.js')"` and `node -e "require('./index.js')" 2>&1 | head -5` load without syntax errors
- Review all three changed DB functions and two response blocks for correctness
- Write report to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\793a501b-32a4-426a-8274-2a1970ce612e/report.md`
