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

### [x] Step 1: Fix `/translate` — billable char calculation

In `index.js`, after the full translation flow (after `toTranslate` is populated and Azure call is done), add a `cacheChars` / `liveChars` / `billableChars` computation block using `cleanedData[i].cleaned.length`:

- `cacheChars` = cleaned length for non-skipped segments that were cache hits
- `liveChars` = cleaned length for segments in `toTranslate` (cache misses sent to Azure)
- `billableChars = cacheChars + liveChars` (excludes `skipIndices` — non-translatable pass-throughs)

**Verification:** Log `[payg] billing cache=X live=Y total=Z` and confirm correct values in each scenario.

---

### [x] Step 2: Update PAYG billing block in `/translate`

Replace every use of `totalChars` in the PAYG `if (user.plan_status === "payg")` block with `billableChars`:

- `incrementUserTrialChars(req.userId, billableChars)`
- `charsToReport = Math.ceil(billableChars / 1000)`
- `payg_chars_used` in response uses `billableChars`
- Add explicit `console.log` showing `cache=${cacheChars} live=${liveChars} total=${billableChars} units=${charsToReport}`

**Verification:** All-cache request → `liveChars=0, cacheChars>0` logged. Stripe event fires with correct units.

---

### [x] Step 3: Update free/pre plan billing in `/translate`

In the `if (user.plan_status === "free" || "pre")` block, replace `totalChars` with `billableChars` for consistency. This ensures `trial_chars_used` reflects the same metric across all plan types.

**Verification:** Free user's `trial_chars_used` increments by `billableChars`, not `totalChars`.

---

### [x] Step 4: Fix `/dictionary` billing metric

Change `totalChars` in the `/dictionary` endpoint from `word.length + english.length + contextStr.length` to `word.trim().length`. The dictionary always calls the LLM; the word itself is the billable unit, not the helper fields passed to the LLM.

Apply the same change in both the PAYG block and the free/pre block.

**Verification:** Dictionary request with long context string charges only `word.trim().length` chars.

---

### [x] Step 5: Write implementation report

Write a report to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\6cdfcc62-50dc-40e5-9bc4-175367197fd9/report.md` describing:
- What was implemented
- How the solution was verified
- Any edge cases or challenges encountered
