# Global Cache System Setup

## Overview

The backend now includes a **global caching system** that stores translations in a PostgreSQL database. This dramatically reduces Lara API costs over time because:

- **First time any user** translates a sentence: Lara API is called and result is cached
- **Subsequent requests** from any user: Translation is served from cache (no Lara API call)
- **Result**: Cost approaches zero as the cache fills with common phrases

## Architecture

### Hash Function
Both frontend and backend use the same hash function to generate cache keys:

```javascript
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}
```

**Frontend can use the same function** from `hash.js` for consistent cache keys.

### Cache Key Format
- **Backend**: `${sourceLang}:${targetLang}:${hash(originalText)}`
- **Frontend**: `hari:v1:${sourceLang}:${targetLang}:${hash(originalText)}`

## Database Schema

```sql
CREATE TABLE translations (
  id SERIAL PRIMARY KEY,
  key VARCHAR(255) UNIQUE NOT NULL,
  source_lang VARCHAR(10) NOT NULL,
  target_lang VARCHAR(10) NOT NULL,
  original_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  hit_count INTEGER DEFAULT 0
);

CREATE INDEX idx_translations_key ON translations(key);
```

## Setup on Render

### 1. Create PostgreSQL Database

1. Go to your Render dashboard
2. Click **New +** → **PostgreSQL**
3. Configure:
   - **Name**: `haribackend-db` (or your choice)
   - **Database**: `haridb`
   - **User**: `hariuser`
   - **Region**: Same as your web service
   - **Plan**: Free (or higher for production)
4. Click **Create Database**

### 2. Get Database URL

After creation, Render will show:
- **Internal Database URL**: Use this (faster, within Render network)
- **External Database URL**: For external connections

Copy the **Internal Database URL** - it looks like:
```
postgresql://hariuser:password@dpg-xxxxx/haridb
```

### 3. Add Environment Variable to Web Service

1. Go to your web service (haribackend)
2. Go to **Environment** tab
3. Add new variable:
   - **Key**: `DATABASE_URL`
   - **Value**: (paste the Internal Database URL from step 2)
4. Save changes

### 4. Deploy

Render will automatically redeploy your service with the database connected.

**On first deployment**, the backend will automatically:
1. Create the `translations` table
2. Create the index on `key` column
3. Start caching translations

## Verification

### Check Logs

In Render dashboard → your web service → **Logs**, you should see:

```
Initializing database...
Database initialized successfully
Database ready
Server running on port 10000
```

### Test Caching

First request (cache miss):
```bash
curl -X POST https://haribackend.onrender.com/translate \
  -H "Content-Type: application/json" \
  -d '{"sourceLang": "en", "targetLang": "tl", "sentences": ["Hello"]}'
```

Logs will show:
```
Cache: 0 hits, 1 misses (1 total)
Inserted 1 new translations into cache
```

Second identical request (cache hit):
```bash
curl -X POST https://haribackend.onrender.com/translate \
  -H "Content-Type: application/json" \
  -d '{"sourceLang": "en", "targetLang": "tl", "sentences": ["Hello"]}'
```

Logs will show:
```
Cache: 1 hits, 0 misses (1 total)
```

**No Lara API call on second request!**

## Frontend Integration

The frontend should implement its own local cache using `chrome.storage.local` as described in the original specification. This creates a two-tier caching system:

1. **Frontend local cache**: Instant, per-user, no network request
2. **Backend global cache**: Shared across all users, no Lara API call

### Frontend Hash Implementation

Copy `hash.js` to your frontend and use the same `simpleHash` function:

```javascript
// In your Chrome extension
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

function makeCacheKey(sourceLang, targetLang, originalText) {
  const normalized = originalText.trim();
  const hash = simpleHash(normalized);
  return `hari:v1:${sourceLang}:${targetLang}:${hash}`;
}
```

## Performance Impact

### Without Cache
- Every sentence = 1 Lara API call
- 1000 sentences = 1000 API calls
- Cost: High

### With Cache (After Warmup)
- New sentences only hit Lara API
- Common phrases (greetings, UI text, etc.) served from cache
- 1000 sentences might = 10-50 API calls (if 95-99% cache hit rate)
- Cost: 10-50x cheaper

### Expected Cache Hit Rates

- **Day 1**: ~0% (cold cache)
- **Week 1**: ~30-50% (common phrases cached)
- **Month 1**: ~70-90% (most UI and common text cached)
- **Month 3+**: ~95-99% (mature cache)

## Database Maintenance

### Monitor Cache Size

```sql
SELECT COUNT(*) FROM translations;
SELECT pg_size_pretty(pg_total_relation_size('translations'));
```

### Top Cached Translations

```sql
SELECT original_text, translated_text, hit_count
FROM translations
ORDER BY hit_count DESC
LIMIT 20;
```

### Clean Old Unused Entries

```sql
DELETE FROM translations
WHERE hit_count < 2
  AND created_at < NOW() - INTERVAL '90 days';
```

## Troubleshooting

### Database Connection Fails

Check:
1. `DATABASE_URL` environment variable is set correctly
2. Database is in same region as web service
3. Using Internal Database URL (not External)

### Logs show "running without cache"

This means `DATABASE_URL` is not set. Add it in Render Environment variables.

### Cache not working (same request calls Lara twice)

Check:
1. Hash function is identical on frontend/backend
2. Text is trimmed consistently
3. No leading/trailing whitespace differences

## Cost Savings Example

**Scenario**: 100 active users, each translates 100 phrases/day

**Without cache**: 
- 100 users × 100 phrases × 30 days = 300,000 Lara API calls/month

**With cache (90% hit rate after warmup)**:
- Month 1: ~150,000 calls (50% hit rate average)
- Month 2: ~60,000 calls (80% hit rate)
- Month 3+: ~30,000 calls (90% hit rate)

**Savings**: 90% reduction in API costs
