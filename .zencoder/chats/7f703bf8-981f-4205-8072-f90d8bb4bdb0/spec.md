# Technical Specification: Extension Enabled Tracking

## Complexity Assessment

**Medium** — straightforward column addition with idempotent migration, but requires careful edge-case handling (NULL vs FALSE semantics, query updates across multiple functions, and a new authenticated endpoint).

---

## Technical Context

- **Runtime**: Node.js (no build step)
- **Framework**: Express
- **Database**: PostgreSQL via Supabase, accessed through `pg` Pool
- **Auth**: JWT (`jsonwebtoken`) via `requireAuth` middleware
- **Key files**: `db.js` (data layer), `index.js` (routes)
- **Migration pattern**: Idempotent `DO $$ BEGIN IF NOT EXISTS … END $$` blocks inside `initDatabase()` in `db.js`

---

## Data Model Change

### New column on `users`

```sql
ALTER TABLE users ADD COLUMN extension_enabled BOOLEAN DEFAULT NULL;
```

**NULL semantics** (preferred over `DEFAULT FALSE`):

| Value | Meaning |
|-------|---------|
| `NULL` | Status never reported — user may not have the extension, or the extension has not yet called the status endpoint |
| `TRUE` | Extension explicitly reported as enabled |
| `FALSE` | Extension explicitly reported as disabled / uninstalled |

Using `NULL` as the default correctly distinguishes "unknown" from "explicitly off", which is important for analytics and admin visibility.

---

## Implementation Approach

### 1. `db.js` — Migration block (inside `initDatabase`)

Add an idempotent migration block following the existing pattern:

```js
await client.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'extension_enabled'
    ) THEN
      ALTER TABLE users ADD COLUMN extension_enabled BOOLEAN DEFAULT NULL;
    END IF;
  END $$;
`);
```

### 2. `db.js` — Update SELECT queries

Both `getUserById` and `getUserByEmail` have hardcoded column lists. Add `extension_enabled` to each:

- `getUserById` — line ~559
- `getUserByEmail` — line ~577

### 3. `db.js` — New function `setUserExtensionStatus`

```js
async function setUserExtensionStatus(userId, enabled) {
  if (!process.env.DATABASE_URL) throw new Error("Database not configured");
  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users SET extension_enabled = $1 WHERE id = $2
       RETURNING id, extension_enabled`,
      [enabled, userId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("Error setting extension status:", error);
    throw error;
  } finally {
    client.release();
  }
}
```

Export it in the `module.exports` block at the bottom of `db.js`.

### 4. `index.js` — Import `setUserExtensionStatus`

Add to the destructured import from `./db`.

### 5. `index.js` — New endpoint `POST /extension/status`

```
POST /extension/status
Authorization: Bearer <token>
Body: { "enabled": true | false }
```

**Behavior**:
- Requires authentication (`requireAuth`)
- Validates that `enabled` is strictly a boolean
- Calls `setUserExtensionStatus(userId, enabled)`
- Returns `{ extension_enabled: <value> }`

**Error cases**:
- Missing/invalid token → 401 (handled by `requireAuth`)
- `enabled` missing or not a boolean → 400 `{ error: "enabled must be a boolean" }`
- User not found (deleted between auth and update) → 404
- DB error → 500

### 6. `index.js` — Expose field in `GET /me` response

Add `extension_enabled: user.extension_enabled ?? null` to the `meResponse` object inside the `/me` handler.

---

## Files Modified

| File | Change |
|------|--------|
| `db.js` | Migration block in `initDatabase`, update SELECT in `getUserById` + `getUserByEmail`, add + export `setUserExtensionStatus` |
| `index.js` | Import `setUserExtensionStatus`, add `POST /extension/status` route, expose `extension_enabled` in `/me` response |

No new files created.

---

## Edge Cases Covered

| Scenario | Handling |
|----------|----------|
| Existing users at migration time | Column defaults to `NULL` — no data loss, no forced state |
| Extension never calls the endpoint | `extension_enabled` stays `NULL`; `/me` returns `null` |
| Extension disabled/uninstalled | Client sends `{ enabled: false }`; column set to `FALSE` |
| Re-enabled extension | Client sends `{ enabled: true }`; column set to `TRUE` — last write wins |
| Concurrent updates (multiple browsers) | Last-write-wins via simple `UPDATE`; acceptable for a boolean flag |
| Non-boolean body value (e.g. `"true"`, `1`, `null`) | 400 validation error — strict `typeof enabled !== "boolean"` check |
| `enabled` key missing from body | 400 validation error |
| Unauthenticated request | 401 via `requireAuth` middleware |
| User deleted between auth and update | 404 returned if `UPDATE` affects 0 rows |

---

## Verification

No test framework is configured (scripts only contain `start` and `dev`). Verification steps:

1. **Start server** — `npm start` — confirm `initDatabase` logs no errors and "Database initialized successfully" appears.
2. **Confirm column exists** — Check Supabase dashboard or run `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'extension_enabled';`
3. **Test happy path** — Authenticate as a test user, then:
   - `POST /extension/status` with `{ "enabled": true }` → expect `200 { extension_enabled: true }`
   - `GET /me` → expect `extension_enabled: true` in response
   - `POST /extension/status` with `{ "enabled": false }` → expect `200 { extension_enabled: false }`
4. **Test validation** — `POST /extension/status` with `{ "enabled": "yes" }` → expect `400`; with no body → expect `400`
5. **Test unauthenticated** — `POST /extension/status` with no token → expect `401`
6. **Existing users** — Verify that existing rows in `users` show `extension_enabled = NULL` after migration
