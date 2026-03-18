# Cache Optimization - Implementation Plan

## Agent Instructions

Ask the user questions when anything is unclear or needs their input.

---

## Workflow Steps

### [x] Step: Technical Specification

Spec saved to `spec.md`. Difficulty: **medium**.

---

### [x] Step: Implementation (Phase 1 - Cache Optimization)

All tasks completed. Pushed to GitHub.

---

### [x] Step: Implementation (Phase 2 - System-Level Metrics)

All tasks completed. Pushed to GitHub.

---

### [x] Step: Implementation (Phase 3 - GET /usage endpoint)

#### [x] Task A: Add `getMonthlyUsage()` to `analytics.js`
- SUM of `character_count` WHERE `was_cache_hit = false` AND `created_at >= date_trunc('month', NOW())`
- `total` from `process.env.LARA_MONTHLY_CHAR_LIMIT` (default 10,000,000)
- Returns `{ used, total, percentage }`

#### [x] Task B: Add `GET /usage` endpoint to `index.js`
- Public (no auth) — aggregate server data, safe to expose
- Returns `{ used, total, percentage }`
- Fix: removed `requireAuth` (frontend calls on new-tab load before auth is set up)

#### [x] Task C: Commit and push to GitHub
