# Technical Specification: POST /dictionary

## Difficulty Assessment

**Medium** — New LLM integration (currently absent from the codebase), structured JSON parsing from LLM output, straightforward endpoint pattern following existing conventions.

---

## Technical Context

- **Language / Runtime**: Node.js (CommonJS), Express 4
- **Key existing dependencies**: `axios` (HTTP), `jsonwebtoken` (auth), `express`
- **Auth middleware**: `requireAuth` (JWT Bearer token, already in `index.js`)
- **All routes**: defined inline in `index.js` — no separate router files
- **LLM provider**: ⚠️ **None currently configured.** The project uses Azure Cognitive Services Translator (`AZURE_API_KEY` / `AZURE_ENDPOINT`) which is a translation API, not an LLM. A new LLM API key and endpoint must be added to `.env`.

### LLM Provider: Azure OpenAI Service

Uses `axios` (already installed) to call Azure OpenAI chat completions API.

| Env var | Purpose |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI resource endpoint (e.g. `https://myresource.openai.azure.com`) |
| `AZURE_OPENAI_KEY` | Azure OpenAI API key |
| `AZURE_OPENAI_DEPLOYMENT` | Deployment name (e.g. `gpt-4o-mini`) |

### Decisions

- **Character quota**: `/dictionary` calls **count against** the user's `trial_chars_used` limit (same as `/translate`)
- **Caching**: No caching — always call the LLM fresh

---

## Implementation Approach

Add a single new route handler `POST /dictionary` to `index.js`, following the exact same pattern as `POST /translate`:

1. Apply `requireAuth` middleware
2. Validate request body (`word`, `english`, `context`)
3. Build a system + user prompt instructing the LLM to act as a "Tagalog language expert"
4. Call the LLM via `axios` with `response_format: { type: "json_object" }` (or prompt-enforce JSON)
5. Parse and return the structured response
6. On any error, return `{ error: "dictionary_unavailable" }` with HTTP 500

### Prompt Design

**System**: `"You are a Tagalog language expert. Always respond with valid JSON only."`

**User**:
```
Given the Tagalog word "<word>" (English: "<english>", context: "<context>"), provide a dictionary entry as JSON with exactly these fields:
{
  "tagalog": string,
  "pronunciation": string (IPA or simple phonetic),
  "partOfSpeech": string,
  "englishTranslation": string,
  "example": { "tl": string, "en": string },
  "culturalNotes": string,
  "wordBreakdown": [{ "tagalog": string, "english": string, "pos": string }]
}
```

---

## Source Code Changes

### Files Modified

- **`index.js`** — add one new route and one helper function

### Files Created

- None

### New `.env` variables

```
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_KEY=your_azure_openai_key
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
```

---

## API Contract

### Request

```
POST /dictionary
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "word": "mahal",
  "english": "love / expensive",
  "context": "used in a romantic sentence"
}
```

**Validation rules:**
- `word` — required, non-empty string
- `english` — required, non-empty string
- `context` — optional string (defaults to empty string if omitted)

### Success Response (200)

```json
{
  "tagalog": "mahal",
  "pronunciation": "mah-HAL",
  "partOfSpeech": "adjective / verb",
  "englishTranslation": "love; expensive; dear",
  "example": {
    "tl": "Mahal kita.",
    "en": "I love you."
  },
  "culturalNotes": "...",
  "wordBreakdown": [
    { "tagalog": "mahal", "english": "love/expensive", "pos": "adjective" }
  ]
}
```

### Error Response (400 — bad input)

```json
{ "error": "word and english are required" }
```

### Error Response (401 — unauthenticated)

Standard `requireAuth` 401 response (existing behavior).

### Error Response (500 — LLM failure)

```json
{ "error": "dictionary_unavailable" }
```

---

## Helper Function

```js
async function llmDictionary(word, english, context) {
  // POST to OpenAI chat completions
  // Parse response.data.choices[0].message.content as JSON
  // Return parsed object
  // Throws on any failure
}
```

---

## Verification Approach

1. **Manual curl test** after starting the server:
   ```
   curl -X POST http://localhost:10000/dictionary \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"word":"salamat","english":"thank you","context":"greeting"}'
   ```
2. **Auth guard**: verify 401 is returned without a token
3. **Input validation**: verify 400 is returned for missing `word` or `english`
4. **Error fallback**: verify 500 with `{ "error": "dictionary_unavailable" }` when Azure OpenAI is misconfigured
5. **No lint/test scripts** are configured in `package.json`, so no automated checks to run
