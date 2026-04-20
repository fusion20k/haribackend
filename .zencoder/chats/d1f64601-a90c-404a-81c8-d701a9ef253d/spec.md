# Technical Specification: `/tts` Endpoint

## Complexity Assessment
**Easy** — Single new endpoint, no DB changes, follows existing axios/Azure call patterns already in `index.js`.

---

## Technical Context

- **Language**: Node.js (CommonJS)
- **Framework**: Express 4
- **Existing HTTP client**: `axios` (already used for Azure Translator and Azure OpenAI calls)
- **Auth middleware**: `requireAuth` (JWT-based, defined at line 412 in `index.js`)
  - Note: the user referred to this as `authenticateToken` — the actual function in the codebase is `requireAuth`
- **No new dependencies required** — Azure Speech REST API is called via `axios`

---

## Implementation Approach

Add a `POST /tts` endpoint to `index.js` that:

1. Is protected by `requireAuth`
2. Accepts `{ text, voice? }` in the JSON body
3. Validates `text` is a non-empty string ≤ 500 characters
4. Builds an SSML payload with the target voice
5. Calls the Azure TTS REST API via `axios` (binary response)
6. Pipes the audio buffer back to the client as `audio/mpeg`

### Azure TTS REST API Details

- **Endpoint**: `https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`
- **Region**: `eastus` (from env var `AZURE_SPEECH_REGION`)
- **Auth header**: `Ocp-Apim-Subscription-Key: {key}` (from env var `AZURE_SPEECH_KEY`)
- **Request Content-Type**: `application/ssml+xml`
- **Output format header**: `X-Microsoft-OutputFormat: audio-16khz-128kbitrate-mono-mp3`
- **Default voice**: `fil-PH-BlessicaNeural`
- **Response**: binary MP3 buffer → return as `audio/mpeg`

### SSML Template

```xml
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="fil-PH">
  <voice name="{voice}">{escaped_text}</voice>
</speak>
```

---

## Source Code Changes

### Files Modified

| File | Change |
|------|--------|
| `index.js` | Add `POST /tts` endpoint (after existing endpoints, before `app.listen`) |
| `.env` | Add `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` |

### New Endpoint: `POST /tts`

**Request**
```json
{ "text": "Magandang umaga", "voice": "fil-PH-BlessicaNeural" }
```

**Responses**
| Status | Condition |
|--------|-----------|
| `200 audio/mpeg` | Success — MP3 audio buffer |
| `400` | Missing/empty `text`, or `text` > 500 chars |
| `401` | Missing or invalid JWT |
| `503` | Azure Speech not configured (`AZURE_SPEECH_KEY` missing) |
| `500` | Azure TTS call failed |

---

## Data Model / API / Interface Changes

- No database changes
- New env vars: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` (defaults to `eastus`)

---

## Verification Approach

Manual verification with `curl` or a REST client:

```bash
curl -X POST https://<host>/tts \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"text":"Magandang umaga"}' \
  --output test.mp3
```

Confirm:
- `test.mp3` is a valid MP3 file (non-zero size, playable)
- 400 returned when `text` is omitted or > 500 chars
- 401 returned without a valid token
