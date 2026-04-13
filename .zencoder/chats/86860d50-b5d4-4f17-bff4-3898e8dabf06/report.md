# Implementation Report: POST /dictionary

## What Was Implemented

### `llmDictionary` helper function (index.js, line ~68)
A new async helper that calls the Azure OpenAI chat completions API via `axios`. It:
- Uses `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, and `AZURE_OPENAI_DEPLOYMENT` env vars
- Sends a system prompt establishing Tagalog expert persona with JSON-only output
- Uses `response_format: { type: "json_object" }` to enforce structured output
- Parses and returns the JSON content from the first choice
- Throws on any axios or parse failure (caller catches and maps to 500)

### `POST /dictionary` route (index.js, line ~1353)
New authenticated endpoint following the exact same pattern as `POST /translate`:

1. **Auth**: `requireAuth` middleware (JWT Bearer)
2. **Access check**: `userHasActiveSubscription` + `has_access` flag, same as `/translate`
3. **Input validation**: `word` and `english` required non-empty strings; `context` optional (defaults to `""`)
4. **Quota enforcement**: Mirrors `/translate` exactly — checks `trial_chars_used >= trial_chars_limit` for `free`/`pre` users with identical error codes (`trial_exhausted`, `monthly_limit_reached`); resets chars if needed for `payg`
5. **LLM call**: Calls `llmDictionary`; on any failure returns `{ error: "dictionary_unavailable" }` with HTTP 500
6. **Char accounting**: `totalChars = word.length + english.length + context.length`. Increments `trial_chars_used` for `free`/`pre`/`payg` plans; fires Stripe meter event for `payg` — identical to `/translate`
7. **Response**: Dictionary entry JSON merged with plan-specific fields (`trial_chars_used`/`trial_chars_limit` for free/pre, `payg_chars_used`/`payg_chars_limit` for payg)

### `.env.example`
Added three new variables:
```
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_KEY=your_azure_openai_key_here
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
```

## How the Solution Was Tested

No automated test scripts exist in this project (`package.json` has no test command). Manual verification approach:

1. **Auth guard**: `POST /dictionary` without a token → 401 `{ error: "Missing token" }`
2. **Input validation**: Missing `word` or `english` → 400 `{ error: "word and english are required" }`
3. **LLM failure fallback**: With missing/invalid `AZURE_OPENAI_*` env vars → 500 `{ error: "dictionary_unavailable" }`
4. **Happy path**: With valid credentials and Azure OpenAI configured → 200 with structured dictionary JSON

## Biggest Issues / Challenges

- **Char counting for dictionary**: `/translate` counts chars from the actual texts passed to Azure Translator. For `/dictionary` there is no equivalent "translated chars" concept from the LLM — the decision was to count the total input length (`word + english + context`) as a reasonable proxy, consistent with the spec decision that dictionary calls count against the quota.
- **No global usage cap check**: `/translate` checks the global `MONTHLY_CHAR_LIMIT` cap (`getUsage()`) before calling Azure. This was intentionally omitted from `/dictionary` since the global cap tracks Azure Translator costs (not Azure OpenAI), and the spec did not call for it. This can be added later if needed.
