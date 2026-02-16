-- ============================================
-- Backend Verification Queries
-- ============================================
-- Run these AFTER cleanup to verify system is working
-- ============================================

-- 1. Check if new translations are being saved with proper domains
-- (Run AFTER testing the extension on a few websites)
SELECT 
  domain,
  source_lang,
  target_lang,
  COUNT(*) as translation_count,
  MAX(created_at) as last_cached
FROM translations
GROUP BY domain, source_lang, target_lang
ORDER BY translation_count DESC
LIMIT 20;

-- 2. Check cache hit rates by domain
SELECT 
  domain,
  COUNT(*) as total_requests,
  SUM(CASE WHEN was_cache_hit THEN 1 ELSE 0 END) as cache_hits,
  ROUND(100.0 * SUM(CASE WHEN was_cache_hit THEN 1 ELSE 0 END) / COUNT(*), 2) as hit_rate_percent
FROM translation_usage
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY domain
ORDER BY total_requests DESC;

-- 3. Most frequently translated segments (overall)
SELECT 
  original_text,
  translated_text,
  domain,
  hit_count,
  created_at
FROM translations
ORDER BY hit_count DESC
LIMIT 20;

-- 4. Recent translation activity
SELECT 
  user_id,
  domain,
  COUNT(*) as segments_translated,
  SUM(character_count) as total_characters,
  SUM(CASE WHEN was_cache_hit THEN 1 ELSE 0 END) as cache_hits
FROM translation_usage
WHERE created_at > NOW() - INTERVAL '10 minutes'
GROUP BY user_id, domain
ORDER BY segments_translated DESC;

-- 5. Verify domain column exists and has proper values
SELECT 
  COLUMN_NAME, 
  DATA_TYPE, 
  COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_NAME = 'translations' 
  AND COLUMN_NAME IN ('domain', 'key', 'source_lang', 'target_lang');

-- 6. Check for any 'default' domain entries (should only appear if old API used)
SELECT COUNT(*) as default_domain_count
FROM translations
WHERE domain = 'default';

-- Expected: 0 if extension is using new API format correctly
