# Database Cleanup Instructions

## Current Status

### ✅ Backend Code: READY
- **Commit:** `841f071` "segment-cache"
- **Deployed:** https://haribackend-mitj.onrender.com
- **API Endpoint:** `/translate` correctly accepts:
  - `segments` field (new format) ✅
  - `domain` field ✅
  - `sentences` field (backward compatible) ✅
- **Cache Key Format:** `${sourceLang}:${targetLang}:${domain}:${hash}` ✅
- **Domain Isolation:** Working correctly ✅

### ✅ Extension Code: UPDATED
- `api-translate.js` → Sends `segments` and `domain` ✅
- `sentence-cache.js` → Space bug fixed ✅
- `content.js` → Progressive loading implemented ✅
- `BATCH_SIZE` → Reduced to 30 ✅

---

## Why Cleanup is Needed

### Old Cache Entries Problem:
Your existing database has **~10,000+ translations** with:
- `domain = "default"` (old format)
- Won't match new cache keys (which use actual domain like "en.wikipedia.org")
- Taking up space without providing cache hits

### Old Analytics Problem:
Your existing `translation_usage` table has **10,000+ records** with:
- All for `domain = "default"`
- Not useful for domain-specific analytics
- Clutters the new analytics data

---

## Cleanup Process

### Step 1: Backup (Optional but Recommended)

1. Go to **Supabase Dashboard**
2. Navigate to **Table Editor**
3. Select `translations` table
4. Click **Export** → **CSV**
5. Repeat for `translation_usage` table
6. Save backups locally (just in case)

### Step 2: Run Cleanup SQL

1. Go to **Supabase SQL Editor**
2. Open the file: `database-cleanup.sql`
3. Copy and paste into SQL Editor
4. Click **Run** (or Ctrl+Enter)

**What this does:**
```sql
DELETE FROM translations;         -- Clears ~10k old cache entries
DELETE FROM translation_usage;    -- Clears ~10k old analytics records
```

**Expected output:**
```
DELETE 10247  -- (or similar number)
DELETE 10189  -- (or similar number)
```

### Step 3: Verify Cleanup

Run this query to confirm tables are empty:
```sql
SELECT COUNT(*) FROM translations;      -- Should return 0
SELECT COUNT(*) FROM translation_usage; -- Should return 0
```

---

## Testing the New System

### Step 1: Load Extension in Chrome

1. Open Chrome
2. Go to `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select: `c:\Users\david\Desktop\Hari`
6. Verify extension loads without errors

### Step 2: Test on Wikipedia

1. Visit: https://en.wikipedia.org/wiki/Philippines
2. Open **DevTools** (F12)
3. Go to **Console** tab
4. Look for logs:
   ```
   Hari: Collected X sentences
   Hari: Translating Y visible sentences immediately
   Hari: ⚡ First visible translated in Zms  ← Should be < 300ms
   ```

5. Go to **Network** tab
6. Find `/translate` request
7. Click it → **Payload** tab
8. Verify request body has:
   ```json
   {
     "sourceLang": "en",
     "targetLang": "tl",
     "segments": ["...", "..."],
     "domain": "en.wikipedia.org"  ← Should show actual domain
   }
   ```

### Step 3: Check Backend Logs (Render)

1. Go to **Render Dashboard**
2. Select your `haribackend` service
3. Click **Logs**
4. Look for:
   ```
   [en.wikipedia.org] Cache: 0 hits, 30 misses (30 total)
   ```
   ↑ Domain should be the actual website, not "default"

### Step 4: Verify Database is Filling Correctly

1. Go back to **Supabase SQL Editor**
2. Run this query:
   ```sql
   SELECT domain, COUNT(*) as count
   FROM translations
   GROUP BY domain;
   ```

**Expected Result:**
```
domain              | count
--------------------|------
en.wikipedia.org    | 150
reddit.com          | 45
github.com          | 32
```

**❌ BAD Result (if you see this, something is wrong):**
```
domain    | count
----------|------
default   | 150
```

If you see `"default"`, the extension is not sending the domain field correctly.

### Step 5: Test Cache Hit Rate (Reload Page)

1. **Reload** the Wikipedia page (F5)
2. Check **Console** logs:
   ```
   Hari: 📊 Translation summary: 120 from cache, 10 need backend
   ```
   ↑ Should show cache hits!

3. Check **Render logs**:
   ```
   [en.wikipedia.org] Cache: 120 hits, 10 misses (130 total)
   ```
   ↑ Cache hit rate should be 90%+ on reload!

4. Check **Network tab**:
   - `/translate` request should be much faster (~100-200ms vs 1500ms)

---

## Verification Checklist

After cleanup and testing, verify:

- [ ] Database tables cleared (both 0 rows)
- [ ] Extension sends `segments` field (Network tab)
- [ ] Extension sends `domain` field with actual hostname (Network tab)
- [ ] Backend logs show `[actual-domain.com]` not `[default]` (Render logs)
- [ ] Database fills with actual domain names (Supabase query)
- [ ] Cache hits work on page reload (Console + Render logs)
- [ ] First visible translated in <300ms (Console log)
- [ ] No missing spaces in translations (Visual check)
- [ ] Progressive loading works on scroll (Console log)

---

## Success Metrics

### Before Cleanup:
```
First paint: 1925ms
Backend calls: 169
Cache hits: 0% (cold cache, all misses)
Domain tracking: None (all "default")
```

### After Cleanup (First Visit):
```
First paint: <300ms ✓
Backend calls: ~30 (visible only) ✓
Cache hits: 0% (expected, fresh cache) ✓
Domain tracking: Working (actual domains) ✓
```

### After Cleanup (Repeat Visit):
```
First paint: <300ms ✓
Backend calls: ~5-10 (only new content) ✓
Cache hits: 80-95% ✓
Domain tracking: Working ✓
```

---

## Troubleshooting

### Problem: Extension still sends "sentences" instead of "segments"

**Check:** `api-translate.js` line 28
```javascript
segments: batch.map((s) => s.originalText),  // Should be "segments"
```

### Problem: Domain shows as "default" in backend logs

**Check:** `api-translate.js` line 29
```javascript
domain: window.location.hostname  // Make sure this line exists
```

### Problem: Cache hits not working

**Possible causes:**
1. Different domain on each request (check browser hostname)
2. Text normalization mismatch (check hash generation)
3. Database connection issues (check Render logs for errors)

### Problem: Spaces still missing

**Check:** `sentence-cache.js` line 80
```javascript
s = { id, originalText, translatedText };  // originalText should NOT be trimmed
```

---

## Next Steps After Verification

Once everything is working:

1. **Monitor for 24 hours**
   - Check cache hit rates improve
   - Verify no errors in Render logs
   - Ensure database size stays reasonable

2. **Run analytics queries** (use `verify-backend.sql`)
   - See which domains get most traffic
   - Identify most-translated segments
   - Calculate cost savings

3. **Update extension in Chrome Web Store** (when ready)
   - Users will automatically get new backend integration
   - Cache will build naturally as they browse

---

## Support

If you encounter issues:
1. Check **Console logs** for extension errors
2. Check **Render logs** for backend errors  
3. Check **Supabase logs** for database errors
4. Run verification queries in `verify-backend.sql`

All systems are ready. Just run the cleanup and test! 🚀
