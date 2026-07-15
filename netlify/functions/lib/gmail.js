// netlify/functions/lib/gmail.js
//
// ============================================================================
// Reusable Gmail service (Email Router — see EMAIL-ROUTER-SPEC.md). The ONE
// place that talks to Gmail: the router poller and every consumer import from
// here so nobody re-implements auth or REST plumbing. Modeled on lib/drive.js.
// ============================================================================
// Auth is the SAME service-account JWT (RS256 -> access token) proven by
// lib/drive.js, but scoped to Gmail and — unlike Drive — it MUST impersonate the
// mailbox owner. A service account has no mailbox of its own, so every Gmail
// call runs AS a Workspace user via domain-wide delegation (the JWT `sub`).
//
//   REQUIRED ONE-TIME ADMIN STEP (Megan / Workspace admin):
//   Security > API Controls > Domain-wide Delegation > add the SA's client_id
//   with scope:  https://www.googleapis.com/auth/gmail.modify
//   (gmail.modify = read messages + add/remove labels + mark read. It does NOT
//    allow permanent delete, which we never do.)
//
// Env:
//   GOOGLE_SA_JSON              — full service-account JSON key (shared w/ Drive).
//   GMAIL_IMPERSONATE_SUBJECT   — the mailbox to act as (e.g. megan@mytcconcierge.com).
//                                 Falls back to GOOGLE_IMPERSONATE_SUBJECT so it can
//                                 share Drive's subject if they are the same user.
//
// INERT UNTIL CONFIGURED: requiring this module never throws. Creds/subject are
// read lazily on first API call, so a load test (`require('./lib/gmail')`) is
// safe with no env set — same discipline as drive.js / usage-log.js.
// ============================================================================

const crypto = require('crypto');

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// gmail.modify: read + label + mark-read. Never gmail.readonly (can't label) and
// never full https://mail.google.com/ (grants permanent delete we don't want).
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function loadCreds() {
  if (!process.env.GOOGLE_SA_JSON) throw new Error('GOOGLE_SA_JSON env var not set');
  let creds;
  try {
    creds = JSON.parse(process.env.GOOGLE_SA_JSON);
  } catch (err) {
    throw new Error('GOOGLE_SA_JSON is not valid JSON');
  }
  if (!creds.client_email || !creds.private_key) {
    throw new Error('GOOGLE_SA_JSON missing client_email / private_key');
  }
  return creds;
}

// The mailbox we act as. Gmail REST uses this as the {userId} path segment; with
// domain-wide delegation the token is already minted AS this user, so 'me' also
// works — we pass the explicit address so a misconfig fails loudly, not silently
// against the wrong box.
function subject() {
  const sub = process.env.GMAIL_IMPERSONATE_SUBJECT || process.env.GOOGLE_IMPERSONATE_SUBJECT;
  if (!sub) throw new Error('GMAIL_IMPERSONATE_SUBJECT (or GOOGLE_IMPERSONATE_SUBJECT) not set — Gmail needs a mailbox to impersonate');
  return sub;
}

// Token cache lives across warm invocations; refresh a minute before expiry.
// Keyed by subject so switching mailboxes can't reuse the wrong token.
let _token = { value: null, exp: 0, sub: null };

