# Technical Specification: Speech (TTS) Billing Integration

## Complexity Assessment: **Medium**

The `/tts` endpoint already exists. The billing and character-counting patterns are already established in `/translate` and `/dictionary`. This is primarily about replicating those patterns in the TTS handler with a 2x character weighting for speech.

---

## Decisions (confirmed by user)

| Question | Decision |
|---|---|
| Stripe meter for TTS PAYG | Use the **same** existing `"translation_chars"` meter — no new meter/price needed |
| Premium 1M cap weighting | **2x** — each TTS character counts as 2 toward the cap |
| Free 25K cap | Yes — TTS counts with **2x weighting** (consistent with premium) |
| Cap boundary behavior | **Block entirely** if already at/over limit (consistent with `/translate`) |

---

## Current State (from codebase analysis)

### TTS Endpoint (`/tts` — index.js:1825)
- Already exists, requires auth
- Accepts `{ text, voice, native }`, text max 500 chars
- Calls Azure Speech (eastus.tts.speech.microsoft.com)
- Returns `audio/mpeg`
- **Does NOT track characters — no billing, no cap enforcement**

### PAYG Billing Pattern (established in `/translate` and `/dictionary`)
- Characters reported to Stripe meter event name: `"translation_chars"`
- Units = `Math.ceil(chars / 1000)` (per-thousand billing)
- DB: `users.trial_chars_used` incremented via `incrementUserTrialChars()`
- Stripe: `stripe.billing.meterEvents.create({ event_name: "translation_chars", payload: { value: String(units), stripe_customer_id } })`

### Premium Plan Cap (`plan_status = 'pre'`)
- `trial_chars_limit = 1,000,000`
- `/translate` and `/dictionary` both:
  1. Reset chars if `free_chars_reset_date` has passed
  2. Check `trial_chars_used >= trial_chars_limit` → block with `monthly_limit_reached`
  3. Increment `trial_chars_used` after successful response
- TTS currently **bypasses** this cap entirely

### Free Plan Cap (`plan_status = 'free'`)
- `trial_chars_limit = 25,000`
- Same check/block/increment flow as premium

### DB Schema (relevant fields in `users` table — no changes needed)
| Column | Type | Description |
|---|---|---|
| `trial_chars_used` | INTEGER | Cumulative chars used (all services combined) |
| `trial_chars_limit` | INTEGER | 25000 (free), 1000000 (premium), 20000000 (payg) |
| `chars_used_at_payg_start` | INTEGER | Baseline for PAYG display counter |
| `stripe_item_id` | VARCHAR | Stripe subscription item ID for metered billing |
| `free_chars_reset_date` | DATE | When chars reset |

---

## Implementation Approach

### Character Counting for TTS
```
const ttsChars = text.length          // raw input length (plain text, before SSML)
const weightedChars = ttsChars * 2    // 2x weight for cap enforcement and PAYG billing
```

The `weightedChars` value is what gets passed to `incrementUserTrialChars()` and used for Stripe meter events. This means:
- A 500-char TTS request consumes 1,000 characters from the premium/free cap
- A 500-char TTS request reports `Math.ceil(1000 / 1000) = 1` unit to the Stripe meter

### Changes to `/tts` endpoint (index.js only)

**Step 1 — Load user and check access** (already done in endpoint; needs to be added at top of handler):
```js
let user = await getUserById(req.userId);
const hasAccess = (user && user.has_access) || (await userHasActiveSubscription(req.userId));
if (!hasAccess) return res.status(402).json({ error: "Subscription required" });
```

**Step 2 — Cap enforcement for free + premium (BEFORE calling Azure)**
```js
const ttsChars = text.length;
const weightedChars = ttsChars * 2;

if (user && ["free", "pre"].includes(user.plan_status)) {
  const reset = await resetUserCharsIfNeeded(req.userId);
  if (reset) user = await getUserById(req.userId);
  const charsUsed = user.trial_chars_used ?? 0;
  const charsLimit = user.trial_chars_limit ?? 25000;
  if (charsUsed >= charsLimit) {
    if (user.plan_status === "pre") {
      return res.status(402).json({
        error: "monthly_limit_reached",
        message: "You have used your 1,000,000 monthly characters. Your limit resets in 30 days.",
        trial_chars_used: charsUsed,
        trial_chars_limit: charsLimit,
      });
    }
    return res.status(402).json({
      error: "trial_exhausted",
      message: "You have used your 25,000 free characters.",
      trial_chars_used: charsUsed,
      trial_chars_limit: charsLimit,
    });
  }
}
```

**Step 3 — PAYG reset check (BEFORE calling Azure)**
```js
if (user && user.plan_status === "payg") {
  const reset = await resetUserCharsIfNeeded(req.userId);
  if (reset) user = await getUserById(req.userId);
}
```

**Step 4 — Call Azure Speech** (existing logic, unchanged)

**Step 5 — Char accounting AFTER successful Azure response, BEFORE sending buffer**
```js
// PAYG: increment DB + fire Stripe meter
if (user && user.plan_status === "payg") {
  await incrementUserTrialChars(req.userId, weightedChars);
  const freshUser = await getUserById(req.userId);
  if (freshUser?.stripe_customer_id && stripe && weightedChars > 0) {
    const unitsToReport = Math.ceil(weightedChars / 1000);
    try {
      await stripe.billing.meterEvents.create({
        event_name: "translation_chars",
        payload: {
          value: String(unitsToReport),
          stripe_customer_id: freshUser.stripe_customer_id,
        },
      });
      console.log(`[tts] billed user=${req.userId} raw=${ttsChars} weighted=${weightedChars} units=${unitsToReport}`);
    } catch (e) {
      console.error("TTS PAYG Stripe meter event failed (non-fatal):", e.message);
    }
  }
}

// Free + premium: increment DB
if (user && ["free", "pre"].includes(user.plan_status)) {
  await incrementUserTrialChars(req.userId, weightedChars);
}

// Then send audio
res.set("Content-Type", "audio/mpeg");
const buffer = await response.arrayBuffer();
res.send(Buffer.from(buffer));
```

---

## Files to Modify

| File | Section | Change |
|---|---|---|
| `index.js` | `/tts` handler (line 1825) | Add user load, cap check, reset check, char increment, Stripe meter event |

**No changes needed to:** `db.js`, `analytics.js`, `segmentation.js`, `.env.example`

---

## Verification Approach

1. **Free cap**: Set `trial_chars_used = 24,999`, `trial_chars_limit = 25000` for a free user → call `/tts` with 1-char text (weighted = 2) → should succeed and push `trial_chars_used` to 25001; next call should 402 `trial_exhausted`
2. **Premium cap**: Set `trial_chars_used = 999,999`, `trial_chars_limit = 1000000` for a `pre` user → call `/tts` with 1-char text → should 402 `monthly_limit_reached`
3. **Combined cap**: Confirm that after `/translate` increments chars, a subsequent `/tts` call sees the updated total (shared `trial_chars_used` counter)
4. **PAYG meter**: Call `/tts` as a `payg` user, confirm console log `[tts] billed user=...` and no Stripe error
5. **No double-billing**: Confirm the Stripe meter event value uses `weightedChars`, not `ttsChars`
