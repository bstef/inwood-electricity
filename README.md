# ⚡ Inwood Electricity

PSE&G MyMeter threshold notification dashboard — live at **[inwood-electricity.pages.dev](https://inwood-electricity.pages.dev)**.

Built on **Cloudflare Pages** with a **Pages Function** that auto-fetches PSE&G Gmail notifications and caches results in **Cloudflare KV**. No server, no cron job — data refreshes automatically on every visit after the 6-hour cache window.

---

## Architecture

```
PSE&G email → Gmail inbox (benjaminstef@gmail.com)
                    ↓
    Cloudflare Pages Function (/api/meter-data)
      • OAuth2 refresh token → Gmail API
      • messages.list with snippet — 1 subrequest per page
      • Parses date + kWh + type from each snippet
      • Caches parsed JSON in Cloudflare KV for 6 hours
                    ↓
    public/index.html  (static, served by Cloudflare Pages)
      • Fetches /api/meter-data on load
      • Shows live/cached status + last fetch time
      • Bar chart, monthly summary grid, sortable table
      • ?refresh=1 busts cache and re-fetches immediately
```

---

## Key Technical Notes

### Why `messages.list` instead of batch API

Early versions used Gmail's batch HTTP API to fetch snippets for all message IDs. This had two bugs:

1. Gmail batch API is limited to **100 requests per batch** — silently returns nothing when exceeded
2. `messages.list` already returns `snippet` inline in the list response — no second call needed

The fix: `messages.list?maxResults=500` returns up to 500 messages with snippets per page. Each page = 1 subrequest. At ~200 PSE&G emails total, this is 1 subrequest — well within Cloudflare Workers' limit of 50 subrequests per invocation.

### Snippet parsing

Each PSE&G email snippet looks like:
```
A MyMeter threshold setting for your account, ****1908, has been met.
Meter #000303411361 has daily total consumption above 15 kWh.
Actual use for this period was 21.81 kWh at 05-20-26 12:00 A.
```

Two regexes extract everything needed:
- kWh: `/was\s+([\d.]+)\s+kWh/i`
- Date: `/at\s+(\d{2}-\d{2}-\d{2})\s+\d{2}:\d{2}/i`
- Type: detected from `hourly total`, `monthly total`, or `daily total` in snippet

### Cache behavior

| Request | Behavior |
|---|---|
| Normal page load | Returns KV cache if < 6 hours old |
| Cache expired | Re-fetches Gmail, writes new cache |
| `?refresh=1` | Bypasses cache, always re-fetches |
| `?debug=1` | Returns raw Gmail API response for debugging |

---

## Repo Structure

```
inwood-electricity/
├── public/
│   └── index.html              # Dashboard UI (static HTML/CSS/JS)
├── functions/
│   └── api/
│       └── meter-data.js       # Cloudflare Pages Function
├── scripts/
│   └── set-secrets.js          # Helper: push secrets to Cloudflare
├── wrangler.toml               # Cloudflare config + KV namespace IDs
├── package.json
├── .gitignore                  # Excludes .env.secrets, node_modules
└── README.md
```

---

## Prerequisites

- Node.js 18+
- Cloudflare account (free tier)
- Google Cloud project with Gmail API enabled

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/bstef/inwood-electricity.git
cd inwood-electricity
npm install
```

### 2. Google OAuth2 credentials

1. [Google Cloud Console](https://console.cloud.google.com) → create project **inwood-electricity**
2. APIs & Services → Library → enable **Gmail API**
3. APIs & Services → Credentials → Create OAuth client ID
   - Type: **Web application**
   - Authorized redirect URI: `https://developers.google.com/oauthplayground`
4. Copy **Client ID** and **Client Secret**

**Get a refresh token:**
1. Go to [OAuth Playground](https://developers.google.com/oauthplayground)
2. ⚙️ gear → check **"Use your own OAuth credentials"** → enter Client ID + Secret
3. Select scope: `https://www.googleapis.com/auth/gmail.readonly`
4. Authorize → Exchange code for tokens → copy **Refresh token**
5. Add yourself as a test user first:
   - Google Cloud → APIs & Services → **Audience** → Test users → Add `benjaminstef@gmail.com`

### 3. Cloudflare KV namespace

```bash
npx wrangler kv namespace create KV_METER_DATA
npx wrangler kv namespace create KV_METER_DATA --preview
```

Paste both IDs into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding    = "KV_METER_DATA"
id         = "your-production-id"
preview_id = "your-preview-id"
```

### 4. Set secrets

Create `.env.secrets` (gitignored):
```
GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-your-secret
GMAIL_REFRESH_TOKEN=1//your-refresh-token
```

Push to Cloudflare:
```bash
node scripts/set-secrets.js
```

Or set manually in Cloudflare dashboard:
**Pages** → your project → **Settings** → **Environment Variables** → add all three as encrypted variables under **Production**.

### 5. Deploy via GitHub

1. Push repo to `github.com/bstef/inwood-electricity`
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Get started**
3. Connect to Git → select repo
4. Build settings:
   - Build command: *(blank)*
   - Build output directory: `public`
   - Deploy command: `echo "deploy"`
5. Save and Deploy

Every `git push` to `main` triggers an automatic redeployment.

### 6. Add KV binding in dashboard

After first deploy:
- **Settings** → **Bindings** → **Add** → **KV Namespace**
- Variable name: `KV_METER_DATA`
- Select your namespace
- Save → redeploy

---

## Local Development

```bash
# Create .dev.vars with your secrets (gitignored)
cat > .dev.vars << EOF
GMAIL_CLIENT_ID=your-client-id
GMAIL_CLIENT_SECRET=your-secret
GMAIL_REFRESH_TOKEN=your-refresh-token
EOF

npm run dev
# → http://localhost:8788
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `totalEmails: 0` | Delete `meter_data_v1` key from KV namespace in dashboard, then hit `?refresh=1` |
| `OAuth error` | Refresh token expired — re-run OAuth Playground flow |
| `KV_METER_DATA not defined` | KV binding not set in dashboard or `wrangler.toml` IDs missing |
| Dashboard shows "Failed to load" | Check `/api/meter-data` directly in browser for error JSON |
| Cloudflare build fails | Make sure deploy command is `echo "deploy"` and build output is `public` |
| "Too many subrequests" | Old version of `meter-data.js` — update to current version using `messages.list` |

---

## Extending

**Change cache TTL** — edit `CACHE_TTL_SECONDS` in `functions/api/meter-data.js`

**Add a custom domain** — Cloudflare Pages → Custom domains → point `electricity.yourdomain.com`

**Home Assistant sensor** — call `/api/meter-data` from a HA REST sensor to pull latest readings into your dashboard

**Slack/email alerts** — add a Cloudflare Cron Trigger that checks latest reading and pings you if over a threshold
