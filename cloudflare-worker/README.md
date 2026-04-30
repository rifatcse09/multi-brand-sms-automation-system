# Cloudflare Worker Replacement

This folder contains a replacement Worker implementation for your SMS dashboard backend.

## What this Worker provides

- Dashboard-ready API:
  - `GET /brands`
  - `POST /brands`
  - `PUT /brands/:id`
  - `DELETE /brands/:id`
  - `GET /campaigns?brand=&status=&important=`
  - `POST /campaigns`
  - `GET /campaigns/:id`
  - `PATCH /campaigns/:id/important`
  - `POST /campaigns/:id/retry-failed`
  - `GET /analytics/sent-failed`
- Queue consumer for async SMS send processing.
- Auth endpoints:
  - `POST /auth/login`
  - `POST /auth/forgot-password`
  - `POST /auth/reset-password`
  - `POST /auth/change-password` (Bearer token)
- Compatibility routes to avoid breaking existing clients:
  - `GET /blast`
  - `GET /metrics/all`
  - `GET /metrics`
  - `GET /health`

## Deploy steps

1. Create local config from template:

```bash
cp wrangler.toml.example wrangler.toml
```

2. Create KV namespace and Queue in Cloudflare dashboard.
3. Put real IDs in `wrangler.toml`:
   - `account_id`
   - `kv_namespaces[0].id`
   - queue name if different
4. Set secrets:

```bash
wrangler secret put BLAST_SECRET
wrangler secret put TWILIO_STATUS_TOKEN
wrangler secret put TWILIO_ACCOUNT_SID
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put TWILIO_MESSAGING_SERVICE_SID
wrangler secret put MISSIVE_API_TOKEN
wrangler secret put DEFAULT_ADMIN_PASSWORD
wrangler secret put MISSIVE_SHADOWLOG_NAME
```

5. Install and deploy:

```bash
npm install
npm run deploy
```

## Modes

- `SEND_MODE=mock` (default): no real Twilio calls.
- `SEND_MODE=real`: sends via Twilio.
- `WORKER_BASE_URL`: required for Twilio delivery status callbacks.
- `DEFAULT_ADMIN_EMAIL`: fallback admin email used for first login.
- `OWNER_PHONE`: target number to receive forgot-password SMS code.

## Webhooks

- Twilio status callback:
  - `POST /twilio/status?token=<TWILIO_STATUS_TOKEN>`
- Twilio inbound reply webhook:
  - `POST /twilio/inbound?token=<TWILIO_STATUS_TOKEN>`

## Frontend config

In frontend `.env`:

```bash
VITE_SMS_WORKER_BASE_URL=https://<your-worker>.workers.dev
VITE_SMS_WORKER_SECRET=<BLAST_SECRET>
```
