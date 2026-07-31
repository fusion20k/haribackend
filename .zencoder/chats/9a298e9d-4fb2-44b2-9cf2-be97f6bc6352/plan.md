# Spec and build

## Agent Instructions

Ask the user questions when anything is unclear or needs their input. This includes:

- Ambiguous or incomplete requirements
- Technical decisions that affect architecture or user experience
- Trade-offs that require business context

Do not make assumptions on important decisions — get clarification first.

---

## Workflow Steps

### [x] Step: Technical Specification

Assess the task's difficulty, as underestimating it leads to poor outcomes.

- easy: Straightforward implementation, trivial bug fix or feature
- medium: Moderate complexity, some edge cases or caveats to consider
- hard: Complex logic, many caveats, architectural considerations, or high-risk changes

Create a technical specification for the task that is appropriate for the complexity level:

- Review the existing codebase architecture and identify reusable components.
- Define the implementation approach based on established patterns in the project.
- Identify all source code files that will be created or modified.
- Define any necessary data model, API, or interface changes.
- Describe verification steps using the project's test and lint commands.

Save the output to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\9a298e9d-4fb2-44b2-9cf2-be97f6bc6352/spec.md` with:

- Technical context (language, dependencies)
- Implementation approach
- Source code structure changes
- Data model / API / interface changes
- Verification approach

If the task is complex enough, create a detailed implementation plan based on `c:\Users\david\Desktop\HariBackend\.zencoder\chats\9a298e9d-4fb2-44b2-9cf2-be97f6bc6352/spec.md`:

- Break down the work into concrete tasks (incrementable, testable milestones)
- Each task should reference relevant contracts and include verification steps
- Replace the Implementation step below with the planned tasks

Rule of thumb for step size: each step should represent a coherent unit of work (e.g., implement a component, add an API endpoint, write tests for a module). Avoid steps that are too granular (single function).

Save to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\9a298e9d-4fb2-44b2-9cf2-be97f6bc6352/plan.md`. If the feature is trivial and doesn't warrant this breakdown, keep the Implementation step below as is.

**Stop here.** Present the specification (and plan, if created) to the user and wait for their confirmation before proceeding.

---

### [x] Step: Implement Stripe data fetching + caching

Add module-level `paymentsCache` object and helper `getRangeTimestamp(range)`. Implement the core Stripe fetch loop using `stripe.paymentIntents.list(...).autoPagingEach()` with `expand: ['data.customer', 'data.invoice']` and `created` pre-filter. Cache raw results keyed by range for ~30s.

Verification: `node --check index.js` passes; console.log the PI count for a known range.

---

### [x] Step: Implement response shape mapping + filtering/sorting

Add `extractPaymentShape(pi)` to map a Stripe PaymentIntent → the response object shape (with all missing fields as `null`). Add `applyFilters(payments, { status, search })` and `applySort(payments, sort)` helpers.

Verification: Manually confirm shape matches spec; check `refunded` status filter identifies PIs with `amount_refunded > 0`.

---

### [x] Step: Implement KPI computation

Add KPI block: fetch active subscriptions and MRR via a separate `stripe.subscriptions.list` call. Compute `total_revenue`, `revenue_this_month`, `revenue_today`, `payment_count`, `avg_payment` from full PI dataset (all-time, pre-fetched separately from filtered view).

Verification: KPI values are present and non-negative in response; `active_subscriptions` matches Stripe dashboard count.

---

### [x] Step: Wire up route + query param parsing + pagination

Register `app.get("/admin/payments", requireAdmin, ...)` in `index.js`. Parse and validate all query params (range, status, search, sort, page, pageSize with clamping). Assemble final response with `payments`, `totals`, and `kpis`. Return 503 if `stripe` is null.

Verification: curl with valid admin JWT returns 200 with correct shape; 401/403 for bad/missing tokens; `pageSize=200` is clamped to 100.

---

### [x] Step: Verify, commit and push

Run `node --check index.js`. Perform end-to-end manual checks (all query param combinations). Commit changes and push to https://github.com/fusion20k/haribackend. Write report to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\9a298e9d-4fb2-44b2-9cf2-be97f6bc6352/report.md` describing what was implemented, how it was tested, and any challenges.
