---
description: Repository Information Overview
alwaysApply: true
---

# HariBackend Information

## Summary
Translation backend service for Hari Chrome extension. Provides a REST API for translating text using Lara AI with a global PostgreSQL-based caching system that reduces API costs by 90%+ over time. The cache stores translations so subsequent requests from any user are served instantly without calling the external translation API.

## Structure
**Root Directory**:
- `index.js` - Main Express server with `/translate` endpoint
- `db.js` - PostgreSQL connection and cache management functions
- `hash.js` - Hash function for consistent cache key generation
- `CACHE_SETUP.md` - Detailed documentation for setting up the Supabase PostgreSQL cache
- `DEPLOYMENT.md` - Complete deployment guide for Render hosting
- `.env.example` - Environment variable template

## Language & Runtime
**Language**: JavaScript (Node.js)  
**Runtime Version**: Not specified (uses latest Node.js on Render)  
**Package Manager**: npm  
**Lock File**: package-lock.json

## Dependencies
**Main Dependencies**:
- `express` (v4.18.2) - Web framework for REST API
- `@translated/lara` (v1.7.4) - Lara AI translation service client
- `pg` (v8.18.0) - PostgreSQL client for caching system
- `axios` (v1.13.4) - HTTP client
- `cors` (v2.8.5) - CORS middleware for Chrome extension integration
- `dotenv` (v17.2.3) - Environment variable management

**Development Dependencies**: None specified

## Build & Installation
```bash
npm install
npm start
```

**Development Mode**:
```bash
npm run dev
```

**Note**: Both `start` and `dev` scripts run `node index.js`

## Environment Configuration
**Required Variables** (`.env` file):
- `PORT` - Server port (default: 10000)
- `LARA_ACCESS_KEY_ID` - Lara AI API access key ID
- `LARA_ACCESS_KEY_SECRET` - Lara AI API secret key
- `DATABASE_URL` - PostgreSQL connection string (optional, enables caching)
- `NODE_ENV` - Environment mode (production/development)

**Database**: The service works without `DATABASE_URL` but will call the Lara API for every request. With PostgreSQL configured, translations are cached globally.

## API Endpoints
**POST /translate**
- **Request**: `{ sourceLang: string, targetLang: string, sentences: string[] }`
- **Response**: `{ translations: string[] }`
- **Limits**: Max 8000 characters total per request
- **Features**: Automatic caching, batch translation support

## Database Schema
**Table**: `translations`
- `id` - Serial primary key
- `key` - Unique cache key (format: `sourceLang:targetLang:hash`)
- `source_lang` - Source language code
- `target_lang` - Target language code
- `original_text` - Original text
- `translated_text` - Cached translation
- `created_at` - Timestamp
- `hit_count` - Cache hit counter (incremented on each reuse)

**Index**: `idx_translations_key` on `key` column for fast lookups

## Deployment
**Platform**: Render (Free tier)  
**Database**: Supabase PostgreSQL (Free tier, 500 MB storage)

**Cache Performance**:
- Day 1: ~0% cache hit rate (cold cache)
- Week 1: ~30-50% (common phrases cached)
- Month 1: ~70-90% (most UI text cached)
- Month 3+: ~95-99% (mature cache, 90% cost reduction)

**Production Considerations**:
- CORS currently allows all origins (`*`) - should be restricted to specific Chrome extension ID in production
- No rate limiting implemented (consider adding `express-rate-limit`)
- SSL enabled automatically for Supabase connections

## Main Application Flow
1. Express server starts on specified PORT
2. Database initializes (creates `translations` table if needed)
3. `/translate` endpoint receives batch translation requests
4. For each sentence, generates cache key using hash function
5. Checks PostgreSQL cache for existing translations
6. Only calls Lara API for cache misses
7. Stores new translations in cache with `hit_count` tracking
8. Returns combined results (cached + newly translated)

## Key Features
- **Global Caching**: Shared cache across all users reduces costs exponentially
- **Batch Translation**: Processes multiple sentences in single request
- **Cache Analytics**: `hit_count` tracking shows most frequently used phrases
- **Fault Tolerance**: Works without database (degrades to no caching)
- **CORS Support**: Configured for Chrome extension integration
- **Hash Consistency**: Same hash function used in frontend and backend for cache key consistency
