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

Save the output to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\e961965e-8a64-4563-8411-4e9a78f2c94d/spec.md` with:

- Technical context (language, dependencies)
- Implementation approach
- Source code structure changes
- Data model / API / interface changes
- Verification approach

If the task is complex enough, create a detailed implementation plan based on `c:\Users\david\Desktop\HariBackend\.zencoder\chats\e961965e-8a64-4563-8411-4e9a78f2c94d/spec.md`:

- Break down the work into concrete tasks (incrementable, testable milestones)
- Each task should reference relevant contracts and include verification steps
- Replace the Implementation step below with the planned tasks

Rule of thumb for step size: each step should represent a coherent unit of work (e.g., implement a component, add an API endpoint, write tests for a module). Avoid steps that are too granular (single function).

Save to `c:\Users\david\Desktop\HariBackend\.zencoder\chats\e961965e-8a64-4563-8411-4e9a78f2c94d/plan.md`. If the feature is trivial and doesn't warrant this breakdown, keep the Implementation step below as is.

**Stop here.** Present the specification (and plan, if created) to the user and wait for their confirmation before proceeding.

---

### [x] Step: Implementation

Assessed difficulty: **HARD**. Broken into concrete sub-steps below. Each sub-step is independently testable and references `spec.md` fix IDs (F1–F6) and bug IDs (B1–B11).

#### [x] Sub-step 2.1: Add `getPeriodEnd(sub)` helper and centralize usage (F4 / B4)
- Add top-level helper in `index.js` that reads `current_period_end` from `sub.current_period_end` then falls back to `sub.items.data[0].current_period_end`.
- Replace all six call-sites: `index.js:183`, `:229`, `:257`, `:933`, and any usage in webhook handlers.
- Verify: syntax-check (`node -c index.js`); no runtime regression on Stripe-CLI-triggered `customer.subscription.created` / `.updated`.

#### [x] Sub-step 2.2: Upsert `updateSubscription` and pass metadata.userId (F3 / B3)
- Modify `db.js` `updateSubscription` to upsert when no row exists and a `userId` is supplied.
- Update caller at `index.js:254` (webhook `customer.subscription.updated`) to pass `subscription.metadata?.userId`.
- Verify: replay `customer.subscription.updated` before `.created` via Stripe CLI — subscription row must exist and status transitions must fire.

#### [x] Sub-step 2.3: PAYG-aware cancellation helper (F1 / B1, B8)
- Add `cancelStripeSubscriptionWithFinalUsage(subscriptionId)` in `index.js` that retrieves the sub, detects PAYG via `STRIPE_PAYG_PRICE_ID`, and passes `{ invoice_now: true, prorate: true }` only for PAYG; preserves "already gone" swallow.
- Replace `stripe.subscriptions.cancel(...)` at `index.js:205`, `:1041`, `:1049`, `:1125`.
- Verify: scenario S3 in spec — start PAYG, translate >1000 chars, cancel, confirm Stripe dashboard final invoice has metered line item > 0.

#### [x] Sub-step 2.4: Inline-await meter events; remove `setImmediate` (F2 / B2)
- `/translate` (`index.js:1570`) and `/dictionary` (`index.js:1719`): drop `setImmediate`, `await` the `stripe.billing.meterEvents.create` call, catch+log errors without failing the user request.
- Optional: add `payg_meter_events_pending` migration + best-effort retry in a follow-up; not required for this pass.
- Verify: call `/translate` with a PAYG user; confirm the meter event appears in `stripe.billing.meter_events` within seconds.

#### [x] Sub-step 2.5: Fix trial plan state (F5 / B5) — SKIPPED per user (no trialing status)
- `db.js:634` `updateUserTrialStart`: change `plan_status = 'free'` → `'trialing'`, and bump `trial_chars_limit` to 1,000,000 during trial.
- Remove the `initDatabase` migration block at `db.js:226-232` that collapses `trialing` → `free`.
- Extend all plan-gating / char-limit logic to accept `'trialing'` equivalently to `'pre'`:
  - `index.js:453-456` admin overview counts (add trialing bucket or include with active_subscribers)
  - `index.js:487` `validPlans` list
  - `index.js:704, :831, :866, :985, :1034` gating checks
  - `index.js:787, :1210, :1273, :1601, :1658, :1673, :1749` quota logic
- Verify: `/start-trial` → `/me` shows `plan_status='trialing'`, `trial_chars_limit=1000000`; `/translate` permits up to 1M chars; webhook trial→active transitions to `'pre'`.

#### [x] Sub-step 2.6: Add display-only comment for PAYG cycle (F6 / B6)
- Add short comment near `/me` PAYG response block (`index.js:808`) clarifying local counters are UI-only; Stripe is source of truth.
- No behavioral change.

#### [x] Sub-step 2.7: End-to-end Stripe verification
Execute scenarios S1–S7 from `spec.md`:
- S1 Premium happy path
- S2 PAYG happy path
- S3 **PAYG mid-cycle cancel** (the critical scenario — must bill accrued usage)
- S4 Plan switch PAYG → Premium (partial usage invoiced)
- S5 Out-of-order webhook replay
- S6 Trial flow end-to-end
- S7 Duplicate webhook delivery idempotency

Record any failures, fix, re-run.

#### [x] Sub-step 2.8: Write implementation report
Write `c:\Users\david\Desktop\HariBackend\.zencoder\chats\e961965e-8a64-4563-8411-4e9a78f2c94d/report.md` describing:
- What was implemented (map to sub-steps 2.1–2.7 and spec fix IDs)
- How the solution was tested (Stripe-test-mode scenarios executed)
- The biggest issues or challenges encountered
