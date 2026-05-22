/**
 * Cloudflare Pages Function: /api/meter-data
 * Fetches PSE&G MyMeter emails from Gmail using minimal subrequests.
 * Uses Gmail messages.list with snippet included, then parses inline.
 */

const CACHE_KEY = 'meter_data_v1';
const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours
//const GMAIL_SEARCH_QUERY = 'from:MyMeter@email.pseg.com subject:"MyMeter Threshold Notification"';
const GMAIL_SEARCH_QUERY = 'from:MyMeter@email.pseg.com';

export async function onRequestGet(context) {
  const { env, request } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Force refresh if ?refresh=1
  const url = new URL(request.url);
  const forceRefresh = url.searchParams.get('refresh') === '1';

  try {
    // 1. Check KV cache
    if (!forceRefresh) {
      const cached = await env.KV_METER_DATA.get(CACHE_KEY, { type: 'json' });
      if (cached && !isStale(cached.fetchedAt, CACHE_TTL_SECONDS)) {
        return new Response(JSON.stringify({ ...cached, source: 'cache' }), { headers: corsHeaders });
      }
    }

    // 2. Get Gmail access token
    const accessToken = await getAccessToken(env);

    // 3. Fetch message list with snippets — Gmail returns snippets in list response
    //    We paginate but each page = 1 subrequest. Max 4 pages = 4 subrequests.
    const messages = await fetchMessageList(accessToken);

    // 4. Parse readings from snippets
    const readings = parseReadings(messages);

    // 5. Build and cache payload
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

// ── Helpers ────────────────────────────────────────────────────────────────────

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
  // Gmail messages.list returns snippet in each message object.
  // Each paginated request = 1 subrequest. 500 results/page, max 4 pages.
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
    if (data.error) throw new Error(`Gmail API error: ${JSON.stringify(data.error)}`);
    if (!data.messages || data.messages.length === 0) break;

    // messages.list only returns id + threadId — we need snippets
    // So we fetch each page of IDs using a single threads.list call
    // which DOES include snippets, limiting to 1 subrequest per page
    const snippetData = await fetchSnippetsForIds(accessToken, data.messages.map(m => m.id));
    allMessages.push(...snippetData);

    pageToken = data.nextPageToken || null;
    pages++;
  } while (pageToken && pages < 4);

  return allMessages;
}

async function fetchSnippetsForIds(accessToken, ids) {
  // Use a single Gmail search filtered to these specific message IDs
  // by fetching the thread list which includes snippets natively
  // This costs exactly 1 subrequest for all IDs in the batch
  const results = [];

  // Build a single query with all IDs using rfc822msgid isn't reliable,
  // so instead we use Gmail's messages.get with fields=snippet,internalDate
  // but batched into a single multipart HTTP request (1 subrequest total)
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

  // Parse each JSON object out of the multipart response
  const jsonRegex = /\{[^{}]*"snippet"[^{}]*\}/g;
  let match;
  while ((match = jsonRegex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj.snippet) results.push(obj);
    } catch (_) { }
  }

  // Fallback: if batch parsing failed, return raw text blocks for snippet extraction
  if (results.length === 0) {
    const snippetRegex = /"snippet"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    const dateRegex = /"internalDate"\s*:\s*"(\d+)"/g;
    const snippets = [...text.matchAll(/"snippet"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
    const dates = [...text.matchAll(/"internalDate"\s*:\s*"(\d+)"/g)];
    snippets.forEach((s, i) => {
      results.push({
        snippet: s[1].replace(/\\n/g, ' ').replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'),
        internalDate: dates[i] ? dates[i][1] : null,
      });
    });
  }

  return results;
}

function parseReadings(messages) {
  const readings = [];
  const seen = new Set();

  for (const msg of messages) {
    const snippet = (msg.snippet || '').replace(/\\n/g, ' ');

    // Extract kWh value: "was 21.81 kWh"
    const kwhMatch = snippet.match(/was\s+([\d.]+)\s+kWh/i);
    if (!kwhMatch) continue;
    const kwh = parseFloat(kwhMatch[1]);
    if (isNaN(kwh)) continue;

    // Extract date: "at 05-20-26 12:00"
    const dateMatch = snippet.match(/at\s+(\d{2}-\d{2}-\d{2})\s+\d{2}:\d{2}/i);
    if (!dateMatch) continue;
    const [mm, dd, yy] = dateMatch[1].split('-');
    const year = '20' + yy;
    const date = `${year}-${mm}-${dd}`;

    // Detect type
    let type = 'daily';
    if (/hourly\s+total/i.test(snippet)) type = 'hourly';
    else if (/monthly\s+total/i.test(snippet)) type = 'monthly';

    const key = `${date}|${kwh}|${type}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const emailDate = msg.internalDate
      ? new Date(parseInt(msg.internalDate)).toISOString()
      : null;

    readings.push({ date, kwh, type, emailDate });
  }

  readings.sort((a, b) => b.date.localeCompare(a.date));
  return readings;
}
