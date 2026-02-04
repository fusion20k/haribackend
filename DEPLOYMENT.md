# Deployment Guide for Hari Backend

## Features

- **Translation API**: Translates text using Lara AI
- **Global Cache System**: PostgreSQL-based caching reduces API costs by 90%+ over time
- **CORS Enabled**: Works with Chrome extensions

**See [CACHE_SETUP.md](./CACHE_SETUP.md) for detailed cache system documentation.**

## Local Development

### Setup
1. Install dependencies:
   ```bash
   npm install
   ```

2. Create `.env` file (already configured with your credentials):
   ```
   PORT=10000
   LARA_ACCESS_KEY_ID=your_id
   LARA_ACCESS_KEY_SECRET=your_secret
   ```

3. Start the server:
   ```bash
   npm start
   ```

The server will run on http://localhost:10000

## Deploying to Render

### Step 1: Prepare Repository
1. Initialize git repository:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```

2. Push to GitHub/GitLab:
   ```bash
   git remote add origin <your-repo-url>
   git push -u origin main
   ```

### Step 2: Create Render Web Service
1. Go to https://render.com and sign in
2. Click **New +** → **Web Service**
3. Connect your GitHub/GitLab repository
4. Configure the service:
   - **Name**: haribackend (or your preferred name)
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free (or your preferred plan)

### Step 3: Create PostgreSQL Database (IMPORTANT!)

**To enable the global cache system and reduce costs:**

1. In Render dashboard, click **New +** → **PostgreSQL**
2. Configure:
   - **Name**: `haribackend-db`
   - **Region**: Same as your web service
   - **Plan**: Free
3. After creation, copy the **Internal Database URL**

### Step 4: Set Environment Variables

In the Render dashboard, go to **Environment** and add:

- `PORT` = `10000`
- `LARA_ACCESS_KEY_ID` = `RB07SG7HF2BUI50ERS443R110S`
- `LARA_ACCESS_KEY_SECRET` = `HIlazRssYp0y50bthnsbJ_ATWmoM1UPy-GgJ4eZIJ1o`
- `DATABASE_URL` = (paste Internal Database URL from Step 3)
- `NODE_ENV` = `production`

**Note**: Without `DATABASE_URL`, the backend will work but won't cache (every request hits Lara API).

### Step 5: Deploy
1. Click **Create Web Service**
2. Render will automatically build and deploy your app
3. Note your public URL (e.g., `https://haribackend.onrender.com`)

## Testing the Deployed API

### Using curl
```bash
curl -X POST https://haribackend.onrender.com/translate \
  -H "Content-Type: application/json" \
  -d '{
    "sourceLang": "en",
    "targetLang": "tl",
    "sentences": ["Hello", "How are you?"]
  }'
```

### Expected Response
```json
{
  "translations": [
    "Kumusta",
    "Kumusta ka na?"
  ]
}
```

## API Documentation

### POST /translate

Translates text from one language to another using Lara AI.

**Request Body:**
```json
{
  "sourceLang": "en",
  "targetLang": "tl",
  "sentences": ["text1", "text2", ...]
}
```

**Parameters:**
- `sourceLang` (string, required): Source language code (e.g., "en", "en-US")
- `targetLang` (string, required): Target language code (e.g., "tl", "tl-PH")
- `sentences` (array, required): Array of strings to translate (max 8000 characters total)

**Success Response (200):**
```json
{
  "translations": ["translation1", "translation2", ...]
}
```

**Error Responses:**
- `400 Bad Request`: Invalid request body or character limit exceeded
- `502 Bad Gateway`: Lara API error
- `500 Internal Server Error`: Server error

## Chrome Extension Integration

Update your Chrome extension's content script to call the deployed backend:

```javascript
async function translateText(sentences) {
  const response = await fetch('https://haribackend.onrender.com/translate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sourceLang: 'en',
      targetLang: 'tl',
      sentences: sentences,
    }),
  });

  const data = await response.json();
  return data.translations;
}
```

## Production Considerations

### Security
Currently CORS is set to allow all origins (`*`). For production:

1. Get your Chrome extension ID after publishing
2. Update `index.js` CORS configuration:
   ```javascript
   app.use(
     cors({
       origin: "chrome-extension://<your-extension-id>",
     })
   );
   ```

### Rate Limiting
Consider adding rate limiting to prevent abuse:

```bash
npm install express-rate-limit
```

```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});

app.use('/translate', limiter);
```

### Monitoring
- Enable Render's automatic health checks
- Monitor logs in Render dashboard
- Set up alerts for downtime

### Caching
Consider adding Redis caching for frequently translated phrases to reduce Lara API costs.

## Troubleshooting

### Server not starting
- Check environment variables are set correctly
- Verify port is not already in use

### Translation errors
- Verify Lara API credentials are correct
- Check Lara API status
- Review server logs for detailed error messages

### CORS errors in browser
- Verify CORS configuration allows your extension origin
- Check browser console for specific CORS error details
