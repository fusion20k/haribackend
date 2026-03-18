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

**Assessment: Medium**

Spec saved to `spec.md`. Summary:
- Bug 1: `createSubscription` crashes on duplicate key — `updateUserTrialStart` never fires
- Bug 2: No `customer.subscription.created` webhook handler
- Bug 3: No direct session verification fallback endpoint

---

### [x] Step: Implementation

Tasks:

- [x] Fix `db.js` — make `createSubscription` an upsert (ON CONFLICT DO UPDATE)
- [x] Fix webhook `checkout.session.completed` — wrap createSubscription in try-catch, always update user status
- [x] Add webhook `customer.subscription.created` handler — sets trialing or active based on subscription status
- [x] Add `userId` to `subscription_data.metadata` on both checkout session routes so webhook can identify user
- [x] Handle `trialing` status in `customer.subscription.updated` handler
- [x] Add `POST /billing/verify-session` endpoint (auth required, direct Stripe session lookup fallback)
- [x] Committed and pushed to https://github.com/fusion20k/haribackend (commit: 0e4b2db)
