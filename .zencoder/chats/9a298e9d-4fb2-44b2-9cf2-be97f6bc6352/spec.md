# Technical Specification: GET /admin/payments

## Difficulty Assessment

**Medium** — Involves Stripe API pagination (cursor-based, not offset-based), multi-dimensional in-memory filtering/sorting, KPI aggregation across full datasets, and optional caching. No new DB schema changes. Follows established patterns in the codebase.

---

## Technical Context

- **Language/Runtime**: Node.js (CommonJS), Express 4
- **Auth**: `requireAdmin` middleware (JWT with `isAdmin: true` claim, same as `/admin/overview`, `/admin/users`, `/admin/activity`)
- **Stripe SDK**: `stripe` v20 — already initialized as `stripe` in `index.js` (guarded by `process.env.STRIPE_SECRET_KEY`)
- **DB**: Not needed for this endpoint — all data comes from Stripe API
- **No new dependencies** required

---

## Implementation Approach

### Stripe Data Source

Use `stripe.paymentIntents.list()` (preferred over `charges.list` for modern Stripe) with:
- `expand: ['data.customer', 'data.invoice', 'data.invoice.subscription']`
- `limit: 100` per page (Stripe max)
- `created` filter (unix timestamps) for the date `range` param (server-side pre-filter, reduces API calls)

**Pagination strategy**: Stripe uses cursor-based pagination (`starting_after`). Since the client sends `page`/`pageSize` (offset-based), we must fetch all matching records from Stripe, apply in-memory filters (status, search, sort), then slice for the requested page.

For the `all` range, paginate through all Stripe payment intents using `auto_paging` (`for await ... of stripe.paymentIntents.list(...).autoPagingEach()`).

For bounded ranges (today/7d/30d/90d), use `created: { gte: <unix> }` to pre-filter at the Stripe API level, then paginate with `autoPagingEach`.

### Caching (~30s)

Use a simple module-level in-memory cache keyed by query params string. Cache entries expire after 30 seconds. Separate cache per unique query parameter combination. Since KPIs must reflect the full dataset (per spec), cache the full unfiltered Stripe fetch separately (key: range only) and re-apply filters on each request over the cached raw data.

### KPIs

KPIs are computed from the **full dataset** (all payment intents regardless of status/search/sort filters). Specifically:
- `total_revenue`: sum of `amount_received` for all succeeded PIs (all time)
- `revenue_this_month`: sum of succeeded PIs in current calendar month
- `revenue_today`: sum of succeeded PIs created today (UTC)
- `payment_count`: total count of all PIs (all time)
- `avg_payment`: `total_revenue / succeeded_count` (or 0)
- `active_subscriptions`: count of unique, non-null `subscription` IDs on succeeded PIs (approximation; or use `stripe.subscriptions.list({ status: 'active', limit: 1 })` and read `totalCount` — simpler)
- `mrr`: use `stripe.subscriptions.list({ status: 'active', limit: 100 }).autoPagingEach()` and sum `plan.amount` for each subscription item

For `active_subscriptions` and `mrr`, make a separate Stripe call (not filtered by range).

### Response Shape

Per spec — all amounts in cents, missing fields `null` (not omitted):

```json
{
  "payments": [{
    "id": "pi_xxx",
    "created": 1720000000,
    "amount": 999,
    "currency": "usd",
    "status": "succeeded",
    "refunded": false,
    "amount_refunded": 0,
    "customer": { "id": "cus_xxx", "email": "user@example.com", "name": null },
    "plan": { "id": "price_xxx", "nickname": "Pro", "type": "recurring" },
    "payment_method": { "brand": "visa", "last4": "4242" },
    "receipt_url": "https://...",
    "invoice_url": null,
    "description": null
  }],
  "totals": {
    "count": 42,
    "page": 1,
    "pageSize": 25,
    "totalPages": 2,
    "sum_by_currency": { "usd": 41958 },
    "succeeded_count": 38,
    "refunded_count": 2,
    "failed_count": 2
  },
  "kpis": {
    "total_revenue": 99900,
    "revenue_this_month": 9900,
    "revenue_today": 999,
    "payment_count": 42,
    "avg_payment": 2629,
    "active_subscriptions": 10,
    "mrr": 9990
  }
}
```

### Query Parameter Handling

| Param | Default | Validation |
|-------|---------|------------|
| `range` | `30d` | `today\|7d\|30d\|90d\|all`; invalid → default |
| `status` | `all` | `all\|succeeded\|pending\|refunded\|failed`; invalid → `all` |
| `search` | `""` | Substring match on customer email or Stripe customer ID (case-insensitive) |
| `sort` | `date_desc` | `date_desc\|date_asc\|amount_desc\|amount_asc`; invalid → default |
| `page` | `1` | Integer ≥ 1 |
| `pageSize` | `25` | Integer 1–100 |

**Status mapping** — Stripe `paymentIntent.status` values:
- `succeeded` → filter `status === 'succeeded'`
- `pending` → filter `status === 'processing'` (Stripe uses `processing`)
- `failed` → filter `status === 'canceled'` or `status === 'requires_payment_method'`
- `refunded` → filter `amount_refunded > 0` (regardless of PI status)
- `all` → no filter

**Plan extraction**: from `paymentIntent.invoice?.subscription_details` or `paymentIntent.invoice?.lines?.data?.[0]?.price` (expanded invoice). Fallback: `paymentIntent.metadata.plan` or `null`.

**Payment method**: from `paymentIntent.payment_method_details?.card` on the latest charge (via `paymentIntent.latest_charge` if expanded), or from `paymentIntent.charges.data[0].payment_method_details.card`.

---

## Source Code Structure Changes

**Only `index.js` is modified.** A new route is added after the existing `/admin/activity` endpoint (~line 588):

```
app.get("/admin/payments", requireAdmin, async (req, res) => { ... });
```

Helper logic internal to the handler:
- `getRangeTimestamp(range)` → returns unix timestamp for start of range (or `null` for `all`)
- `applyFilters(payments, { status, search })` → filters in-memory
- `applySort(payments, sort)` → sorts in-memory
- `extractPaymentShape(pi)` → maps Stripe PI object → response shape
- Simple cache object: `const paymentsCache = {}` at module scope

No new files, no new DB functions.

---

## Data Model / API / Interface Changes

- **No DB schema changes**
- **New endpoint**: `GET /admin/payments` (documented above)
- **No changes** to existing endpoints or middleware

---

## Error Handling

- `401` if JWT missing or invalid (handled by `requireAdmin`)
- `403` if JWT lacks `isAdmin` (handled by `requireAdmin`)
- `503` if `stripe` is null (Stripe not configured)
- `500` with `{ error: message }` on unexpected errors; log with `console.error`

---

## Verification Approach

1. **Manual test** with curl or Postman:
   - Valid admin JWT → 200 with correct shape
   - No token → 401
   - Non-admin JWT → 403
   - Each `range` value → correct `created` cutoff reflected in results
   - `search=someEmail` → only matching customer rows returned
   - `status=succeeded` → only succeeded PIs
   - `sort=amount_asc` → ascending amount order
   - `page=2&pageSize=5` → correct slice + `totalPages` calculation
   - `pageSize=200` → clamped to 100
2. **No automated test framework** exists in the project; manual verification is the standard approach
3. **No lint/typecheck command** configured in `package.json`; ensure no syntax errors with `node --check index.js`
