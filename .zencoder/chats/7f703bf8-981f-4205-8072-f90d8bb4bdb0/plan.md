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

Save the output to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\7f703bf8-981f-4205-8072-f90d8bb4bdb0/spec.md` with:

- Technical context (language, dependencies)
- Implementation approach
- Source code structure changes
- Data model / API / interface changes
- Verification approach

If the task is complex enough, create a detailed implementation plan based on `c:\Users\david\Desktop\HariBackend\.zencoder\chats\7f703bf8-981f-4205-8072-f90d8bb4bdb0/spec.md`:

- Break down the work into concrete tasks (incrementable, testable milestones)
- Each task should reference relevant contracts and include verification steps
- Replace the Implementation step below with the planned tasks

Rule of thumb for step size: each step should represent a coherent unit of work (e.g., implement a component, add an API endpoint, write tests for a module). Avoid steps that are too granular (single function).

Save to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\7f703bf8-981f-4205-8072-f90d8bb4bdb0/plan.md`. If the feature is trivial and doesn't warrant this breakdown, keep the Implementation step below as is.

**Stop here.** Present the specification (and plan, if created) to the user and wait for their confirmation before proceeding.

---

### [x] Step: Implementation

Implement the task according to the technical specification and general engineering best practices.

1. Break the task into steps where possible.
2. Implement the required changes in the codebase.
3. Add and run relevant tests and linters.
4. Perform basic manual verification if applicable.
5. After completion, write a report to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\7f703bf8-981f-4205-8072-f90d8bb4bdb0/report.md` describing:
   - What was implemented
   - How the solution was tested
   - The biggest issues or challenges encountered

---

### [x] Step: Heartbeat-based Reliable Detection

Extend the `extension_enabled` feature so backend can reliably tell whether each user actually has the extension enabled, without depending on Chrome firing disable events.

Backend work:
- Add column `extension_last_seen_at TIMESTAMPTZ` to `users` (idempotent migration in `db.js`).
- Update `POST /extension/status` to also stamp `extension_last_seen_at = NOW()` on every call.
- Add `GET /extension/uninstalled?token=...` endpoint that flips `extension_enabled = false` (used via `chrome.runtime.setUninstallURL`). Validate token, handle invalid/expired gracefully.
- Include `extension_last_seen_at` in `GET /me` response.
- Optional helper view/query: an "effectively enabled" computed flag = `extension_enabled = true AND extension_last_seen_at > NOW() - INTERVAL '2 days'`.

Edge cases:
- Token missing/invalid on uninstall endpoint → still return 200 (Chrome navigates regardless; don't error the user).
- Existing users: `extension_last_seen_at` defaults to NULL, treated as "never seen".
- Concurrent heartbeats: last-write-wins.

After implementation, commit and push to `https://github.com/fusion20k/haribackend`.
