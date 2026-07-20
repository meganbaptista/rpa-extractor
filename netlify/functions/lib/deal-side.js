// netlify/functions/lib/deal-side.js
//
// ============================================================================
// Deal-side lookup (Email Router — see EMAIL-ROUTER-SPEC.md).
// ============================================================================
// Which side WE represent (buyer/seller) is a per-DEAL fact, not something an
// individual email reliably states — and Gmail's per-thread side labels can't
// carry it across a deal's many threads. This reads the owner's existing
// "MTC INFORMATION" Google Sheet (Property Address + Representation columns) and
// matches an email's property address (from the subject) to the deal's side, so
// the router has a reliable side signal on EVERY email about a deal.
//
// Same service-account Sheets auth as usage-log.js (READ-ONLY scope, no
// impersonation). Zero npm deps. INERT until configured: with no DEALS_SHEET_ID
// env var, sideForSubject() returns null and nothing breaks.
//
// ----------------------------------------------------------------------------
// SETUP (Megan):
//   1. Share the "MTC INFORMATION" sheet as VIEWER with the service-account
//      email (the client_email inside GOOGLE_SA_JSON).
//   2. Netlify env: DEALS_SHEET_ID = the id from the sheet URL
//      (…/spreadsheets/d/<THIS>/edit). Optional: DEALS_SHEET_TAB (the tab name,
//      if the deals aren't on the first tab), DEAL_ADDRESS_HEADER (default
//      "Property Address"), DEAL_REP_HEADER (default "Representation").
// ============================================================================

const crypto = require('crypto');
const { canonicalAddress } = require('./address');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

const DEAL_TTL_MS = 10 * 60 * 1000; // re-read the sheet at most every 10 min

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

let _token = { value: null, exp: 0 };
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_token.value && _token.exp - 60 > now) return _token.value;
  const creds = loadCreds();
  if (!creds) return null;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: creds.client_email, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned); signer.end();
  const signature = signer.sign(creds.private_key).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`deals sheet token exchange failed (${res.status})`);
  _token = { value: data.access_token, exp: now + (data.expires_in || 3600) };
  return _token.value;
}

// Representation cell -> 'buyer' | 'seller' | null. Dual agency / blank / "-"
// return null (no clean single side; the classifier infers from content).
function normalizeSide(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s || s === '-') return null;
  if (/dual/.test(s)) return null;
  if (/buyer|buy|^br$|buyer\s*rep/.test(s)) return 'buyer';
  if (/seller|sell|listing|^la$|^list/.test(s)) return 'seller';
  return null;
}

// A deal STATUS cell -> true if the deal is CLOSED or CANCELLED. Such rows are
// excluded from the side lookup so a stale or relisted property (e.g. closed on
// the buyer side in 2025, active on the seller side in 2026) resolves to the
// CURRENT active row's side, not the dead one.
function isInactiveStatus(v) {
  return /closed|cancel/i.test(String(v == null ? '' : v));
}

// A distinctive match key for an address: leading street number + first real
// street-name word (skipping directionals like N/S/E/W). Both must appear in an
// email subject to count as a match, which keeps false positives low.
const DIRECTIONALS = new Set(['n', 's', 'e', 'w', 'north', 'south', 'east', 'west']);

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-token presence test (bounded by non-word chars), NOT a substring test.
// This is why a deal at "419 …" never matches "1419 …" (the "419" inside "1419"
// has a digit on its left, so it isn't a token boundary) and "pacific" never
// matches "pacifica". Both the street number and the street word must pass.
function containsToken(haystack, token) {
  if (!token) return false;
  return new RegExp(`\\b${escapeRegex(token)}\\b`, 'i').test(haystack);
}

function addressKeyParts(address) {
  const m = String(address || '').match(/(\d+)\s+(.*)/);
  if (!m) return null;
  const num = m[1];
  const words = m[2].toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const streetWord = words.find((w) => w.length > 1 && !DIRECTIONALS.has(w));
  if (!streetWord) return null;
  return { num, streetWord };
}

