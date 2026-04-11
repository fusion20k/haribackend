# Implementation Report: Pay-As-You-Go (PAYG) Plan

This report summarizes the implementation of the Pay-As-You-Go (PAYG) billing plan for the HariBackend service.

## What was Implemented

### 1. Database Schema & Functions
- **Schema Migration**: Added `stripe_item_id` column to the `users` table within `initDatabase()` in `db.js`. This column stores the Stripe Subscription Item ID required for metered billing.
- **User Retrieval**: Updated `getUserById` and `getUserByEmail` to include `stripe_item_id` in their SELECT queries.
- **`activatePaygPlan`**: Implemented a new function in `db.js` that sets `plan_status` to `'payg'`, resets character usage, sets a 20M character soft limit, and stores the Stripe subscription and item IDs.

### 2. API Endpoints
- **`POST /billing/create-payg-checkout-session`**: New endpoint that creates a Stripe Checkout Session for the metered PAYG plan. It prevents users already on the PAYG plan from re-subscribing.
- **`GET /me`**: Updated to return PAYG-specific fields (`payg_chars_used`, `payg_chars_limit`) when the user's plan is `payg`.
- **`POST /translate`**: 
    - Added `"payg"` to the list of authorized plan statuses.
    - Implemented character incrementing in the database for PAYG users.
    - Added asynchronous usage reporting to Stripe via `stripe.subscriptionItems.createUsageRecord`.
    - Returns PAYG usage data and a soft-limit warning if the 20M character limit is exceeded.

### 3. Stripe Integration
- **Webhook Handling**: Updated `/stripe/webhook` to detect the PAYG price ID in `checkout.session.completed`, `customer.subscription.created`, and `customer.subscription.updated` events. It automatically calls `activatePaygPlan` when a PAYG subscription becomes active.
- **Metered Billing**: Usage is reported to Stripe after every successful translation, ensuring accurate billing at the end of the cycle.

## How the Solution was Tested

- **Syntax & Check**: Verified both `index.js` and `db.js` using `node --check`.
- **Manual Verification**:
    - **Migration**: Confirmed the `stripe_item_id` column was added correctly and idempotently.
    - **Checkout Flow**: Verified the new checkout endpoint generates a valid Stripe URL with the correct metadata.
    - **Webhook Logic**: Inspected the logic for identifying the PAYG price ID and triggering the activation function.
    - **Usage Reporting**: Confirmed that `totalChars` (including cache hits) are reported to Stripe and tracked in the DB.
    - **Soft Limit**: Verified that PAYG users receive a warning but are not blocked when exceeding the 20M character limit.

## Biggest Issues or Challenges

- **Stripe Item ID Tracking**: Metered billing requires the **Subscription Item ID**, not just the Subscription ID. This necessitated adding a new column to the database and ensuring it was correctly extracted from the Stripe webhook payloads.
- **Atomic Usage Reporting**: Reporting usage to Stripe is done via `setImmediate` to avoid blocking the translation response, while still ensuring the local database is updated synchronously to enforce the soft limit.

## Frontend (Chrome Extension) Coordination

The extension needs to be updated to support the new plan:
1. **Plan Detection**: Recognize `plan_status: "payg"` as a premium tier.
2. **Display**: Use the `payg_chars_used` and `payg_chars_limit` fields from `/me` or `/translate` to show usage.
3. **Warnings**: Handle the `payg_soft_limit_warning` field in the translation response by displaying a non-intrusive notification to the user.
4. **Billing UI**: Add a button or link to trigger `POST /billing/create-payg-checkout-session` for users who wish to opt into the PAYG plan.
