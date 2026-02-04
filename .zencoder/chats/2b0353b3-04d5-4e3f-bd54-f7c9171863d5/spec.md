# Technical Specification: Hari Translation Backend

## Task Difficulty: Medium

This task involves setting up a new backend service with external API integration, proper error handling, and CORS configuration. It requires moderate complexity with some edge cases to consider (character limits, array length validation, API response mapping).

## Technical Context

**Language**: Node.js (JavaScript)  
**Framework**: Express.js  
**Runtime**: Node.js v18+ (Render default)  
**Deployment**: Render.com  
**External API**: Lara Translate API  

**Key Dependencies**:
- `express` - Web framework
- `cors` - CORS middleware for Chrome extension
- `node-fetch` - HTTP client for Lara API calls

## Implementation Approach

### Architecture Overview
The backend acts as a proxy/orchestration layer between the Chrome extension and Lara Translation API. It will:

1. Accept translation requests from the Chrome extension
2. Validate input (type checking, length limits)
3. Transform requests to Lara API format
4. Forward to Lara API with authentication
5. Transform responses back to agreed contract format
6. Handle errors gracefully

### Key Design Decisions

**Character Limit**: 8000 characters per request to prevent abuse and manage Lara API costs.

**Array Mapping**: Strict 1:1 mapping between input sentences and output translations. The backend will validate that `translations.length === sentences.length`.

**CORS Strategy**: Initially allow all origins (`*`) for development, with note to restrict to specific extension ID in production.

**Error Handling**: Return appropriate HTTP status codes:
- 400: Invalid client request
- 502: Upstream Lara API error
- 500: Internal server error

## Source Code Structure

### New Files to Create

1. **`package.json`**
   - Define project metadata
   - List dependencies: express, cors, node-fetch
   - Add start script

2. **`index.js`**
   - Main application entry point
   - Express app setup with middleware
   - CORS configuration
   - `/translate` POST endpoint implementation
   - Server initialization

3. **`.env.example`**
   - Template for environment variables
   - Documents required configuration

4. **`.gitignore`**
   - Exclude node_modules, .env files

5. **`README.md`** (if requested)
   - Setup instructions
   - Environment variable documentation
   - API contract documentation

## Data Model / API Changes

### API Contract

**Endpoint**: `POST /translate`

**Request Body**:
```json
{
  "sourceLang": "en",
  "targetLang": "tl",
  "sentences": [
    "Example sentence one.",
    "Example sentence two."
  ]
}
```

**Response Body (Success)**:
```json
{
  "translations": [
    "Tagalog translation for sentence one.",
    "Tagalog translation for sentence two."
  ]
}
```

**Response Body (Error)**:
```json
{
  "error": "Error message",
  "details": "Optional error details"
}
```

### Lara API Integration

**Lara Request Format**:
```json
{
  "text": [
    { "text": "sentence 1" },
    { "text": "sentence 2" }
  ],
  "source": "en",
  "target": "tl"
}
```

**Lara Response Format** (assumed):
```json
{
  "text": [
    { "text": "translation 1" },
    { "text": "translation 2" }
  ]
}
```

## Environment Variables

Required on Render:
- `PORT`: Server port (default: 10000)
- `LARA_API_KEY`: Lara API authentication key
- `LARA_BASE_URL`: Lara API base URL (e.g., `https://api.laratranslate.com`)

## Verification Approach

### Testing Strategy

1. **Local Development Testing**:
   - Set up `.env` file with test credentials
   - Start server locally
   - Test with curl/Postman:
     - Valid requests with different array sizes
     - Invalid requests (missing fields, wrong types)
     - Large requests (over 8000 characters)
     - Empty arrays

2. **Lara API Integration Testing**:
   - Verify correct request transformation
   - Verify correct response transformation
   - Test array length preservation
   - Test error handling for Lara API failures

3. **CORS Testing**:
   - Verify preflight OPTIONS requests are handled
   - Verify Chrome extension can make requests

4. **Deployment Testing**:
   - Deploy to Render
   - Verify environment variables are set
   - Test public endpoint
   - Monitor logs for errors

### Manual Verification Steps

```bash
# Test valid request
curl -X POST https://haribackend.onrender.com/translate \
  -H "Content-Type: application/json" \
  -d '{
    "sourceLang": "en",
    "targetLang": "tl",
    "sentences": ["Hello", "How are you?"]
  }'

# Test invalid request
curl -X POST https://haribackend.onrender.com/translate \
  -H "Content-Type: application/json" \
  -d '{
    "sourceLang": "en",
    "sentences": "not an array"
  }'
```

## Risks and Considerations

1. **Lara API Response Format**: The specification assumes Lara returns `{ text: [{ text: "..." }] }`. This needs to be verified against actual Lara API documentation.

2. **Rate Limiting**: No rate limiting is implemented initially. May need to add this to prevent abuse.

3. **Caching**: No caching strategy. Repeated translations of the same text will hit Lara API each time.

4. **Security**: CORS is wide open (`*`). Should be restricted to specific extension ID for production.

5. **Cost Management**: Character limit of 8000 provides basic protection but may need more sophisticated controls.

## Future Enhancements

- Add Redis caching for frequently translated sentences
- Implement rate limiting per IP/extension
- Add request logging and analytics
- Support batch optimization (dedupe identical sentences)
- Add health check endpoint for monitoring
