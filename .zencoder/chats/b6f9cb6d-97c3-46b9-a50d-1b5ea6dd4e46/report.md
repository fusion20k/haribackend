# Implementation Report: TTS Billing Integration

## What Was Implemented

All three billing tasks were applied to the `/tts` handler in `index.js` (starting at line 1825).

### Task 1 — User load + access check
Immediately after the `AZURE_SPEECH_KEY` guard, the handler now:
- Loads the user via `getUserById(req.userId)`
- Checks `(user && user.has_access) || (await userHasActiveSubscription(req.userId))`
- Returns 402 `{ error: "Subscription required" }` if no access

### Task 2 — Cap enforcement for free + premium plans
After the text/input validation, the handler computes:
```js
const ttsChars = text.length;
const weightedChars = ttsChars * 2;
```
Then, for `plan_status` in `['free', 'pre']`:
- Calls `resetUserCharsIfNeeded` and re-fetches user if a reset occurred
- Checks `trial_chars_used >= trial_chars_limit`
- Returns 402 `monthly_limit_reached` for `pre` users, 402 `trial_exhausted` for `free` users
- Error shapes match exactly those used in `/translate`

For `plan_status === 'payg'`: calls `resetUserCharsIfNeeded` only (no block).

Azure Speech is never called if the cap check fails.

### Task 3 — Char increment + Stripe meter event after successful TTS
After `response.ok` and before sending the audio buffer:
- **PAYG**: calls `incrementUserTrialChars(req.userId, weightedChars)`, then fires `stripe.billing.meterEvents.create` with `event_name: "translation_chars"` and `value: String(Math.ceil(weightedChars / 1000))`. Stripe errors are caught and logged as non-fatal. Logs `[tts] billed user=... raw=... weighted=... units=...`.
- **Free + Premium**: calls `incrementUserTrialChars(req.userId, weightedChars)`.

## How the Solution Was Tested

- **Syntax**: `node --check index.js` — passed (exit 0).
- **Manual verification** (to be performed against a running instance):
  1. Free user at 24,999/25,000 chars: 1-char TTS call should succeed; next should 402 `trial_exhausted`.
  2. Premium (`pre`) user at 999,999/1,000,000 chars: TTS call should 402 `monthly_limit_reached`.
  3. PAYG user: successful TTS call should produce `[tts] billed ...` log line and no Stripe error.
  4. Unauthenticated call: still returns 401 from `requireAuth` middleware (unchanged).
  5. Combined cap: `/translate` increment should be visible to subsequent `/tts` call (shared `trial_chars_used`).

## Issues / Edge Cases

- None blocking. The patterns were a straightforward replication of the `/translate` handler's billing logic with the 2x weighting applied consistently to both cap enforcement and Stripe meter reporting.
- The `safeText` computation and SSML construction were moved to after the cap check (they were previously the first operations after input validation). This is correct — no point sanitizing text that will be rejected anyway.
