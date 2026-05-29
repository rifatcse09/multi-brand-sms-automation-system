# Cloudflare Worker Backend (SMS + Analytics)

This Worker is the backend for the dashboard. It manages brands, campaigns, queue sending, per-phone results, and analytics (including subscriber growth).

## Core logic overview

- **Brand-wise ActiveCampaign config**
  - Each brand stores its own `activeCampaignApiUrl` and `activeCampaignApiKey`.
  - Tag list and audience fetch are done server-side using the selected brand.
- **Campaign send pipeline**
  - `POST /campaigns` creates campaign + phone rows in KV.
  - Each phone is pushed to `CAMPAIGN_QUEUE`.
  - Queue consumer sends SMS (mock or real), updates counters/status, and writes per-phone result.
- **Phone-level failure diagnostics**
  - Stores short error + detailed root cause (`failureDetail`, `failureSource`, `failedAt`, `twilioSid`).
  - Retry clears prior failure data and re-queues the phone.
- **Subscriber summary + growth**
  - New endpoint: `GET /analytics/subscribers-summary`
  - Provides total subscribers, active subscribers, unsubscribed, and growth.

## Subscriber and growth formulas

### 1) Total SMS Subscribers

Count unique ActiveCampaign contacts (across configured brands) that have a valid phone number.

`totalSubscribers = count(unique phone where phone != null)`

### 2) Active SMS Subscribers

Simple formula used:

`activeSmsSubscribers = deliveredTotal - unsubscribedTotal`

Where:
- `deliveredTotal` comes from accumulated Twilio delivered events
- `unsubscribedTotal` comes from STOP/unsubscribe inbound handling

### 3) Growth

Daily active is tracked in KV as:

`dailyActive = dailyDelivered - dailyUnsubs`

Growth shown in dashboard:

`growth = todayActive - yesterdayActive`

Example:
- Yesterday active: 1000
- Today active: 1150
- Growth: `+150`

## APIs

### Brands

- `GET /brands`
- `POST /brands`
- `PUT /brands/:id`
- `DELETE /brands/:id`
- `GET /brands/:id/activecampaign/tags` (preferred)
- `GET /brands/:id/tags` (backward-compatible alias)

### Campaigns

- `GET /campaigns?brand=&status=&important=`
- `POST /campaigns`
- `GET /campaigns/:id`
- `GET /campaigns/:id/progress` (lightweight sent/failed/queue for live polling)
- `PATCH /campaigns/:id/important`
- `POST /campaigns/:id/resume` (re-queue pending phones after a queue/KV stall; skips numbers already in the delivery ledger)
- `POST /campaigns/:id/retry-failed`
- `POST /campaigns/:id/phones/:phoneId/retry`
- `DELETE /campaigns/:id`

### Analytics

- `GET /analytics/sent-failed`
- `GET /analytics/subscribers-summary`

### Auth

- `POST /auth/login`
- `POST /auth/forgot-password`
- `POST /auth/reset-password`
- `POST /auth/change-password` (Bearer token)

### Compatibility routes

- `GET /blast`
- `GET /metrics/all`
- `GET /metrics`
- `GET /health`

## Twilio webhook logic

- **Delivery status**
  - `POST /twilio/status?token=<TWILIO_STATUS_TOKEN>`
  - On `delivered`:
    - increments campaign delivered meta
    - increments daily subscriber delivered stat
  - On `undelivered/failed`:
    - marks phone row failed (if not already)
    - stores Twilio error code/message details
- **Inbound replies**
  - `POST /twilio/inbound?token=<TWILIO_STATUS_TOKEN>`
  - Increments `replies` or `unsubs` on campaign meta
  - STOP/UNSUBSCRIBE increments daily subscriber unsubs stat

## Deploy steps

1. Create local config:

```bash
cp wrangler.toml.example wrangler.toml
```

2. Create KV namespace + Queue in Cloudflare.
3. Set IDs in `wrangler.toml` (`account_id`, KV id, queue name).
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

## Runtime vars

- `SEND_MODE=mock|real`
- `WORKER_BASE_URL`
- `DEFAULT_BRAND_ID`
- `DEFAULT_CONTACT_COUNT`
- `DEFAULT_ADMIN_EMAIL`
- `OWNER_PHONE`

## Frontend env

```bash
VITE_SMS_WORKER_BASE_URL=https://<your-worker>.workers.dev
VITE_SMS_WORKER_SECRET=<BLAST_SECRET>
```
