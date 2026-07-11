// netlify/functions/lib/usage-log.js
//
// ============================================================================
// Per-call token-usage ledger -> Google Sheet.
// ============================================================================
// WHY: Netlify function logs are ephemeral (they age out), so the token spend
// that drives the Anthropic bill vanishes with them. This appends ONE row per
// Claude call to a Google Sheet so there is a durable, per-function cost ledger
// that survives log expiry — you can see which function is the line item.
//
// HOW: same service-account JWT pattern as lib/drive.js (Node `crypto` + global
// `fetch`, ZERO npm deps). It mints its OWN token scoped to Sheets ONLY, as the
// service account itself (no impersonation), independent of drive.js's Drive
// token — so a Sheets scope/permission problem can NEVER break the Drive
// pipeline. Every failure is swallowed (logged, never thrown): a broken ledger
// must not fail a disclosure run.
//
// INERT UNTIL CONFIGURED: with no USAGE_SHEET_ID env var, logUsage() is a no-op
// (same "inert until set" style as GOOGLE_IMPERSONATE_SUBJECT in drive.js), so
// this is safe to deploy before the Sheet exists.
//
// ----------------------------------------------------------------------------
// ONE-TIME SETUP (Megan):
//   1. Create a Google Sheet. Add a tab named "Usage" (or set USAGE_SHEET_TAB).
//      Optional header row: Timestamp | Function | Model | Effort | Input |
//      Output | CacheRead | CacheWrite | Est $ | Note
//   2. Share that Sheet as EDITOR with the service-account email — the
//      `client_email` inside GOOGLE_SA_JSON (the same SA that writes to Drive).
//   3. In Netlify env vars, set USAGE_SHEET_ID = the id from the Sheet URL
//      (…/spreadsheets/d/<THIS>/edit). Optionally USAGE_SHEET_TAB (default "Usage").
//   No Admin-console / domain-wide-delegation step is needed — the SA writes as
//   itself to a Sheet you shared with it; it isn't creating a file.
// ============================================================================

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// Anthropic list prices, USD per 1M tokens (input / output). Cache reads bill at
// ~0.1x input, cache writes at ~1.25x input. Keep this in sync with pricing.
const PRICES = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function loadCreds() {
  const raw = process.env.GOOGLE_SA_JSON;
  if (!raw) return null;
  let creds;
  try { creds = JSON.parse(raw); } catch { return null; }
  if (!creds.client_email || !creds.private_key) return null;
  return creds;
}

// Token cache across warm invocations; refresh a minute before expiry. Separate
// from drive.js's cache on purpose (different scope, no impersonation).
let _token = { value: null, exp: 0 };

async function getSheetsToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_token.value && _token.exp - 60 > now) return _token.value;

  const creds = loadCreds();
  if (!creds) return null;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: creds.client_email, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(creds.private_key).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`sheets token exchange failed (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
  }
  _token = { value: data.access_token, exp: now + (data.expires_in || 3600) };
  return _token.value;
}

// Estimate the USD cost of one call from its usage block. Unknown model -> 0
// (the row still records the raw token counts).
function estimateCost(model, u) {
  const p = PRICES[model];
  if (!p) return 0;
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const usd = (inTok * p.in + outTok * p.out + cacheRead * p.in * 0.1 + cacheWrite * p.in * 1.25) / 1e6;
  return Math.round(usd * 10000) / 10000;
}

// Append one row for a single Claude call. Never throws — a ledger failure must
// not fail the pipeline. No-op (returns false) when unconfigured.
// opts: { fn, model, usage, effort?, note? }
async function logUsage({ fn, model, usage, effort = '', note = '' } = {}) {
  try {
    const sheetId = process.env.USAGE_SHEET_ID;
    if (!sheetId) return false;                 // inert until configured
    if (!usage || typeof usage !== 'object') return false;

    const token = await getSheetsToken();
    if (!token) return false;                   // no GOOGLE_SA_JSON

    const tab = process.env.USAGE_SHEET_TAB || 'Usage';
    const row = [
      new Date().toISOString(),
      fn || '',
      model || '',
      effort || '',
      usage.input_tokens || 0,
      usage.output_tokens || 0,
      usage.cache_read_input_tokens || 0,
      usage.cache_creation_input_tokens || 0,
      estimateCost(model, usage),
      note || '',
    ];

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/`
      + `${encodeURIComponent(tab + '!A1')}:append?`
      + new URLSearchParams({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    });
    if (!res.ok) {
      console.warn(`[usage-log] append failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[usage-log] non-fatal: ${err.message}`);
    return false;
  }
}

module.exports = { logUsage, estimateCost };
