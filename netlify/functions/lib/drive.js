// netlify/functions/lib/drive.js
//
// ============================================================================
// Reusable Google Drive service (Disclosure Intake Pipeline — see
// DISCLOSURE-INTAKE-PIPELINE.md). The ONE place that talks to Drive: the
// watcher/producer and every consumer import from here so nobody re-implements
// auth or REST plumbing.
// ============================================================================
// Auth is a service-account JWT (RS256) exchanged for an access token — the
// exact mechanism proven by netlify/functions/drive-selftest.js. Zero npm deps:
// Node's built-in `crypto` + global `fetch`.
//
// Env: GOOGLE_SA_JSON = the full service-account JSON key (loaded lazily, so
// requiring this module never throws when the env is absent, e.g. in a local
// load test).
//
// Every call sets supportsAllDrives/includeItemsFromAllDrives so it works in a
// My Drive folder today and a Shared Drive later with no code change.
// ============================================================================

const crypto = require('crypto');

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Default field set we read for a file — enough to build an event envelope.
const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime,parents,webViewLink';

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

// Token cache lives across warm invocations; refresh a minute before expiry.
let _token = { value: null, exp: 0 };

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_token.value && _token.exp - 60 > now) return _token.value;

  const creds = loadCreds();
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: creds.client_email, scope: DRIVE_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  // Domain-wide delegation: when GOOGLE_IMPERSONATE_SUBJECT is set (a Workspace
  // user email), the SA mints its token AS that user, so files it creates are
  // owned by that user's Drive (which has storage quota). Without this, a service
  // account cannot create files in My Drive: "Service Accounts do not have storage
  // quota." Requires authorizing the SA's client_id + the drive scope in the
  // Workspace Admin console (Security > API Controls > Domain-wide Delegation).
  // Unset -> no impersonation (unchanged behavior), so this is inert until configured.
  const subject = process.env.GOOGLE_IMPERSONATE_SUBJECT;
  if (subject) claim.sub = subject;
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
    throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  _token = { value: data.access_token, exp: now + (data.expires_in || 3600) };
  return _token.value;
}

async function authHeader() {
  return { Authorization: `Bearer ${await getAccessToken()}` };
}

// Run a Drive `files.list` query, following paging to completion.
async function queryFiles(q, fields = `files(${FILE_FIELDS}),nextPageToken`, pageSize = 100) {
  const headers = await authHeader();
  const out = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q, fields, pageSize: String(pageSize),
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`${DRIVE_FILES}?${params}`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`drive list failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
    out.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

// Escape a value for use inside a Drive query string literal.
function qEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Every folder with this exact name the service account can see (e.g. "Incoming").
async function findFoldersByName(name) {
  return queryFiles(
    `name='${qEscape(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`,
    'files(id,name,parents),nextPageToken'
  );
}

// Files directly inside a folder. Pass mimeType to filter (or excludeFolders to
// drop subfolders, e.g. the _processed/ folder).
async function listChildren(folderId, { mimeType, excludeFolders = false } = {}) {
  let q = `'${qEscape(folderId)}' in parents and trashed=false`;
  if (mimeType) q += ` and mimeType='${qEscape(mimeType)}'`;
  if (excludeFolders) q += ` and mimeType!='${FOLDER_MIME}'`;
  return queryFiles(q);
}

async function getFileMeta(fileId, fields = FILE_FIELDS) {
  const headers = await authHeader();
  const res = await fetch(`${DRIVE_FILES}/${encodeURIComponent(fileId)}?${new URLSearchParams({ fields, supportsAllDrives: 'true' })}`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`drive getFileMeta failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Download a file's bytes as a Buffer.
async function download(fileId) {
  const headers = await authHeader();
  const res = await fetch(`${DRIVE_FILES}/${encodeURIComponent(fileId)}?${new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' })}`, { headers });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`drive download failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

let _boundarySeq = 0;

// Create a file in `parents` from `bytes` (Buffer). Multipart so metadata +
// content go in one request.
async function uploadMultipart({ name, parents, mimeType = 'application/pdf', bytes }) {
  const headers = await authHeader();
  const boundary = `mtc_intake_${Date.now()}_${_boundarySeq++}`;
  const meta = { name, parents: Array.isArray(parents) ? parents : [parents] };
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, 'utf8');
  const post = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  const body = Buffer.concat([pre, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), post]);

  const url = `${DRIVE_UPLOAD}?${new URLSearchParams({ uploadType: 'multipart', supportsAllDrives: 'true', fields: 'id,name,parents' })}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`drive upload failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Reparent a file (Drive preserves the fileId across the move).
async function moveFile(fileId, { addParents = [], removeParents = [] } = {}) {
  const headers = await authHeader();
  const params = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,parents' });
  if (addParents.length) params.set('addParents', addParents.join(','));
  if (removeParents.length) params.set('removeParents', removeParents.join(','));
  const res = await fetch(`${DRIVE_FILES}/${encodeURIComponent(fileId)}?${params}`, { method: 'PATCH', headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`drive move failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Get-or-create a subfolder by name under a parent.
async function ensureFolder(name, parentId) {
  const existing = await queryFiles(
    `name='${qEscape(name)}' and '${qEscape(parentId)}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
    'files(id,name),nextPageToken'
  );
  if (existing.length) return existing[0];
  const headers = await authHeader();
  const res = await fetch(`${DRIVE_FILES}?${new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name' })}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parentId], mimeType: FOLDER_MIME }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`drive ensureFolder failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

module.exports = {
  getAccessToken,
  findFoldersByName,
  listChildren,
  getFileMeta,
  download,
  uploadMultipart,
  moveFile,
  ensureFolder,
};
