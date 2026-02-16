# Technical Specification: Segment-Level Translation Cache

## Task Complexity Assessment
**Level: Medium-Hard**

**Reasoning:**
- Requires database schema changes while maintaining backward compatibility
- Introduces new segmentation logic and normalization rules
- Adds async analytics/logging infrastructure
- Moderate architectural changes to existing cache flow
- Must preserve existing auth and subscription system
- Need to handle edge cases in text segmentation

---

## Technical Context

**Language:** JavaScript (Node.js)  
**Runtime:** Node.js (latest stable)  
**Framework:** Express.js v4.18.2  
**Database:** PostgreSQL (via `pg` v8.18.0)  
**Translation Provider:** Lara AI (`@translated/lara` v1.7.4)

**Existing Architecture:**
- Express REST API with `/translate` endpoint
- Sentence-level translation caching (hash-based keys)
- JWT authentication + Stripe subscription middleware
- PostgreSQL cache with `hit_count` tracking
- Current cache key format: `${sourceLang}:${targetLang}:${hash}`

---

## Implementation Approach

### 1. Segmentation Strategy
**Current State:** Extension sends full sentences; backend caches entire sentences.

**New State:** Backend will accept segments (pre-split by extension OR split server-side).

**Approach:**
- Add optional `segments` field to `/translate` request body (replaces or supplements `sentences`)
- Create `segmentation.js` utility module with:
  - `normalizeSegment(text)` - Trim whitespace, collapse multiple spaces, preserve original case
  - `splitIntoSegments(text)` - Split text into UI strings and sentences (regex-based):
    - UI strings: Short phrases ≤50 chars without sentence-ending punctuation
    - Sentences: Text ending with `.`, `!`, `?`, or longer phrases
  - `segmentDOMText(htmlText)` - Extract text nodes and segment them

**Pattern:**
```javascript
// Example segmentation
Input: "Hello world! Click save."
Output: ["Hello world!", "Click save."]

Input: "Settings"
Output: ["Settings"]  // Single UI string
```

### 2. Enhanced Cache Key Generation
**Current:** `${sourceLang}:${targetLang}:${simpleHash(text.trim())}`

**New:** `${sourceLang}:${targetLang}:${domain}:${simpleHash(normalized)}`

**Changes to `db.js`:**
- Update `makeBackendKey(sourceLang, targetLang, text, domain = 'default')`
- Normalize text: `text.trim().replace(/\s+/g, ' ')`
- Include domain parameter for site-specific caching
- Maintain backward compatibility by defaulting domain to 'default'

### 3. Database Schema Updates

**Add new column to `translations` table:**
```sql
ALTER TABLE translations ADD COLUMN IF NOT EXISTS domain VARCHAR(255) DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_translations_domain ON translations(domain);
```

**Create new analytics table for async logging:**
```sql
CREATE TABLE IF NOT EXISTS translation_usage (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  segment_text TEXT NOT NULL,
  source_lang VARCHAR(10) NOT NULL,
  target_lang VARCHAR(10) NOT NULL,
  domain VARCHAR(255) NOT NULL,
  was_cache_hit BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_usage_user_id ON translation_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_domain ON translation_usage(domain);
CREATE INDEX IF NOT EXISTS idx_usage_created_at ON translation_usage(created_at);
```

**Update unique constraint on translations:**
- Change from `UNIQUE(key)` to composite: `UNIQUE(key, domain)` OR update key generation to include domain hash

### 4. API Endpoint Changes

**POST /translate** - Maintain backward compatibility while adding segment support

**Request Body (new schema):**
```json
{
  "sourceLang": "en",
  "targetLang": "es",
  "sentences": ["..."],  // Legacy support (optional)
  "segments": ["Hello world!", "Click save.", "Settings"],  // New field (optional)
  "domain": "example.com"  // Optional, defaults to 'default'
}
```

**Validation Rules:**
- At least one of `sentences` or `segments` must be provided
- If both provided, use `segments` and deprecate `sentences`
- `domain` must be valid hostname or 'default'
- Total character limit remains 8000 chars

**Response (unchanged):**
```json
{
  "translations": ["¡Hola Mundo!", "Haga clic en guardar.", "Configuraciones"]
}
```

### 5. Async Analytics Logging

**Create `analytics.js` module:**
- `logTranslationUsage(userId, segments, cacheHits, domain)` - Fire-and-forget logging
- Uses event queue or simple async DB insert
- No blocking on translation response
- Log each segment usage with cache hit status

**Integration:**
- Call after response is sent (or use event emitter)
- Track cache hit rates per domain
- Enable future glossary building and user analytics

### 6. Core Flow Updates

**New `/translate` flow:**
```
1. Auth & subscription check (unchanged)
2. Parse request: extract segments (or sentences), domain
3. Normalize each segment
4. Generate cache keys with domain
5. Batch lookup in PostgreSQL (SELECT ... WHERE key IN (...) AND domain = ?)
6. Separate cache hits from misses
7. For misses: batch call to Lara API
8. Insert new translations with domain field
9. Merge hits + new translations in original order
10. Send response
11. Async: Log usage to translation_usage table
```

---

## Source Code Structure Changes

### New Files:
1. **`segmentation.js`** - Segmentation and normalization utilities
   - `normalizeSegment(text)` - Normalize whitespace and case handling
   - `splitIntoSegments(text)` - Split text into segments
   - `isUIString(segment)` - Determine if segment is UI string vs sentence

2. **`analytics.js`** - Async logging and analytics
   - `logTranslationUsage(userId, segments, hitStatuses, domain)` - Usage tracking
   - `logError(error, context)` - Error logging
   - Event-based async processing

