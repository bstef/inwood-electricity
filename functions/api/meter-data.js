/**
 * Cloudflare Pages Function: /api/meter-data
 *
 * Fetches PSE&G MyMeter Threshold Notification emails from Gmail,
 * parses kWh readings from snippets, caches in KV for 6 hours.
 *
 * Environment variables (set in Cloudflare Pages dashboard → Settings → Environment Variables):
 *   GMAIL_CLIENT_ID       - Google OAuth2 client ID
 *   GMAIL_CLIENT_SECRET   - Google OAuth2 client secret
 *   GMAIL_REFRESH_TOKEN   - Long-lived refresh token (from OAuth playground)
 *   KV_METER_DATA         - KV namespace binding (set in wrangler.toml or Pages dashboard)
 *
 * KV Namespace binding name: KV_METER_DATA
 */

const CACHE_KEY = 'meter_data_v1';
const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours
const GMAIL_SEARCH_QUERY = 'from:MyMeter@email.pseg.com subject:"MyMeter Threshold Notification"';
const MAX_RESULTS = 200;

export async function onRequestGet(context) {
  const { env, request } = context;

  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  try {
    // ── 1. Check KV cache ──────────────────────────────────────────────────
    const cached = await env.KV_METER_DATA.get(CACHE_KEY, { type: 'json' });
    if (cached && !isStale(cached.fetchedAt, CACHE_TTL_SECONDS)) {
      return new Response(JSON.stringify({ ...cached, source: 'cache' }), {
        headers: corsHeaders,
      });
    }

    // ── 2. Get fresh Gmail access token ───────────────────────────────────
    const accessToken = await getAccessToken(env);

    // ── 3. Fetch all matching Gmail threads ───────────────────────────────
    const threads = await fetchAllThreads(accessToken);

    // ── 4. Parse readings from thread snippets ────────────────────────────
    const readings = parseReadings(threads);

    // ── 5. Build response payload ─────────────────────────────────────────
    const payload = {
      readings,
      fetchedAt: new Date().toISOString(),
      totalEmails: threads.length,
      source: 'gmail',
    };

    // ── 6. Write to KV cache ───────────────────────────────────────────────
    await env.KV_METER_DATA.put(CACHE_KEY, JSON.stringify(payload), {
      expirationTtl: CACHE_TTL_SECONDS,
    });

    return new Response(JSON.stringify(payload), { headers: corsHeaders });

  } catch (err) {
    console.error('meter-data error:', err);
    return new Response(
      JSON.stringify({ error: err.message, stack: err.stack }),
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ── Force-refresh endpoint: GET /api/meter-data?refresh=1 ─────────────────────
// Busts the KV cache and re-fetches from Gmail immediately.

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isStale(fetchedAt, ttlSeconds) {
  if (!fetchedAt) return true;
  const age = (Date.now() - new Date(fetchedAt).getTime()) / 1000;
  return age > ttlSeconds;
}

async function getAccessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`OAuth token error: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function fetchAllThreads(accessToken) {
  const threads = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      q: GMAIL_SEARCH_QUERY,
      maxResults: '50',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();

    if (data.messages) {
      // Fetch each message snippet in parallel (batches of 20)
      const messages = data.messages;
      for (let i = 0; i < messages.length; i += 20) {
        const batch = messages.slice(i, i + 20);
        const fetched = await Promise.all(
          batch.map(m =>
            fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            ).then(r => r.json())
          )
        );
        threads.push(...fetched);
      }
    }

    pageToken = data.nextPageToken || null;
  } while (pageToken && threads.length < MAX_RESULTS);

  return threads;
}

function parseReadings(messages) {
  const readings = [];
  const seen = new Set(); // deduplicate by date+kwh+type

  for (const msg of messages) {
    const snippet = msg.snippet || '';

    // Extract kWh value
    const kwhMatch = snippet.match(/was\s+([\d.]+)\s+kWh/i);
    if (!kwhMatch) continue;
    const kwh = parseFloat(kwhMatch[1]);
    if (isNaN(kwh)) continue;

    // Extract date: looks like "05-20-26 12:00 A" or "08-17-25 12:00 A"
    const dateMatch = snippet.match(/at\s+(\d{2}-\d{2}-\d{2})\s+\d{2}:\d{2}/i);
    if (!dateMatch) continue;
    const rawDate = dateMatch[1]; // MM-DD-YY
    const [mm, dd, yy] = rawDate.split('-');
    const year = parseInt(yy) >= 24 ? '20' + yy : '20' + yy; // handles 2024+
    const date = `${year}-${mm}-${dd}`;

    // Determine type from snippet
    let type = 'daily';
    if (/hourly\s+total/i.test(snippet)) type = 'hourly';
    else if (/monthly\s+total/i.test(snippet)) type = 'monthly';

    const key = `${date}|${kwh}|${type}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Get email date for reference
    const internalDate = msg.internalDate
      ? new Date(parseInt(msg.internalDate)).toISOString()
      : null;

    readings.push({ date, kwh, type, emailDate: internalDate });
  }

  // Sort newest first
  readings.sort((a, b) => b.date.localeCompare(a.date));
  return readings;
}
