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

Save the output to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\57f78c4b-b07a-4406-be82-b2c0560e6b9a/spec.md` with:

- Technical context (language, dependencies)
- Implementation approach
- Source code structure changes
- Data model / API / interface changes
- Verification approach

If the task is complex enough, create a detailed implementation plan based on `c:\Users\david\Desktop\HariBackend\.zencoder\chats\57f78c4b-b07a-4406-be82-b2c0560e6b9a/spec.md`:

- Break down the work into concrete tasks (incrementable, testable milestones)
- Each task should reference relevant contracts and include verification steps
- Replace the Implementation step below with the planned tasks

Rule of thumb for step size: each step should represent a coherent unit of work (e.g., implement a component, add an API endpoint, write tests for a module). Avoid steps that are too granular (single function).

Save to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\57f78c4b-b07a-4406-be82-b2c0560e6b9a/plan.md`. If the feature is trivial and doesn't warrant this breakdown, keep the Implementation step below as is.

**Stop here.** Present the specification (and plan, if created) to the user and wait for their confirmation before proceeding.

---

### [x] Step 1: Replace `simpleHash` with SHA-256 and fix `normalizeSegment`

**Files**: `db.js`, `hash.js`, `segmentation.js`

1. In `db.js`, replace `simpleHash` with a SHA-256 based function using Node.js built-in `crypto`. Return the first 16 hex characters (64 bits) for a compact but collision-resistant key.
2. Update `makeBackendKey` to use the new hash function.
3. In `hash.js`, update `simpleHash` to match (or remove if unused elsewhere).
4. In `segmentation.js`, add `.trim()` as the final step of `normalizeSegment` to eliminate trailing-space inconsistencies.

**Verification**: Run a script that hashes the sample texts ("submit a helpdesk ticket", "powered by", "skip", "contact", "loading", "email address") and confirms all produce unique keys. Verify `normalizeSegment("Email Address *")` === `normalizeSegment("Email Address")`.

---

### [x] Step 2: Add `original_text` verification on cache lookup

**Files**: `db.js`, `index.js`

1. In `findTranslationsByKeys` (`db.js`), add `original_text` to the SELECT columns returned.
2. In the `/translate` endpoint (`index.js`), change `existingMap` construction: store `{ translated_text, original_text }` per key. When checking for a cache hit, compare the stored `original_text` against the current `normalizedTexts[index]`. On mismatch, treat as cache miss (do not use the cached translation).

**Verification**: Confirm that a deliberately mismatched `original_text` would not be served as a cache hit.

---

### [x] Step 3: Change `ON CONFLICT DO NOTHING` → `ON CONFLICT DO UPDATE` and purge cache

**Files**: `db.js`

1. In `insertTranslations`, change the conflict resolution to `ON CONFLICT (key, domain) DO UPDATE SET translated_text = EXCLUDED.translated_text, original_text = EXCLUDED.original_text`.
2. In `initDatabase`, add a one-time migration: detect whether old-format keys exist (short hex-only keys ≤8 chars after the domain prefix) and if so, `TRUNCATE translations` to purge all bad cache data. Log the purge.

**Verification**: Start the server and confirm the cache purge runs. Confirm that a re-translated text correctly overwrites an existing cache entry.

---

### [x] Step 4: End-to-end verification

1. Start the server, confirm `initDatabase` completes without errors and cache purge runs.
2. Confirm `/health` responds 200.
3. (If possible) Make a test `/translate` request, confirm Azure translation is returned and cached.
4. Make the same request again, confirm cache hit returns the correct translation.
5. Confirm no changes are needed to the Chrome extension frontend.
