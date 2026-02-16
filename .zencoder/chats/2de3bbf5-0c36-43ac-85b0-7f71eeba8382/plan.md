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

Save the output to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\2de3bbf5-0c36-43ac-85b0-7f71eeba8382/spec.md` with:

- Technical context (language, dependencies)
- Implementation approach
- Source code structure changes
- Data model / API / interface changes
- Verification approach

If the task is complex enough, create a detailed implementation plan based on `c:\Users\david\Desktop\HariBackend\.zencoder\chats\2de3bbf5-0c36-43ac-85b0-7f71eeba8382/spec.md`:

- Break down the work into concrete tasks (incrementable, testable milestones)
- Each task should reference relevant contracts and include verification steps
- Replace the Implementation step below with the planned tasks

Rule of thumb for step size: each step should represent a coherent unit of work (e.g., implement a component, add an API endpoint, write tests for a module). Avoid steps that are too granular (single function).

Save to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\2de3bbf5-0c36-43ac-85b0-7f71eeba8382/plan.md`. If the feature is trivial and doesn't warrant this breakdown, keep the Implementation step below as is.

---

### [x] Step: Implementation

#### [x] Task 1: Create Segmentation Module
- Create `segmentation.js` with normalization and splitting logic
- Implement `normalizeSegment()`, `splitIntoSegments()`, `isUIString()`
- Add unit test cases for edge cases

#### [x] Task 2: Update Database Schema
- Modify `db.js` to add `initDatabase()` migrations
- Add `domain` column to `translations` table
- Create `translation_usage` table for analytics
- Create necessary indexes
- Test migration on local database

#### [x] Task 3: Create Analytics Module
- Create `analytics.js` for async logging
- Implement `logTranslationUsage()` with fire-and-forget pattern
- Add error handling for logging failures

#### [x] Task 4: Update Database Functions
- Modify `makeBackendKey()` to accept domain parameter
- Update `findTranslationsByKeys()` to filter by domain
- Update `insertTranslations()` to include domain field
- Add `logUsageAsync()` for analytics logging

#### [x] Task 5: Update /translate Endpoint
- Add support for `segments` field in request body
- Add `domain` parameter validation
- Maintain backward compatibility with `sentences` field
- Integrate segmentation logic
- Add async analytics logging after response

#### [x] Task 6: Testing & Verification
- Test with sample segment data
- Verify cache hit/miss logic with different domains
- Test backward compatibility with old requests
- Check database for proper domain isolation
- Monitor response times and cache hit rates

#### [x] Task 7: Documentation & Report
- Write completion report to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\2de3bbf5-0c36-43ac-85b0-7f71eeba8382/report.md`
- Document what was implemented
- Describe testing approach
- Note any challenges encountered

---

### [x] Step: Deployment

#### [x] Task 8: Commit and Push to GitHub
- Stage new files (segmentation.js, analytics.js)
- Stage modified files (db.js, index.js)
- Commit changes with descriptive message
- Push to https://github.com/fusion20k/haribackend

---

## Phase 2: Hari Extension Performance Overhaul

### [x] Step: Technical Specification - Performance Optimization

Create comprehensive performance overhaul specification addressing:
- Backend cache integration (use new segment API)
- Progressive translation (visible content first)
- Space normalization bug fix
- Batch size optimization

Specification saved to: `c:\Users\david\Desktop\HariBackend\.zencoder\chats\2de3bbf5-0c36-43ac-85b0-7f71eeba8382/performance-spec.md`

**Complexity:** Hard
- Multi-file changes across extension
- Performance-critical rendering optimizations
- Must maintain backward compatibility
- User-facing impact requires careful testing

---

### [ ] Step: Implementation - Performance Fixes

---

### [ ] Step: Extension Updates (User will implement)

**Backend Status:** ✅ Complete and deployed
- Segment-level cache with domain isolation: LIVE
- Commit: `841f071` "segment-cache"
- GitHub: https://github.com/fusion20k/haribackend
- Endpoint ready: `/translate` accepts `segments` + `domain`

**Extension Changes Needed (provided as instructions above):**

#### [ ] Task 1: Fix Space Normalization Bug (Critical)
**File:** `c:\Users\david\Desktop\Hari\backend\sentence-cache.js`
- Remove `.trim()` from originalText storage (line 77)
- Keep original whitespace intact

#### [ ] Task 2: Update API to Use Segment Cache
**File:** `c:\Users\david\Desktop\Hari\backend\api-translate.js`
- Change `BATCH_SIZE` from 100 → 30 (line 2)
- Change `sentences` → `segments` in request body (line 28)
- Add `domain: window.location.hostname` (line 29)

#### [ ] Task 3: Implement Progressive Translation
**Files:** 
- `c:\Users\david\Desktop\Hari\content.js` - Update `performInitialTranslation()`
- NEW: `c:\Users\david\Desktop\Hari\backend\progressive-loader.js` - Create new module

**Changes:** Translate visible sentences first, then progressively load rest on scroll

#### [ ] Task 4: Add Viewport Detection Helpers
**File:** `c:\Users\david\Desktop\Hari\backend\dom-sentences.js`
- Add `isInViewport(element)` helper function

#### [ ] Task 5: Testing & Performance Validation
**Test Pages:**
- Wikipedia "Philippines" article (long content)
- YouTube (dynamic SPA)
- GitHub (code + text)
- Gmail (UI buttons with spaces)

**Expected Results:**
- First visible translated in <300ms
- Backend cache hits on repeat visits (check Network tab)
- No missing spaces in translations
- Progressive loading on scroll

#### [ ] Task 6: Documentation & Results
- Test and verify performance improvements
- Report results (timings, cache hit rate, any issues)

---

### [ ] Step: Database Cleanup & Final Verification

**Purpose:** Clear old cache entries and start fresh with new segment-based system

**Files Created:**
- `database-cleanup.sql` - SQL script to clear old data
- `verify-backend.sql` - Queries to verify system is working
- `CLEANUP_INSTRUCTIONS.md` - Complete step-by-step guide

**Backend Status:** ✅ **NO CHANGES NEEDED**
- Backend is deployed and working correctly
- Accepts `segments` + `domain` fields ✓
- Cache system working ✓
- All issues are in extension code only

**Actions Required:**

#### [ ] Subtask 1: Backup Current Data (Optional)
- Export `translations` table as CSV from Supabase
- Export `translation_usage` table as CSV from Supabase

#### [ ] Subtask 2: Run Database Cleanup
- Open Supabase SQL Editor
- Run `database-cleanup.sql`
- Verify both tables are empty (0 rows)

#### [ ] Subtask 3: Fix Extension Issues (User will implement)

**Issues Found:**
- ❌ Collecting 20,046 sentences (entire page)
- ❌ "Visible" detection broken: 1,050 sentences (should be ~50)
- ❌ First paint: 7446ms (should be <300ms)
- ❌ Spacing issues in translations

**Extension Fixes Needed:**

**Fix 1: Update `isInViewport()` in content.js (lines 96-104)**
```javascript
// REPLACE THIS:
isInViewport(element) {
  const rect = element.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
}

