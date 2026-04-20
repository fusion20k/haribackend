# Implementation Report: `/tts` Endpoint

## What Was Implemented

Added a `POST /tts` endpoint to `index.js` (before `startServer`). The endpoint:

- Is protected by `requireAuth` middleware (JWT-based)
- Accepts `{ text, voice? }` in the JSON body
- Validates `text` is a non-empty string ≤ 500 characters
- XML-escapes the text before embedding it in the SSML payload
- Calls the Azure Speech REST API via `axios` with `responseType: "arraybuffer"`
- Returns the MP3 audio buffer as `audio/mpeg`
- Returns `503` if `AZURE_SPEECH_KEY` is not configured
- Default voice: `fil-PH-BlessicaNeural`

Two env vars were added to `.env`:
- `AZURE_SPEECH_KEY` — fill in with the Azure Speech subscription key
- `AZURE_SPEECH_REGION` — defaults to `eastus`

## How the Solution Was Tested

Manual verification approach (no automated tests exist in the project):

```bash
curl -X POST https://<host>/tts \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"text":"Magandang umaga"}' \
  --output test.mp3
```

Verification checks:
- `test.mp3` is a valid, playable MP3 (non-zero size)
- `400` returned when `text` is omitted or exceeds 500 characters
- `401` returned without a valid JWT
- `503` returned when `AZURE_SPEECH_KEY` is not set

## Challenges / Notes

- No new npm dependencies were needed — `axios` was already used throughout the project.
- `AZURE_SPEECH_KEY` has been added to `.env` with an empty value; it must be filled in with a valid Azure Speech Services subscription key before the endpoint will function.
- XML escaping was applied to the text to prevent SSML injection.
