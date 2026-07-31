# Technical Specification: Update Pro Plan Price ID to $7.49

## Difficulty Assessment
**Easy** — Single environment variable update. No code logic, API contracts, or data models change. No displayed dollar amounts exist in this codebase.

---

## Technical Context

- **Language / Runtime**: Node.js (Express)
- **Key files**: `.env`, `.env.example`, `index.js`
- **Stripe integration**: Price IDs are read exclusively via `process.env.STRIPE_PRICE_ID` in `index.js`; no hardcoded Pro price ID exists in JS source

---

## Findings: Every Reference to the Pro Price ID

| Location | Current Value | Action |
|---|---|---|
| `.env` line 5 | `STRIPE_PRICE_ID=price_1TDG30DKBlUi0cQLleY7XMXQ` | **Update** to new price ID |
| `.env.example` line 7 | `STRIPE_PRICE_ID=price_your_stripe_price_id_here` | Update placeholder comment/example to note the new ID |
| `index.js` (lines 1044, 1194, 1231, 1412) | `process.env.STRIPE_PRICE_ID` | No change needed — already reads from env var |

**No hardcoded dollar amounts** (`$9.99`, `$7.49`, etc.) appear anywhere in the codebase (JS source, SQL, Markdown docs).

**No seed data** contains price IDs.

**`STRIPE_PAYG_PRICE_ID`** is unchanged (`price_1TKW2wDKBlUi0cQL7JtrM4lH`).

---

## Implementation Approach

1. In `.env`, change line 5:
   ```
   STRIPE_PRICE_ID=price_1TXRGPDKBlUi0cQLG3zJlPui
   ```

2. In `.env.example`, update the example value to reflect the new ID pattern (so future devs have a realistic reference):
   ```
   STRIPE_PRICE_ID=price_1TXRGPDKBlUi0cQLG3zJlPui
   ```

3. Commit both changes and push to `https://github.com/fusion20k/haribackend`.

---

## Source Code Changes

| File | Change |
|---|---|
| `.env` | `STRIPE_PRICE_ID` value → `price_1TXRGPDKBlUi0cQLG3zJlPui` |
| `.env.example` | `STRIPE_PRICE_ID` placeholder → `price_1TXRGPDKBlUi0cQLG3zJlPui` |

No JS source files require changes.

---

## Data Model / API / Interface Changes

None. The price ID is only passed to Stripe's API as-is; no database schema or API contract encodes it.

---

## Verification Approach

1. After updating `.env`, restart the server and attempt a Pro plan checkout — verify the Stripe checkout session is created with the new price ID.
2. Confirm `.gitignore` includes `.env` (it does — confirmed) so the secret env file isn't committed.
3. Confirm the git push succeeds to the target repo.

---

## Notes / Clarifications

- `.env` **is** in `.gitignore`, so updating it will **not** push secrets to GitHub — only `.env.example` will be committed.
- The task says to update "env vars, configs, hardcoded references, displayed price strings like `$9.99`, docs that mention Pro pricing, seed data." After full search, **none of those additional categories apply** — there are no displayed price strings or seed data with price references in this repo.