// Extract deals from ONE tab's rows (each yearly tab has its own header row).
function parseTab(rows) {
  if (!rows || !rows.length) return [];
  const header = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const addrHeader = (process.env.DEAL_ADDRESS_HEADER || 'Property Address').toLowerCase();
  const repHeader = (process.env.DEAL_REP_HEADER || 'Representation').toLowerCase();
  const statusHeader = (process.env.DEAL_STATUS_HEADER || 'Status').toLowerCase();
  const ai = header.indexOf(addrHeader) >= 0 ? header.indexOf(addrHeader) : header.findIndex((h) => h.includes('address'));
  const ri = header.indexOf(repHeader) >= 0 ? header.indexOf(repHeader) : header.findIndex((h) => h.includes('represent'));
  // STATUS lives in a LABELED column on the current-year tab (e.g. "STATUS" in
  // column H) but in the UNLABELED first column on the older yearly tabs. So use
  // the labeled column when present, else fall back to column 0. On the
  // current-year tab column 0 is a NAME, which never reads as a status, so the
  // fallback only kicks in on the older layout where column 0 truly is the status.
  const sti = header.indexOf(statusHeader) >= 0 ? header.indexOf(statusHeader) : header.findIndex((h) => h.includes('status'));
  if (ai < 0 || ri < 0) {
    console.warn(`[deal-side] address/representation columns not found in header: ${JSON.stringify(rows[0])}`);
    return [];
  }
  const out = [];
  for (const row of rows.slice(1)) {
    // Drop CLOSED/CANCELLED deals so they can't win the address match over the
    // current active row for a relisted property.
    const statusCell = sti >= 0 ? row[sti] : row[0];
    if (isInactiveStatus(statusCell)) continue;
    const side = normalizeSide(row[ri]);
    const address = row[ai];
    if (!side || !address) continue;
    const parts = addressKeyParts(address);
    if (!parts) continue;
    out.push({ side, address, num: parts.num, streetWord: parts.streetWord });
  }
  return out;
}

// Which tabs to read. Explicit DEALS_SHEET_TAB wins; otherwise the CURRENT and
// PREVIOUS calendar year (e.g. "2026","2025"), so the yearly rollover is
// automatic — no reminder needed — as long as each year's tab is the 4-digit
// year. Only tabs that actually exist are returned. DEALS_YEAR_TABS=false pins
// to the first tab (legacy single-tab behavior).
function targetTabs(existingTabs) {
  const explicit = process.env.DEALS_SHEET_TAB;
  if (explicit) return existingTabs.includes(explicit) ? [explicit] : [];
  if (process.env.DEALS_YEAR_TABS === 'false') return existingTabs.slice(0, 1);
  const year = new Date().getFullYear();
  return [String(year), String(year - 1)].filter((t) => existingTabs.includes(t));
}

async function listTabs(id, token) {
  const res = await fetch(`${SHEETS_API}/${id}?fields=sheets.properties.title`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`deals sheet meta failed (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
  return (data.sheets || []).map((s) => s.properties && s.properties.title).filter(Boolean);
}

// deals cache: { list: [...], tabs: [...], count, error }
let _deals = { at: 0, list: null, tabs: [], count: 0, error: null };

async function loadDeals() {
  const now = Date.now();
  if (_deals.list && now - _deals.at < DEAL_TTL_MS) return _deals.list;

  const reset = (patch) => { _deals = { at: now, list: [], tabs: [], count: 0, error: null, ...patch }; return _deals.list; };
  const id = process.env.DEALS_SHEET_ID;
  if (!id) return reset({});
  const token = await getToken();
  if (!token) return reset({ error: 'no GOOGLE_SA_JSON' });

  try {
    const existing = await listTabs(id, token);
    const tabs = targetTabs(existing);
    if (!tabs.length) return reset({ error: `no matching tab (have: ${existing.join(', ')})` });

    const ranges = tabs.map((t) => `ranges=${encodeURIComponent(`${t}!A1:Z5000`)}`).join('&');
    const res = await fetch(`${SHEETS_API}/${id}/values:batchGet?${ranges}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`deals batchGet failed (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);

    const list = [];
    for (const vr of data.valueRanges || []) list.push(...parseTab(vr.values));
    _deals = { at: now, list, tabs, count: list.length, error: null };
    return list;
  } catch (err) {
    return reset({ error: err.message });
  }
}

// Health: { configured, tabs, count, error } — surfaced in the dry-run so a
// broken/empty deal list is visible without a separate check.
async function status() {
  if (!process.env.DEALS_SHEET_ID) return { configured: false, tabs: [], count: 0, error: null };
  await loadDeals();
  return { configured: true, tabs: _deals.tabs, count: _deals.count, error: _deals.error };
}

// The side we represent for the deal this subject refers to, or null. Matches by
// street number + street word; on multiple matches the most specific wins.
// Best-effort: any error returns null (never breaks routing).
async function sideForSubject(subject) {
  try {
    if (!subject) return null;
    const list = await loadDeals();
    if (!list.length) return null;
    const subj = String(subject).toLowerCase();
    let best = null;
    for (const d of list) {
      if (containsToken(subj, d.num) && containsToken(subj, d.streetWord)) {
        const score = d.num.length + d.streetWord.length;
        if (!best || score > best.score) best = { side: d.side, score };
      }
    }
    return best ? best.side : null;
  } catch (err) {
    console.warn(`[deal-side] sideForSubject failed (non-fatal): ${err.message}`);
    return null;
  }
}

module.exports = { sideForSubject, status, _internal: { normalizeSide, addressKeyParts, loadDeals, targetTabs, parseTab } };
