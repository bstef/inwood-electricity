/**
 * Cloudflare Pages Function: /api/meter-data
 * Debug version — returns raw Gmail API responses for troubleshooting
 */

const CACHE_KEY = 'meter_data_v1';
const CACHE_TTL_SECONDS = 6 * 60 * 60;
const GMAIL_SEARCH_QUERY = 'from:MyMeter@email.pseg.com';

export async function onRequestGet(context) {
  const { env, request } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  const url = new URL(request.url);
  const forceRefresh = url.searchParams.get('refresh') === '1';
  const debug = url.searchParams.get('debug') === '1';

  try {
    // Skip cache entirely if refresh=1 or debug=1
    if (!forceRefresh && !debug) {
      const cached = await env.KV_METER_DATA.get(CACHE_KEY, { type: 'json' });
      if (cached && !isStale(cached.fetchedAt, CACHE_TTL_SECONDS)) {
        return new Response(JSON.stringify({ ...cached, source: 'cache' }), { headers: corsHeaders });
      }
    }

    // Get access token
    const accessToken = await getAccessToken(env);

    // Debug mode — return raw Gmail API response
    if (debug) {
      const params = new URLSearchParams({
        q: GMAIL_SEARCH_QUERY,
        maxResults: '10',
      });
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const raw = await res.json();

      // Also try fetching first message snippet if any found
      let firstSnippet = null;
      if (raw.messages && raw.messages.length > 0) {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${raw.messages[0].id}?fields=snippet,internalDate`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        firstSnippet = await msgRes.json();
      }

      return new Response(JSON.stringify({
        debug: true,
        query: GMAIL_SEARCH_QUERY,
        gmailResponse: raw,
        firstSnippet,
        accessTokenPreview: accessToken.slice(0, 20) + '...',
      }), { headers: corsHeaders });
    }

    // Normal flow
    const messages = await fetchMessageList(accessToken);
    const readings = parseReadings(messages);

    const payload = {
      readings,
      fetchedAt: new Date().toISOString(),
      totalEmails: messages.length,
      source: 'gmail',
    };

    await env.KV_METER_DATA.put(CACHE_KEY, JSON.stringify(payload), {
      expirationTtl: CACHE_TTL_SECONDS,
    });

    return new Response(JSON.stringify(payload), { headers: corsHeaders });

  } catch (err) {
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

function isStale(fetchedAt, ttlSeconds) {
  if (!fetchedAt) return true;
  return (Date.now() - new Date(fetchedAt).getTime()) / 1000 > ttlSeconds;
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
  if (!data.access_token) throw new Error(`OAuth error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function fetchMessageList(accessToken) {
  const allMessages = [];
  let pageToken = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({
      q: GMAIL_SEARCH_QUERY,
      maxResults: '500',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    if (data.error) throw new Error(`Gmail API: ${JSON.stringify(data.error)}`);
    if (!data.messages || data.messages.length === 0) break;

    const snippetData = await fetchSnippetsForIds(accessToken, data.messages.map(m => m.id));
    allMessages.push(...snippetData);

    pageToken = data.nextPageToken || null;
    pages++;
  } while (pageToken && pages < 4);

  return allMessages;
}

async function fetchSnippetsForIds(accessToken, ids) {
  const results = [];
  const boundary = 'batch_boundary_xyz';
  const batchBody = ids.map((id, i) =>
    [
      `--${boundary}`,
      'Content-Type: application/http',
      `Content-ID: <item${i}>`,
      '',
      `GET /gmail/v1/users/me/messages/${id}?fields=snippet,internalDate`,
      '',
    ].join('\r\n')
  ).join('\r\n') + `\r\n--${boundary}--`;

  const batchRes = await fetch('https://www.googleapis.com/batch/gmail/v1', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/mixed; boundary="${boundary}"`,
    },
    body: batchBody,
  });

  const text = await batchRes.text();

  const snippets = [...text.matchAll(/"snippet"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
  const dates = [...text.matchAll(/"internalDate"\s*:\s*"(\d+)"/g)];
  snippets.forEach((s, i) => {
    results.push({
      snippet: s[1].replace(/\\n/g, ' ').replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'),
      internalDate: dates[i] ? dates[i][1] : null,
    });
  });

  return results;
}

function parseReadings(messages) {
  const readings = [];
  const seen = new Set();

  for (const msg of messages) {
    const snippet = (msg.snippet || '').replace(/\\n/g, ' ');
    const kwhMatch = snippet.match(/was\s+([\d.]+)\s+kWh/i);
    if (!kwhMatch) continue;
    const kwh = parseFloat(kwhMatch[1]);
    if (isNaN(kwh)) continue;

    const dateMatch = snippet.match(/at\s+(\d{2}-\d{2}-\d{2})\s+\d{2}:\d{2}/i);
    if (!dateMatch) continue;
    const [mm, dd, yy] = dateMatch[1].split('-');
    const date = `20${yy}-${mm}-${dd}`;

    let type = 'daily';
    if (/hourly\s+total/i.test(snippet)) type = 'hourly';
    else if (/monthly\s+total/i.test(snippet)) type = 'monthly';

    const key = `${date}|${kwh}|${type}`;
    if (seen.has(key)) continue;
    seen.add(key);

    readings.push({
      date, kwh, type,
      emailDate: msg.internalDate ? new Date(parseInt(msg.internalDate)).toISOString() : null,
    });
  }

  readings.sort((a, b) => b.date.localeCompare(a.date));
  return readings;
}