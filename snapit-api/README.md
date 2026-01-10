# SnapIt Feedback API

Cloudflare Worker for handling user feedback submissions from the SnapIt app.

## Setup

### 1. Install dependencies

```bash
cd snapit-api
npm install
```

### 2. Login to Cloudflare

```bash
npx wrangler login
```

### 3. Create KV namespace

```bash
npx wrangler kv namespace create FEEDBACK_KV
```

Copy the returned namespace ID and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "FEEDBACK_KV"
id = "YOUR_NAMESPACE_ID_HERE"
```

### 4. Set up Resend (email service)

1. Sign up at https://resend.com (free tier: 3000 emails/month)
2. Add your domain or use their test domain
3. Create an API key

### 5. Configure secrets

```bash
npx wrangler secret put RESEND_API_KEY
# Paste your Resend API key when prompted

npx wrangler secret put NOTIFICATION_EMAIL
# Enter your email address to receive notifications
```

### 6. Update email sender

In `src/index.ts`, update the `from` address:

```typescript
from: 'SnapIt Feedback <feedback@yourdomain.com>',
```

### 7. Deploy

```bash
npm run deploy
```

### 8. Update SnapIt app

Copy your worker URL and update `FeedbackTab.tsx`:

```typescript
const FEEDBACK_API = 'https://snapit-feedback.YOUR-SUBDOMAIN.workers.dev/feedback';
```

## Development

Run locally:

```bash
npm run dev
```

View logs:

```bash
npm run tail
```

## API Endpoints

### POST /feedback

Submit user feedback.

**Request:**
```json
{
  "message": "Your feedback here",
  "logs": "Optional log content",
  "systemInfo": {
    "platform": "Win32",
    "userAgent": "..."
  },
  "appVersion": "1.0.0"
}
```

**Response:**
```json
{
  "success": true,
  "id": "uuid-here"
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok"
}
```

## Cost

All within free tiers for typical usage:

- **Cloudflare Workers:** 100,000 requests/day
- **Cloudflare KV:** 100,000 reads, 1,000 writes/day
- **Resend:** 3,000 emails/month
