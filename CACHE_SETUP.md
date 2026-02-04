# Global Cache System Setup

## Overview

The backend includes a **global caching system** that stores translations in a PostgreSQL database (Supabase). This dramatically reduces Lara API costs over time because:

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

## Setup with Supabase (Free Forever)

### 1. Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign up/sign in
2. Click **New Project**
3. Fill in details:
   - **Name**: `haribackend` (or your choice)
   - **Database Password**: Create a strong password (save it!)
   - **Region**: Choose closest to your users
   - **Plan**: Free (stays free forever, no expiration)
4. Click **Create new project**
5. Wait ~2 minutes for database to provision

### 2. Get Database Connection String

1. In your Supabase project dashboard, go to **Settings** (gear icon)
2. Go to **Database** section
3. Scroll to **Connection string** → **URI**
4. Copy the connection string, it looks like:
   ```
   postgresql://postgres:[YOUR-PASSWORD]@db.xxx.supabase.co:5432/postgres
   ```
5. Replace `[YOUR-PASSWORD]` with the password you created in step 1

**Example:**
```
postgresql://postgres:myStrongP@ssw0rd@db.abcdefghijk.supabase.co:5432/postgres
```

### 3. Add to Render Environment Variables

1. Go to your Render web service dashboard
2. Go to **Environment** tab
3. Add/update variable:
   - **Key**: `DATABASE_URL`
   - **Value**: (paste the Supabase connection string from step 2)
4. Save changes

Render will automatically redeploy with the new database connection.

### 4. Verify Database Connection

After deployment, check your Render logs. You should see:

```
Initializing database...
Database initialized successfully
Database ready
Server running on port 10000
```

The backend automatically creates the `translations` table and index on first startup.

## Supabase Dashboard Features

### View Cached Translations

1. In Supabase dashboard → **Table Editor**
2. You'll see the `translations` table
3. Click it to browse cached translations

### Run SQL Queries

In Supabase → **SQL Editor**, you can run queries:

**Count total cached translations:**
```sql
SELECT COUNT(*) FROM translations;
```

**Most frequently used translations:**
```sql
SELECT original_text, translated_text, hit_count
FROM translations
ORDER BY hit_count DESC
LIMIT 20;
```

**Recent translations:**
```sql
SELECT original_text, translated_text, created_at
FROM translations
ORDER BY created_at DESC
LIMIT 20;
```

**Cache by language pair:**
```sql
SELECT source_lang, target_lang, COUNT(*) as count
FROM translations
GROUP BY source_lang, target_lang;
```

## Verification

### Test Caching

**First request (cache miss):**
```bash
curl -X POST https://haribackend.onrender.com/translate \
  -H "Content-Type: application/json" \
  -d '{"sourceLang": "en", "targetLang": "tl", "sentences": ["Hello"]}'
```

Check Render logs:
```
Cache: 0 hits, 1 misses (1 total)
Inserted 1 new translations into cache
```

**Second identical request (cache hit):**
```bash
curl -X POST https://haribackend.onrender.com/translate \
  -H "Content-Type: application/json" \
  -d '{"sourceLang": "en", "targetLang": "tl", "sentences": ["Hello"]}'
```

Check Render logs:
```
Cache: 1 hits, 0 misses (1 total)
```

**No Lara API call on second request!**

Then check Supabase Table Editor → you'll see the cached entry.

## Frontend Integration

Copy the hash function from `hash.js` to your Chrome extension:

```javascript
// Same hash function on frontend ensures cache key consistency
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

**Two-tier caching:**
1. **Frontend `chrome.storage.local`** → Instant (no network request)
2. **Backend Supabase PostgreSQL** → Fast (no Lara API call)

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
SELECT 
  COUNT(*) as total_entries,
  SUM(hit_count) as total_hits,
  AVG(hit_count) as avg_hits_per_entry
FROM translations;
```

### Storage Usage

Supabase free tier includes:
- **500 MB database storage** (plenty for millions of translations)
- **Unlimited API requests**
- **No time limit** (free forever)

### Clean Old Unused Entries

Run periodically to keep database lean:

```sql
DELETE FROM translations
WHERE hit_count < 2
  AND created_at < NOW() - INTERVAL '90 days';
```

## Troubleshooting

### Connection Error: "password authentication failed"

Double-check:
1. Password in connection string is correct
2. No special characters are URL-encoded (e.g., `@` becomes `%40`)

### Error: "SSL required"

The code already enables SSL automatically. If you see this error, verify `DATABASE_URL` is set correctly in Render environment variables.

### Logs show "running without cache"

This means `DATABASE_URL` environment variable is not set in Render. Add it in **Environment** tab.

### Database initialization fails

Check Supabase dashboard → **Database** → **Connection pooling** is enabled. The backend uses connection pooling by default.

## Why Supabase?

**vs Render PostgreSQL:**
- ✅ **Free forever** (Render free DB expires in 90 days)
- ✅ **500 MB storage** (Render free: 1 GB, but temporary)
- ✅ **Web dashboard** with SQL editor and table browser
- ✅ **Automatic backups** (Render free: no backups)
- ✅ **Better performance** (dedicated DB, not shared)

**Supabase Free Tier Limits:**
- 500 MB database storage
- 2 GB bandwidth/month (plenty for cache queries)
- No time limit
- Up to 500 MB database size

Perfect for Hari's caching needs!

## Cost Savings Example

**Scenario**: 100 active users, each translates 100 phrases/day

**Without cache**: 
- 100 users × 100 phrases × 30 days = 300,000 Lara API calls/month

**With cache (90% hit rate after warmup)**:
- Month 1: ~150,000 calls (50% hit rate average)
- Month 2: ~60,000 calls (80% hit rate)
- Month 3+: ~30,000 calls (90% hit rate)

**Savings**: 90% reduction in API costs + $0 database cost (Supabase free tier)