async function getAccessToken() {
  const sub = subject();
  const now = Math.floor(Date.now() / 1000);
  if (_token.value && _token.sub === sub && _token.exp - 60 > now) return _token.value;

  const creds = loadCreds();
  const header = { alg: 'RS256', typ: 'JWT' };
  // sub = the impersonated mailbox. Requires the SA's client_id + gmail.modify
  // scope authorized in the Workspace Admin console (see file header).
  const claim = { iss: creds.client_email, sub, scope: GMAIL_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
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
    throw new Error(`gmail token exchange failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  _token = { value: data.access_token, exp: now + (data.expires_in || 3600), sub };
  return _token.value;
}

async function authHeader() {
  return { Authorization: `Bearer ${await getAccessToken()}` };
}

function apiBase() {
  return `${GMAIL_API}/${encodeURIComponent(subject())}`;
}

async function apiGet(path, params) {
  const headers = await authHeader();
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  const res = await fetch(`${apiBase()}${path}${qs}`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gmail GET ${path} failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function apiPost(path, body) {
  const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
  const res = await fetch(`${apiBase()}${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gmail POST ${path} failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// ----------------------------------------------------------------------------
// LABELS
// ----------------------------------------------------------------------------

// Label list is stable within an invocation; cache it so ensureLabel/name lookups
// during one poll don't re-fetch. Cleared implicitly on cold start.
let _labelCache = null;

async function listLabels({ fresh = false } = {}) {
  if (_labelCache && !fresh) return _labelCache;
  const data = await apiGet('/labels');
  _labelCache = data.labels || [];
  return _labelCache;
}

// name -> label object, case-insensitive on the display name.
async function labelByName(name, opts) {
  const labels = await listLabels(opts);
  const lc = String(name).toLowerCase();
  return labels.find((l) => (l.name || '').toLowerCase() === lc) || null;
}

// Resolve a display name to its label id, or throw if it doesn't exist. Use for
// labels we expect the owner to have created (the intake label, category labels).
async function labelId(name) {
  const l = await labelByName(name);
  if (!l) throw new Error(`gmail label not found: "${name}" — create it in Gmail or fix the routing config`);
  return l.id;
}

// Resolve a name to an id, creating the label if it doesn't exist. Use for labels
// WE own (person labels, "Needs Attention") so a fresh install self-provisions.
async function ensureLabel(name) {
  const existing = await labelByName(name);
  if (existing) return existing.id;
  const created = await apiPost('/labels', {
    name,
    labelListVisibility: 'labelShow',
    messageListVisibility: 'show',
  });
  _labelCache = null; // invalidate so the new label is visible to later lookups
  return created.id;
}

// ----------------------------------------------------------------------------
// MESSAGES
// ----------------------------------------------------------------------------

// List message ids carrying a label (by id) and/or matching a Gmail search `q`.
// Returns [{ id, threadId }]. Follows paging up to maxPages as a safety cap.
async function listMessages({ labelIds = [], q, maxPages = 10, pageSize = 100 } = {}) {
  const out = [];
  let pageToken;
  let pages = 0;
  do {
    const params = { maxResults: String(pageSize) };
    if (q) params.q = q;
    // Gmail wants repeated labelIds params; URLSearchParams handles arrays via append.
    const sp = new URLSearchParams(params);
    for (const id of labelIds) sp.append('labelIds', id);
    if (pageToken) sp.set('pageToken', pageToken);
    const headers = await authHeader();
    const res = await fetch(`${apiBase()}/messages?${sp}`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`gmail messages.list failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
    out.push(...(data.messages || []));
    pageToken = data.nextPageToken;
  } while (pageToken && ++pages < maxPages);
  return out;
}

// Decode a base64url body part to a UTF-8 string.
function decodePart(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Walk a MIME tree collecting the first text/plain and first text/html we find.
function collectBodies(payload, acc = { plain: '', html: '' }) {
  if (!payload) return acc;
  const mime = payload.mimeType || '';
  const body = payload.body || {};
  if (mime === 'text/plain' && !acc.plain) acc.plain = decodePart(body.data);
  else if (mime === 'text/html' && !acc.html) acc.html = decodePart(body.data);
  for (const part of payload.parts || []) collectBodies(part, acc);
  return acc;
}

// Walk the MIME tree collecting real attachments on THIS message: parts that
// carry a filename and an attachmentId. Gmail does NOT re-attach a previous
// email's files when you reply, so parts-with-filename here = attachments on the
// CURRENT (newest) message — exactly what rule 2 of the skip gate needs. Inline
// images referenced by the body (Content-Disposition: inline) are excluded.
function collectAttachments(payload, acc = []) {
  if (!payload) return acc;
  const body = payload.body || {};
  const filename = payload.filename || '';
  const disp = ((payload.headers || []).find((h) => h.name && h.name.toLowerCase() === 'content-disposition') || {}).value || '';
  const isInline = /inline/i.test(disp);
  if (filename && body.attachmentId && !isInline) {
    acc.push({ filename, mimeType: payload.mimeType || '', size: body.size || 0 });
  }
  for (const part of payload.parts || []) collectAttachments(part, acc);
  return acc;
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const HEADER_KEYS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Reply-To', 'Message-ID', 'In-Reply-To', 'References'];

function pickHeaders(payload) {
  const h = {};
  for (const { name, value } of (payload && payload.headers) || []) {
    if (HEADER_KEYS.includes(name)) h[name.toLowerCase()] = value;
  }
  return h;
}

// Heuristic: split a plain-text body into the NEWEST message vs the quoted
// thread history below it. The 14-rule gate scopes some rules to "the newest
// message only", so we surface both. We cut at the first common reply marker
// (Gmail "On <date> ... wrote:", Outlook "From:" block, or a ">" quote run).
// Best-effort: if no marker is found, the whole body is treated as newest.
function splitNewest(text) {
  const t = String(text || '');
  const markers = [
    /^\s*On .+ wrote:\s*$/m,                 // Gmail
    /^\s*-{2,}\s*Original Message\s*-{2,}/im, // classic
    /^\s*From:\s.+$/m,                        // Outlook forward/reply block
    /^\s*_{5,}\s*$/m,                         // Outlook divider line
    /^\s*>{1,}/m,                             // quoted run
  ];
  let cut = t.length;
  for (const re of markers) {
    const m = t.match(re);
    if (m && m.index != null && m.index < cut) cut = m.index;
  }
  const newest = t.slice(0, cut).trim();
  const history = t.slice(cut).trim();
  return { newest: newest || t.trim(), history };
}

// Fetch one message and shape it for the router/gate. `format: 'full'` gives us
// the MIME tree + headers in one call.
async function getMessage(id) {
  const data = await apiGet(`/messages/${encodeURIComponent(id)}`, { format: 'full' });
  const headers = pickHeaders(data.payload);
  const bodies = collectBodies(data.payload);
  const bodyText = bodies.plain || (bodies.html ? stripHtml(bodies.html) : '');
  const { newest, history } = splitNewest(bodyText);
  const attachments = collectAttachments(data.payload);
  return {
    id: data.id,
    threadId: data.threadId,
    labelIds: data.labelIds || [],
    snippet: data.snippet || '',
    internalDate: data.internalDate || null, // ms epoch as string
    headers,          // { from, subject, date, ... } lowercased keys
    bodyText,         // full decoded body (newest + quoted history)
    newestText: newest, // just the newest message, for history-scoped rules
    historyText: history,
    attachments,      // real attachments on the CURRENT message (rule 2)
    hasAttachment: attachments.length > 0,
    isUnread: (data.labelIds || []).includes('UNREAD'),
  };
}

// ----------------------------------------------------------------------------
// MUTATIONS
// ----------------------------------------------------------------------------

// Add and/or remove labels by id. addLabelIds / removeLabelIds are label-id
// arrays (use labelId()/ensureLabel() to resolve names first).
async function modifyMessage(id, { add = [], remove = [] } = {}) {
  return apiPost(`/messages/${encodeURIComponent(id)}/modify`, {
    addLabelIds: add,
    removeLabelIds: remove,
  });
}

// Mark read = remove the system UNREAD label.
async function markRead(id) {
  return modifyMessage(id, { remove: ['UNREAD'] });
}

module.exports = {
  // auth / low-level
  getAccessToken,
  subject,
  // labels
  listLabels,
  labelByName,
  labelId,
  ensureLabel,
  // messages
  listMessages,
  getMessage,
  // mutations
  modifyMessage,
  markRead,
  // exposed for unit tests
  _internal: { stripHtml, splitNewest, collectBodies, collectAttachments, pickHeaders },
};
