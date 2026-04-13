# Spec and build

## Agent Instructions

Ask the user questions when anything is unclear or needs their input. This includes:

- Ambiguous or incomplete requirements
- Technical decisions that affect architecture or user experience
- Trade-offs that require business context

Do not make assumptions on important decisions — get clarification first.

---

## Workflow Steps

### [x] Step: Technical Specification (completed)

See `spec.md` for the full specification.

---

### [x] Step: Implementation

Break down into the following tasks:

#### Task 1: Fix `handleCancelSubscription` (core bug)

Rewrite the function in `index.js` (lines 856–888) to:
- Return 200 idempotently if user is already on `free` with no subscription
- Resolve `subscriptionIdToCancel` from: `user.subscription_id` → `subscriptions` table → Stripe API fallback (`stripe.subscriptions.list` by customer)
- Wrap Stripe cancel in try/catch; swallow `resource_missing` / already-canceled errors, re-throw others
- Always call `cancelUserSubscription()` to update local DB

#### Task 2: Fix `/billing/create-checkout-session` guard

Add `"payg"` to the existing plan_status guard (line ~601) so PAYG users are blocked from creating a second `pre` subscription without going through `switch-plan`.

#### Task 3: Fix `/billing/create-payg-checkout-session` guard

Update the guard (line ~755) to also block users already on `pre` or `active` plan_status.

#### Task 4: Verify all fixes manually

Test the 6 scenarios listed in `spec.md` verification section. Confirm no regressions on working transitions (free→pre, pre→payg, payg→pre via switch-plan).

#### Task 5: Write report

Write `report.md` describing what was implemented, how it was tested, and any challenges.