// WITH THIS:
isInViewport(element) {
  const rect = element.getBoundingClientRect();
  const windowHeight = window.innerHeight || document.documentElement.clientHeight;
  const windowWidth = window.innerWidth || document.documentElement.clientWidth;
  
  const verticalInView = rect.top < windowHeight && rect.bottom > 0;
  const horizontalInView = rect.left < windowWidth && rect.right > 0;
  
  return verticalInView && horizontalInView;
}
```

**Fix 2: Limit visible sentences in content.js (lines 83-94)**
```javascript
// REPLACE THIS:
getVisibleSentences() {
  const allSpans = document.querySelectorAll('[data-hari-id]');
  const visible = [];
  
  allSpans.forEach(span => {
    if (this.isInViewport(span)) {
      visible.push(span);
    }
  });
  
  return visible;
}

// WITH THIS:
getVisibleSentences() {
  const allSpans = document.querySelectorAll('[data-hari-id]');
  const visible = [];
  const MAX_INITIAL = 100;
  
  for (const span of allSpans) {
    if (visible.length >= MAX_INITIAL) break;
    
    if (this.isInViewport(span)) {
      visible.push(span);
    }
  }
  
  console.log(`Hari: Found ${visible.length} truly visible sentences (limited to ${MAX_INITIAL})`);
  return visible;
}
```

**Fix 3: Fix spacing in dom-sentences.js (lines 63-77)**
```javascript
// REPLACE THIS:
parts.forEach((sentenceText, index) => {
  const span = document.createElement("span");
  const id = hashString(
    `${location.href}|${getDomPath(textNode)}|${index}`
  );
  span.setAttribute("data-hari-id", id);
  span.textContent = sentenceText;
  frag.appendChild(span);
  if (index < parts.length - 1) {
    frag.appendChild(document.createTextNode(" "));
  }

  const s = sentenceCache.getOrCreate(id, sentenceText);
  sentences.push(s);
});

// WITH THIS:
parts.forEach((sentenceText, index) => {
  const span = document.createElement("span");
  const id = hashString(
    `${location.href}|${getDomPath(textNode)}|${index}`
  );
  span.setAttribute("data-hari-id", id);
  span.textContent = sentenceText;
  frag.appendChild(span);
  
  if (index < parts.length - 1) {
    const nextSentence = parts[index + 1];
    const searchText = sentenceText + " " + nextSentence;
    if (original.includes(searchText)) {
      frag.appendChild(document.createTextNode(" "));
    }
  }

  const s = sentenceCache.getOrCreate(id, sentenceText);
  sentences.push(s);
});
```

#### [ ] Subtask 4: Test Extension with Fixes
- Reload extension in Chrome
- Visit Wikipedia article
- Check console: "Found X truly visible sentences (limited to 100)"
- Verify first paint: <300ms
- Check spacing looks natural

#### [ ] Subtask 5: Verify Database is Filling Correctly
- Run queries from `verify-backend.sql`
- Confirm domains are actual hostnames (not "default")
- Check cache hit rates are improving

#### [ ] Subtask 6: Performance Validation
- Measure first paint time (target: <300ms)
- Test progressive loading on scroll
- Verify no missing spaces in translations
- Check cache hit rate on repeat visits (target: 70%+)
