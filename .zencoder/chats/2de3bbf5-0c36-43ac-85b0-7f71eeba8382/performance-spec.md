# Hari Performance Overhaul - Technical Specification

## Task Complexity Assessment
**Level: Hard**

**Reasoning:**
- Multi-repository changes (backend + Chrome extension)
- Performance optimization across network, caching, and rendering layers
- Progressive rendering with IntersectionObserver requires careful state management
- Text normalization bug fixes that could break existing cache
- Must maintain backward compatibility
- High-risk changes affecting user experience directly

---

## Technical Context

**Chrome Extension:**
- Language: JavaScript (ES6+)
- Framework: Vanilla JS with Chrome Extension APIs
- Storage: chrome.storage.local (IndexedDB-backed)
- Key files: content.js, api-translate.js, sentence-cache.js, dom-sentences.js

**Backend:**
- Already updated with segment-level cache (completed in previous phase)
- Endpoint: `/translate` accepts `segments` + `domain` parameters
- Deployed: https://haribackend-mitj.onrender.com

---

## Current Performance Issues

### Issue 1: Slow Backend Response (1.8s for 169 sentences)
**Root Cause:** No backend caching yet active - every request hits Lara API
**Impact:** Users wait 1-2 seconds for initial translation
**Current Flow:**
```
Extension → Backend → Lara API (1.5s) → Backend → Extension
```

### Issue 2: Missing Spaces in Translations
**Root Cause:** Text normalization strips whitespace before sending to API
**Impact:** "Hello World" becomes "HelloWorld" in translation
**Location:** sentence-cache.js line 77 - `originalText.trim()` without preserving spaces

### Issue 3: Translate All 484 Sentences Upfront
**Root Cause:** content.js calls `translateAllMissing()` on entire page immediately
**Impact:** Long perceived load time even though content above fold is ready
**User sees:** Blank page while waiting for all 484 sentences

---

## Solution Architecture

### Phase 1: Backend Cache Integration (Immediate 50-70% improvement)
**Update API Call Format:**
```javascript
// OLD (api-translate.js line 25-29)
{
  sourceLang: "en",
  targetLang: "tl",
  sentences: ["Hello", "World"]
}

// NEW
{
  sourceLang: "en",
  targetLang: "tl",
  segments: ["Hello", "World"],
  domain: window.location.hostname
}
```

**Expected Result:**
- Backend cache hits: <100ms (was 1500ms)
- First-time translations: Still ~1500ms (Lara API call)
- Second visit to same site: 90%+ cache hits → <200ms total

### Phase 2: Progressive Translation (Perceived latency: 300ms)
**Implement Priority Queue:**
1. **Immediate (0-300ms)**: Translate visible viewport content only (~20-50 sentences)
2. **Scroll-triggered**: Use IntersectionObserver to translate as user scrolls
3. **Background**: Translate remaining off-screen content when idle

**Implementation:**
```javascript
// content.js - new flow
async performInitialTranslation() {
  await sentenceCache.loadFromStorage();
  
  // Step 1: Collect ALL sentences and wrap (fast, no translation)
  const allSentences = collectAndWrapSentences(document.body);
  
  // Step 2: Translate ONLY visible sentences immediately
  const visibleSentences = getVisibleSentences();
  await translateBatch(visibleSentences);
  applyImmersionLevel(this.currentLevel);
  
  // Step 3: Set up progressive loading for rest
  this.setupProgressiveTranslation(allSentences);
}
```

### Phase 3: Fix Space Normalization
**Problem:** Cache key normalization also affects sent text
**Solution:** Separate cache key generation from translation text

```javascript
// sentence-cache.js - KEEP ORIGINAL TEXT
getOrCreate(id, originalText) {
  // Don't trim the original text - preserve spaces!
  const cacheKey = this.makeCacheKey(originalText); // normalized for key
  const cached = this.inMemoryCache.get(cacheKey);
  
  const s = { 
    id, 
    originalText,  // ORIGINAL with spaces
    translatedText: cached?.translatedText 
  };
  this.byId.set(id, s);
  return s;
}

// api-translate.js - send ORIGINAL text
body: JSON.stringify({
  sourceLang: "en",
  targetLang: "tl",
  segments: batch.map((s) => s.originalText), // NOT trimmed
  domain: window.location.hostname
})
```

### Phase 4: Optimize Batch Sizes
**Current:** 100 sentences per batch
**New:** 30 sentences per batch (more parallel, smoother progress)

---

## Implementation Plan

### File Changes

#### 1. **api-translate.js** (Major changes)
- Change `BATCH_SIZE` from 100 → 30
- Update request body to use `segments` instead of `sentences`
- Add `domain: window.location.hostname` to request
- Add `translateBatch()` overload for visible-only translation
- Update error handling for new API format

#### 2. **sentence-cache.js** (Critical bug fix)
- **FIX:** Line 77 - Do NOT trim originalText, keep as-is
- Update `makeCacheKey()` to normalize ONLY for key generation
- Separate normalization from storage
- Add `getCachedByIds(ids)` method for batch lookup

#### 3. **content.js** (Performance overhaul)
- Split `performInitialTranslation()` into progressive phases
- Add `getVisibleSentences()` using IntersectionObserver
- Add `setupProgressiveTranslation()` for scroll-based loading
- Add `translateVisibleBatch()` for immediate viewport translation
- Update timing logs to show "first paint" vs "total completion"

#### 4. **dom-sentences.js** (Minor)
- Add viewport detection helper: `isInViewport(element)`
- Update `collectAndWrapSentences()` to mark visibility state
- Preserve original whitespace when wrapping spans

