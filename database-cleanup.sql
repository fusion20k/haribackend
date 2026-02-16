-- ============================================
-- Hari Backend Database Cleanup Script
-- ============================================
-- Purpose: Clear old cache entries and analytics data
-- This gives a clean slate for the new segment-based cache system
--
-- Run this in Supabase SQL Editor
-- ============================================

-- STEP 1: Backup current data (optional but recommended)
-- Go to Supabase > Table Editor > Select table > Export as CSV
-- Do this for both 'translations' and 'translation_usage' tables

-- STEP 2: Check current data counts (before cleanup)
SELECT 
  'translations' as table_name,
  COUNT(*) as row_count,
  COUNT(DISTINCT domain) as unique_domains,
  MIN(created_at) as oldest_entry,
  MAX(created_at) as newest_entry
FROM translations;

SELECT 
  'translation_usage' as table_name,
  COUNT(*) as row_count,
  COUNT(DISTINCT domain) as unique_domains,
  COUNT(DISTINCT user_id) as unique_users,
  MIN(created_at) as oldest_entry,
  MAX(created_at) as newest_entry
FROM translation_usage;

-- STEP 3: Clear translation cache
-- This removes all cached translations
-- They will rebuild naturally as users browse with the new system
DELETE FROM translations;

-- STEP 4: Clear analytics data
-- This removes all old usage tracking
-- New analytics will start fresh with proper domain tracking
DELETE FROM translation_usage;

-- STEP 5: Verify cleanup (should show 0 rows)
SELECT COUNT(*) as translations_remaining FROM translations;
SELECT COUNT(*) as usage_records_remaining FROM translation_usage;

-- STEP 6: Reset auto-increment sequences (optional, for clean IDs)
ALTER SEQUENCE translations_id_seq RESTART WITH 1;
ALTER SEQUENCE translation_usage_id_seq RESTART WITH 1;

-- ============================================
-- CLEANUP COMPLETE
-- ============================================
-- Next steps:
-- 1. Test extension on a website
-- 2. Check Supabase translations table - should show proper domain names
-- 3. Monitor cache hit rates in Render logs
-- ============================================
