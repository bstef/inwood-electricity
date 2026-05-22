# ⚡ Inwood Electricity

PSE&G MyMeter threshold notification dashboard — deployed on **Cloudflare Pages** with a **Cloudflare Pages Function** that auto-fetches your Gmail data on every visit (cached 6 hours in KV).

```
https://inwood-electricity.pages.dev   (or your custom domain)
```

---

## Architecture

```
PSE&G email → Gmail inbox
                  ↓
     Cloudflare Pages Function (/api/meter-data)
       • OAuth2 refresh token → Gmail API
       • Fetches all "MyMeter Threshold Notification" emails
       • Parses date + kWh + type from each snippet
       • Caches JSON in Cloudflare KV for 6 hours
                  ↓
     public/index.html  (static, served by Cloudflare Pages)
       • Fetches /api/meter-data on load
       • Renders bar chart, monthly grid, sortable table
       • Shows live/cached status in top bar
```

---

## Prerequisites

- **Node.js 18+** (for wrangler CLI)
- **Cloudflare account** (free tier is sufficient)
- **Google Cloud project** with Gmail API enabled

---

## Step 1 — Clone & install

```bash
git clone https://github.com/bstef/inwood-electricity.git
cd inwood-electricity
npm install
```

---

## Step 2 — Google OAuth2 credentials

You need a **Client ID**, **Client Secret**, and a long-lived **Refresh Token** for your Gmail account (`benjaminstef@gmail.com`).

### 2a. Create a Google Cloud project

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project → **inwood-electricity**
3. Enable **Gmail API**: APIs & Services → Library → search "Gmail API" → Enable

### 2b. Create OAuth2 credentials

1. APIs & Services → Credentials → **Create Credentials** → OAuth client ID
2. Application type: **Web application**
3. Name: `inwood-electricity`
4. Authorized redirect URIs: add `https://developers.google.com/oauthplayground`
5. Save — copy your **Client ID** and **Client Secret**

### 2c. Get a Refresh Token

1. Go to [https://developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
2. Click the ⚙️ gear icon (top right) → check **"Use your own OAuth credentials"**
3. Enter your Client ID and Client Secret → Close
4. In Step 1, find and select:
   `https://www.googleapis.com/auth/gmail.readonly`
5. Click **Authorize APIs** → sign in as `benjaminstef@gmail.com`
6. Click **Exchange authorization code for tokens**
7. Copy the **Refresh token** value — this is long-lived and only shown once

---

## Step 3 — Cloudflare KV namespace

```bash
# Create production namespace
npx wrangler kv:namespace create "KV_METER_DATA"
# → Returns: id = "abc123..."

# Create preview namespace (for local dev)
npx wrangler kv:namespace create "KV_METER_DATA" --preview
# → Returns: preview_id = "def456..."
```

Paste both IDs into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding    = "KV_METER_DATA"
id         = "abc123..."          # ← production id
preview_id = "def456..."          # ← preview id
```

---

## Step 4 — Set secrets

Create a `.env.secrets` file (never committed — it's in `.gitignore`):

```bash
GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-your-secret
GMAIL_REFRESH_TOKEN=1//your-refresh-token
```

Push secrets to Cloudflare:

```bash
node scripts/set-secrets.js
```

Or set them manually:

```bash
npx wrangler pages secret put GMAIL_CLIENT_ID       --project-name inwood-electricity
npx wrangler pages secret put GMAIL_CLIENT_SECRET   --project-name inwood-electricity
npx wrangler pages secret put GMAIL_REFRESH_TOKEN   --project-name inwood-electricity
```

---

## Step 5 — Local development

```bash
npm run dev
# → http://localhost:8788
```

The Pages Function runs locally via Miniflare. It will call Gmail API using your secrets (set via wrangler dev env or `.env.secrets`).

For local dev with secrets, create a `.dev.vars` file (also gitignored):

```
GMAIL_CLIENT_ID=your-client-id
GMAIL_CLIENT_SECRET=your-secret
GMAIL_REFRESH_TOKEN=your-refresh-token
```

---

## Step 6 — Deploy to Cloudflare Pages

### Option A — GitHub (recommended, auto-deploy on push)

1. Push repo to GitHub: `https://github.com/bstef/inwood-electricity`
2. Cloudflare dashboard → **Pages** → **Create a project** → Connect to Git
3. Select the repo
4. Build settings:
   - **Framework preset**: None
   - **Build command**: _(leave blank)_
   - **Build output directory**: `public`
5. Click **Save and Deploy**

Every `git push` to `main` triggers a new deployment automatically.

### Option B — Direct upload (wrangler CLI)

```bash
npm run deploy
```

---

## Step 7 — Custom domain (optional)

In Cloudflare Pages dashboard → your project → **Custom domains** → Add domain.

Since your DNS is already in Cloudflare, it's a one-click setup. Suggested subdomain:

```
electricity.yourdomain.com
```

---

## Repo structure

```
inwood-electricity/
├── public/
│   └── index.html              # Dashboard UI (static)
├── functions/
│   └── api/
│       └── meter-data.js       # Cloudflare Pages Function (Gmail API + KV cache)
├── scripts/
│   └── set-secrets.js          # Helper: push secrets to Cloudflare
├── wrangler.toml               # Cloudflare config
├── package.json
├── .gitignore
└── README.md
```

---

## How data refresh works

| Trigger | What happens |
|---|---|
| Dashboard loaded | Checks KV cache → if < 6 hrs old, returns cached JSON |
| Cache expired / first visit | Calls Gmail API, parses all PSE&G emails, writes to KV |
| ⟳ Refresh button | Forces fresh Gmail fetch regardless of cache age |

---

## Extending / modifying

**Change cache TTL** — edit `CACHE_TTL_SECONDS` in `functions/api/meter-data.js`

**Add more alert types** — the parser in `parseReadings()` already handles daily / hourly / monthly; extend the regex for new formats

**Add Home Assistant sensor** — have HA call `/api/meter-data` and parse the JSON into a template sensor

**Add Slack/email alert** — add a Cloudflare Cron Trigger that calls the worker on a schedule and pings you if usage exceeds a threshold

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `OAuth token error` | Refresh token expired or revoked — re-run OAuth playground step |
| `KV_METER_DATA is not defined` | KV namespace ID not set in `wrangler.toml` or not deployed |
| No data showing | Check browser console — `/api/meter-data` should return JSON |
| Function not running | Make sure `functions/api/meter-data.js` path is correct — Cloudflare Pages maps file paths to routes |