#### 5. **NEW: progressive-loader.js** (New module)
- Manages IntersectionObserver for scroll-based translation
- Queues untranslated sentences by priority
- Debounces rapid scroll events
- Provides progress callbacks for UI

---

## Data Flow Changes

### OLD Flow (Current):
```
Page Load
  → Collect ALL sentences (484)
  → Translate ALL missing (169 backend calls)
  → Apply immersion
  → Page visible (1925ms)
```

### NEW Flow (Optimized):
```
Page Load
  → Collect ALL sentences (484) - no translation yet
  → Identify visible sentences (~30)
  → Translate visible only (~20 backend, 10 cache)
  → Apply immersion to visible
  → Page visible (300ms) ✓ USER SEES CONTENT
  
Background:
  → IntersectionObserver watches scroll
  → Translate as sections become visible
  → Prefetch likely-next sections
  → Total completion: ~2000ms (same as before, but perceived as instant)
```

---

## Success Metrics

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| First paint with translations | 1925ms | <300ms | Log timestamp from init to first applyImmersionLevel |
| Backend cache hit rate (repeat visit) | 0% | 70-90% | Backend logs cache hits |
| Backend response time (cache hit) | N/A | <100ms | Measure fetch roundtrip time |
| Backend response time (miss) | 1500ms | 1500ms | Unchanged (Lara API) |
| Missing spaces | Common | 0 | Manual QA on test pages |
| Perceived load time | Slow | Instant | User testing |

---

## Testing Strategy

### Phase 1 Tests (Backend Integration)
1. Open DevTools Network tab
2. Load a Wikipedia page
3. Check `/translate` request body contains `segments` and `domain`
4. Reload same page
5. Verify backend logs show cache hits
6. Measure response time < 200ms

### Phase 2 Tests (Progressive Loading)
1. Load long article (e.g., Wikipedia)
2. Check console for "First visible translated in Xms"
3. Should be < 300ms
4. Scroll down slowly
5. Verify new sections translate as they appear
6. No duplicate translations

### Phase 3 Tests (Space Fix)
1. Load page with buttons: "Save Changes", "Log In"
2. Set immersion to 100%
3. Verify translation has spaces: "Mag-save ng Mga Pagbabago"
4. Not: "Mag-savengMgaPagbabago"

### Phase 4 Tests (Batch Size)
1. Load page with 100+ sentences
2. Check Network tab
3. Verify multiple smaller requests (30 each) instead of 1 large (100)
4. Should see smoother progress

---

## Migration & Rollout

### Backward Compatibility
- Backend already supports both `sentences` and `segments`
- Extension can update independently
- Existing cache entries remain valid (different key format is intentional)

### Rollout Phases
1. **Week 1:** Backend integration + space fix (low risk)
2. **Week 2:** Progressive loading (high impact, test carefully)
3. **Week 3:** Polish, monitor analytics

### Rollback Plan
- Keep old `sentences` code path as fallback
- Feature flag: `USE_PROGRESSIVE_LOADING` can be disabled
- If issues, revert to synchronous translation

---

## Edge Cases & Considerations

### 1. Very Fast Scrolling
**Issue:** User scrolls faster than translation can complete
**Solution:** Debounce scroll events (300ms), prioritize viewport center

### 2. Dynamic Content (SPAs)
**Issue:** Content changes after initial load (React, etc.)
**Solution:** MutationObserver already handles this in `processDynamicContent()`

### 3. Offline Mode
**Issue:** No backend available
**Solution:** Fall back to cache-only, show warning banner

### 4. Cache Key Collisions
**Issue:** Different texts with same hash
**Solution:** Already handled by backend's composite key (text + lang + domain)

### 5. Large Tables/Lists
**Issue:** 1000+ rows = 1000+ sentences
**Solution:** Progressive loading handles this automatically

### 6. Extension Storage Limits
**Issue:** Chrome.storage.local has 10MB limit
**Solution:** Implement LRU cache eviction (future enhancement)

---

## Performance Benchmarks

### Test Page: Wikipedia "Philippines" Article
- Total sentences: ~450
- Visible on load: ~30
- Expected improvements:

| Phase | Before | After | Improvement |
|-------|--------|-------|-------------|
| First visible | 1925ms | 250ms | 87% faster |
| Full page (first visit) | 1925ms | 2000ms | Similar (background) |
| Full page (repeat visit) | 1925ms | 300ms | 84% faster |
| Backend calls (repeat) | 169 | ~20 | 88% reduction |

---

## Code Structure

### New Modules
- **progressive-loader.js** - IntersectionObserver-based translation queue

### Modified Modules
- **content.js** - Progressive translation orchestration
- **api-translate.js** - New API format + domain support
- **sentence-cache.js** - Space preservation fix
- **dom-sentences.js** - Viewport detection

### Unchanged Modules
- **immersion-apply.js** - Still applies % immersion
- **utils/** - Hash, DOM path utilities unchanged

---

## Next Steps After Implementation

1. **Analytics Dashboard:** Track cache hit rates, load times per domain
2. **Prefetching:** Predict next scroll destination, prefetch translations
3. **Service Worker:** Cache translations offline
4. **Compression:** gzip request/response bodies
5. **CDN:** Serve backend from edge locations

---

## Questions for User

Before proceeding, clarify:
1. ✅ Should we maintain old `sentences` API as fallback? (Recommended: Yes for 1-2 weeks)
2. ✅ Progressive loading default ON or feature flag? (Recommended: Feature flag first week)
3. ✅ Batch size: 30 is good balance? (Can tune based on testing)
4. ✅ Acceptable to break existing local cache? (New key format will miss old cache)

**Recommendation:** Start with Phase 1 (backend integration) + Phase 3 (space fix) first. Test thoroughly. Then add Phase 2 (progressive loading) as separate release.
