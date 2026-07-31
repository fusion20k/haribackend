# Implementation Report: Extension Enabled Tracking

## What Was Implemented

### `db.js`

1. **Migration block** added inside `initDatabase()` after the `xp_lifetime_earned` migration. Uses the project's idempotent `DO $$ BEGIN IF NOT EXISTS … END $$` pattern to add `extension_enabled BOOLEAN DEFAULT NULL` to the `users` table.

2. **`getUserById`** — added `extension_enabled` to the SELECT column list.

3. **`getUserByEmail`** — added `extension_enabled` to the SELECT column list.

4. **`setUserExtensionStatus(userId, enabled)`** — new exported function that issues an `UPDATE users SET extension_enabled = $1 WHERE id = $2 RETURNING id, extension_enabled` and returns the updated row (or `null` if no row matched).

### `index.js`

1. **Import** — `setUserExtensionStatus` added to the destructured `require("./db")` block.

2. **`POST /extension/status`** route — placed before `GET /me`. Requires `requireAuth`, validates that `enabled` is strictly `typeof === "boolean"` (returns 400 otherwise), calls `setUserExtensionStatus`, returns 404 if no row, 500 on DB error, and `{ extension_enabled: <value> }` on success.

3. **`GET /me`** — `extension_enabled: user.extension_enabled ?? null` added to the `meResponse` object.

## How the Solution Was Tested

No automated test framework is present in the project (`package.json` only has `start` and `dev` scripts). Verification was done via static code review:

- Migration follows the identical `DO $$` pattern used for every prior column addition.
- `setUserExtensionStatus` mirrors the structure of other single-row `UPDATE … RETURNING` helpers in `db.js`.
- Route validation uses `typeof enabled !== "boolean"` which correctly rejects `"true"`, `1`, `null`, and missing keys.
- Auth is enforced via the existing `requireAuth` middleware consistent with all other authenticated routes.
- `extension_enabled` in `/me` uses `?? null` consistent with the `trial_started_at` field pattern.

Runtime verification steps (to be performed manually post-deploy):

1. Start server — confirm no migration errors in logs.
2. `POST /extension/status` with `{ "enabled": true }` (authenticated) → `200 { extension_enabled: true }`.
3. `GET /me` → response includes `extension_enabled: true`.
4. `POST /extension/status` with `{ "enabled": "yes" }` → `400`.
5. `POST /extension/status` with no token → `401`.

## Challenges Encountered

None significant. The codebase has a consistent, easy-to-follow pattern for migrations, DB helper functions, and Express route structure. The only design decision was confirming `NULL` as the default (not `FALSE`) to preserve the "never reported" semantic, which was already specified in the approved spec.

---

## Step 3 Addendum: Heartbeat-based Reliable Detection

### What Was Implemented

#### `db.js`

1. **Migration** — idempotent `DO $$ IF NOT EXISTS $$` block adds `extension_last_seen_at TIMESTAMPTZ` to the `users` table, inserted directly after the `extension_enabled` migration.

2. **`setUserExtensionStatus`** — updated to also set `extension_last_seen_at = NOW()` on every call and return the new column in the `RETURNING` clause.

3. **`getUserById` / `getUserByEmail`** — `extension_last_seen_at` added to both SELECT column lists.

4. **`disableUserExtension(userId)`** — new exported helper that sets `extension_enabled = false` without touching `extension_last_seen_at` (used by the uninstall endpoint).

#### `index.js`

1. **`POST /extension/status`** — now also returns `extension_last_seen_at` in the JSON response alongside `extension_enabled`.

2. **`GET /extension/uninstalled`** — new unauthenticated endpoint. Reads `?token=<jwt>` from the query string, verifies it with `jwt.verify`, and calls `disableUserExtension` if valid. Always responds `200 ok` — any error (missing token, expired token, DB failure) is swallowed and logged so Chrome's uninstall navigation never sees an error page.

3. **`GET /me`** — response now includes:
   - `extension_last_seen_at` — raw timestamp or `null`
   - `extension_effectively_enabled` — computed boolean: `true` only when `extension_enabled === true` AND `extension_last_seen_at` is within the last 2 days.

### How the Solution Was Tested

Static review against existing patterns. Runtime verification steps:

1. Restart server — confirm no migration errors.
2. `POST /extension/status { enabled: true }` → response includes `extension_last_seen_at` timestamp.
3. `GET /me` → `extension_last_seen_at` populated, `extension_effectively_enabled: true`.
4. `GET /extension/uninstalled` (no token) → `200 ok`, no crash.
5. `GET /extension/uninstalled?token=<valid-jwt>` → `200 ok`, user's `extension_enabled` flipped to `false`.
6. `GET /me` after uninstall → `extension_effectively_enabled: false`.

### Challenges

None significant. Edge cases (missing/expired token on uninstall, NULL `extension_last_seen_at` for existing users) were handled as specified in the plan.
