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

Save the output to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\6275c69c-aa2d-40c5-aa63-985b383ad125/spec.md` with:

- Technical context (language, dependencies)
- Implementation approach
- Source code structure changes
- Data model / API / interface changes
- Verification approach

If the task is complex enough, create a detailed implementation plan based on `c:\Users\david\Desktop\HariBackend\.zencoder\chats\6275c69c-aa2d-40c5-aa63-985b383ad125/spec.md`:

- Break down the work into concrete tasks (incrementable, testable milestones)
- Each task should reference relevant contracts and include verification steps
- Replace the Implementation step below with the planned tasks

Rule of thumb for step size: each step should represent a coherent unit of work (e.g., implement a component, add an API endpoint, write tests for a module). Avoid steps that are too granular (single function).

Save to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\6275c69c-aa2d-40c5-aa63-985b383ad125/plan.md`. If the feature is trivial and doesn't warrant this breakdown, keep the Implementation step below as is.

**Stop here.** Present the specification (and plan, if created) to the user and wait for their confirmation before proceeding.

---

### [x] Task 1: Add `isMultiWord` helper to `segmentation.js`

Add and export a simple `isMultiWord(cleaned)` function that returns `true` when the cleaned segment string contains a space. This makes the check reusable and testable in isolation.

**Verification**: Manually confirm `isMultiWord("hello world")` returns `true` and `isMultiWord("hello")` returns `false`.

---

### [x] Task 2: Skip cache lookup for multi-word segments in `/translate`

In `index.js`, after building `cleanedData`, classify each index as single-word or multi-word. Modify the cache key array and `findTranslationsByKeys` call so that multi-word indices are excluded from the DB lookup (treat them unconditionally as cache misses going to Azure).

**Verification**: POST `/translate` with `["run", "quickly run away"]`. Confirm only `"run"` triggers a DB lookup (check server logs or add temporary logging).

---

### [x] Task 3: Skip cache insertion for multi-word segments

After Azure returns translations, filter `rowsToInsert` so that only single-word entries (no space in `original_text`) are passed to `insertTranslations`. Multi-word translations are returned to the caller but never written to the DB.

**Verification**: POST `/translate` with `["run", "quickly run away"]` twice. After the first call, query the `translations` table — only `"run"` should appear. The second call should serve `"run"` from cache but re-translate `"quickly run away"` via Azure.

---

### [x] Task 4: Implement translation correction for bad single-word entries

_Depends on user's answer to the open question in `spec.md` about correction mechanism (Option A: Azure Dictionary Lookup, Option B: LLM, Option C: discard-only)._

Implement the chosen correction strategy for single-word segments that fail `isEchoedTranslation` or `isValidTranslation`:
- If correction produces a valid result, store the corrected translation.
- If correction also fails, return the best-effort Azure result to the user without caching.

**Verification**: Identify a word that Azure echoes (e.g., a proper noun or acronym in the source language), confirm no entry is written to the `translations` table for it, and that the user still receives a response.

---

### [x] Task 5: Purge phrase-level cache entries at startup

Added phrase-level purge migration to `db.js` following the existing `preV2KeyCheck` pattern. Deletes all rows where `original_text` contains a space.

---

### [x] Task 6: Manual end-to-end verification and report

Test the full flow:
1. Single words (cache miss → Azure → cached on next call).
2. Inflected forms each get separate cache entries (run / runs / running / ran).
3. Phrases translate correctly but are never cached.
4. Bad single-word translations are not cached.

Write a report to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\6275c69c-aa2d-40c5-aa63-985b383ad125/report.md`.

---

### [x] Task 7: Strengthen `isValidTranslation` with new guards

_Depends on user confirming the `live` → `Mabuhay` approach (open question in `spec.md`)._

In `segmentation.js`, add 5 new fail-fast guards to `isValidTranslation` in this order:
1. Empty/whitespace output → `false`
2. HTML/markup or URL in output → `false`
3. Encoding artifacts (mojibake sequences `â€`, `Ã`, `Â` followed by non-space) → `false`
4. Stray `*` in output that is not in the input → `false` (catches "Email Address *")
5. UI-label pattern: single-word input + 3+ Title-Cased ASCII-only words in output → `false`

No signature or export changes.

**Verification**: Run the test-case table from `spec.md` in a Node REPL. Confirm `isValidTranslation("subscribe", "Email Address *")` returns `false` and `isValidTranslation("morning", "Magandang umaga")` returns `true`.

---

### [x] Task 8: DB migration — purge bad cached entries on startup

In `db.js` `initDatabase`, add a check-then-delete migration block immediately after the existing `phraseCheck` block. Delete all rows where `translated_text` contains `*`, `<`, or `http`.

**Verification**: After deploying, confirm the startup log contains the purge message and `SELECT COUNT(*) FROM translations WHERE translated_text LIKE '%*%'` returns 0.