### Modified Files:
1. **`db.js`**
   - Update `makeBackendKey()` to accept `domain` parameter
   - Update `findTranslationsByKeys()` to filter by domain
   - Update `insertTranslations()` to include domain field
   - Add `logUsageAsync()` function for analytics table
   - Update `initDatabase()` to create new tables/columns

2. **`index.js`**
   - Update `/translate` endpoint to handle segments + domain
   - Add request validation for new fields
   - Integrate segmentation logic
   - Add async analytics call after response
   - Maintain backward compatibility for `sentences` field

3. **`hash.js`** (optional)
   - Add comment documenting normalization requirements
   - Potentially move to segmentation.js

---

## Data Model Changes

### `translations` table (updated):
```sql
CREATE TABLE translations (
  id SERIAL PRIMARY KEY,
  key VARCHAR(255) NOT NULL,
  domain VARCHAR(255) DEFAULT 'default' NOT NULL,
  source_lang VARCHAR(10) NOT NULL,
  target_lang VARCHAR(10) NOT NULL,
  original_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  hit_count INTEGER DEFAULT 0,
  UNIQUE(key, domain)  -- Composite unique constraint
);
```

### `translation_usage` table (new):
```sql
CREATE TABLE translation_usage (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  segment_text TEXT NOT NULL,
  source_lang VARCHAR(10) NOT NULL,
  target_lang VARCHAR(10) NOT NULL,
  domain VARCHAR(255) NOT NULL,
  was_cache_hit BOOLEAN NOT NULL,
  character_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
```

---

## Verification Approach

### Testing Strategy:
1. **Unit Tests** (to be added):
   - Test segmentation logic with various text inputs
   - Test normalization edge cases (multiple spaces, leading/trailing whitespace)
   - Test cache key generation with domain variations

2. **Integration Tests**:
   - Test `/translate` with segments vs sentences
   - Verify cache hit/miss logic with domain isolation
   - Test backward compatibility with legacy requests
   - Verify async logging doesn't block responses

3. **Manual Verification**:
   - Test with real webpage DOM text
   - Verify cache hit rates improve over time
   - Check database for proper domain isolation
   - Monitor response times (should be <100ms for cache hits)

4. **Database Verification**:
   - Run migration script on test database
   - Verify indexes are created
   - Check existing data compatibility
   - Test rollback scenario

### Performance Benchmarks:
- Cache hit response time: <100ms (target: 20-50ms)
- Cache miss response time: <2s for batch of 20 segments
- Database query time: <50ms for batch lookup
- Async logging overhead: <5ms (non-blocking)

### Rollout Plan:
1. Deploy schema changes first (backward compatible)
2. Deploy code with feature flag (default OFF)
3. Test with small user subset
4. Monitor cache hit rates and response times
5. Gradually enable for all users

---

## Edge Cases & Considerations

1. **Empty Segments:** Filter out empty or whitespace-only segments before processing
2. **Duplicate Segments:** Handle same segment appearing multiple times in one request
3. **Very Long Segments:** Reject segments >1000 chars, suggest splitting
4. **Invalid Domain:** Sanitize domain input, default to 'default' if invalid
5. **Mixed Segments/Sentences:** If both provided, prefer segments and log deprecation warning
6. **Character Limit:** Apply 8000 char limit across all segments combined
7. **Hash Collisions:** Rare but possible; rely on composite key (key + domain) uniqueness
8. **Migration:** Existing cache entries have `domain = 'default'`, continue working

---

## Security & Best Practices

1. **Input Validation:**
   - Sanitize domain input (prevent SQL injection via domain field)
   - Validate segment array length and content
   - Enforce character limits per segment and total

2. **Database Security:**
   - Use parameterized queries (already in place)
   - Add domain validation before query construction
   - Limit analytics table growth with retention policy (future)

3. **Performance:**
   - Maintain batch processing for cache lookups
   - Keep async logging non-blocking
   - Monitor database index performance
   - Consider adding domain-specific cache eviction later

4. **Monitoring:**
   - Log cache hit rates per domain
   - Alert on Lara API error rates
   - Track average response times
   - Monitor database connection pool usage

---

## Migration Strategy

### Phase 1: Database Schema Update
```sql
-- Add domain column (backward compatible)
ALTER TABLE translations 
ADD COLUMN IF NOT EXISTS domain VARCHAR(255) DEFAULT 'default' NOT NULL;

-- Create index
CREATE INDEX IF NOT EXISTS idx_translations_domain ON translations(domain);

-- Create analytics table
CREATE TABLE IF NOT EXISTS translation_usage (...);
```

### Phase 2: Code Deployment
- Deploy new code with `segments` support
- Maintain `sentences` backward compatibility
- Default domain to 'default' if not provided

### Phase 3: Extension Update
- Update extension to send segments instead of sentences
- Include domain parameter (window.location.hostname)

### Phase 4: Monitoring & Optimization
- Monitor cache hit rate improvement
- Analyze most common segments per domain
- Consider building domain-specific glossaries

---

## Success Metrics

1. **Cost Reduction:**
   - Week 1: 30-50% reduction in Lara API calls
   - Month 1: 70-90% reduction in Lara API calls
   - Month 3+: 95%+ cache hit rate on mature domains

2. **Performance:**
   - Average response time: <100ms (was: ~1-2s)
   - 95th percentile: <200ms
   - Cache hits: <50ms

3. **User Experience:**
   - Faster translations = better UX
   - Lower latency for repeated content

4. **Analytics:**
   - Track most common segments per domain
   - Identify candidates for glossary building
   - User engagement metrics
