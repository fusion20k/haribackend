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

Save the output to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\b6f9cb6d-97c3-46b9-a50d-1b5ea6dd4e46/spec.md` with:

- Technical context (language, dependencies)
- Implementation approach
- Source code structure changes
- Data model / API / interface changes
- Verification approach

If the task is complex enough, create a detailed implementation plan based on `c:\Users\david\Desktop\HariBackend\.zencoder\chats\b6f9cb6d-97c3-46b9-a50d-1b5ea6dd4e46/spec.md`:

- Break down the work into concrete tasks (incrementable, testable milestones)
- Each task should reference relevant contracts and include verification steps
- Replace the Implementation step below with the planned tasks

Rule of thumb for step size: each step should represent a coherent unit of work (e.g., implement a component, add an API endpoint, write tests for a module). Avoid steps that are too granular (single function).

Save to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\b6f9cb6d-97c3-46b9-a50d-1b5ea6dd4e46/plan.md`. If the feature is trivial and doesn't warrant this breakdown, keep the Implementation step below as is.

**Stop here.** Present the specification (and plan, if created) to the user and wait for their confirmation before proceeding.

---

### [x] Step: Implementation — Task 1: Add user load + access check to `/tts`

In `index.js` at the top of the `/tts` handler (after the `AZURE_SPEECH_KEY` guard), add:
- `let user = await getUserById(req.userId)`
- Access check: `(user && user.has_access) || (await userHasActiveSubscription(req.userId))` → 402 if no access
- Compute `const ttsChars = text.length` and `const weightedChars = ttsChars * 2`

Verify: unauthenticated call still returns 401 (from `requireAuth`); valid user proceeds.

---

### [x] Step: Implementation — Task 2: Cap enforcement for free + premium plans

In `/tts`, after the user load (Task 1), add the pre-Azure guard:
- For `plan_status` in `['free', 'pre']`: call `resetUserCharsIfNeeded`, re-fetch user, check `trial_chars_used >= trial_chars_limit`
- Return 402 `monthly_limit_reached` for premium, `trial_exhausted` for free (matching exact error shapes used in `/translate`)
- For `plan_status === 'payg'`: call `resetUserCharsIfNeeded` only (no block)

Verify: a user at/over their limit gets 402 before Azure is ever called.

---

### [x] Step: Implementation — Task 3: Char increment + Stripe meter event after successful TTS

In `/tts`, after the `response.ok` check and before `res.send(Buffer.from(buffer))`:
- **PAYG**: `await incrementUserTrialChars(req.userId, weightedChars)`, then fire `stripe.billing.meterEvents.create` with `event_name: "translation_chars"`, `value: String(Math.ceil(weightedChars / 1000))` (non-fatal, matches pattern in `/translate`)
- **Free + Premium**: `await incrementUserTrialChars(req.userId, weightedChars)`
- Log `[tts] billed user=... raw=... weighted=... units=...` for PAYG

Verify: after a successful TTS call, `trial_chars_used` in DB increases by `2 * text.length`; Stripe meter log appears for PAYG users.

---

### [x] Step: Implementation — Task 4: Write report

After Tasks 1–3 are complete and manually verified, write a report to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\b6f9cb6d-97c3-46b9-a50d-1b5ea6dd4e46/report.md` describing:
- What was implemented
- How the solution was tested
- Any issues or edge cases encountered
