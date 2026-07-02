// netlify/functions/drive-selftest.js
//
// ============================================================================
// THROWAWAY smoke test for the Incoming Disclosure Splitter (see
// INCOMING-SPLITTER-SPEC.md). Delete this file once the splitter is verified.
// ============================================================================
// Purpose: prove, in isolation and BEFORE building anything real, that the
// Google service account works end to end against Drive — and specifically
// answer the one open risk: can the service account UPLOAD a file into a folder
// that lives in Megan's My Drive (service accounts have no storage of their own,
// so writes into a My Drive folder can fail with a quota error)?
//
// It runs five independent steps and returns a JSON diagnostic report. Each step
// is isolated so one failure still shows the results of the others. It only ever
// creates ONE tiny text file and then deletes it — it never touches real data.
//
// ZERO new npm dependencies on purpose: it mints the OAuth token itself with
// Node's built-in `crypto` (RS256-signed JWT) and calls the Drive REST API with
// the global `fetch`. So it can be added via the GitHub web editor with no
// package.json / lock-file changes.
//
// ----------------------------------------------------------------------------
// SETUP
//   Netlify env var: GOOGLE_SA_JSON = the FULL service-account JSON key (paste
//   the whole file contents).
//
// USAGE (open in a browser once deployed):
//   /.netlify/functions/drive-selftest?folderId=<TEST_INCOMING_FOLDER_ID>
//   optional: &uploadFolderId=<PROPERTY_ROOT_FOLDER_ID>   (defaults to folderId)
//
//   Get a folder ID from its Drive URL: .../folders/THIS_PART_IS_THE_ID
//   Use your TEST folder (e.g. 00 MTC Clients / _ZZ Test Agent / 123 Test St /
//   Incoming), not a real deal.
// ============================================================================

const crypto = require('crypto');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// A fixed boundary is fine — we control both parts and neither contains it.
const MULTIPART_BOUNDARY = 'mtc_selftest_boundary_2026';

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Mint a Google access token for the service account by signing a JWT (RS256)
// with the SA private key and exchanging it at the OAuth token endpoint.
async function getAccessToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: creds.client_email,
    scope: DRIVE_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  // Mirror lib/drive.js: domain-wide delegation — impersonate a Workspace user so
  // uploads land in that user's Drive (which has storage). Inert unless the env var is set.
  const subject = process.env.GOOGLE_IMPERSONATE_SUBJECT;
  if (subject) claim.sub = subject;
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(creds.private_key)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.access_token;
}

// Small helper: run a step, capture ok/result/error without throwing.
async function step(name, fn) {
  try {
    const result = await fn();
    return { step: name, ok: true, ...result };
  } catch (err) {
    return { step: name, ok: false, error: err.message };
  }
}

exports.handler = async function (event) {
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const q = event.queryStringParameters || {};
  const folderId = q.folderId || '';
  const uploadFolderId = q.uploadFolderId || folderId;

  const report = { ok: false, steps: [] };

  // --- creds -----------------------------------------------------------------
  let creds;
  try {
    if (!process.env.GOOGLE_SA_JSON) throw new Error('GOOGLE_SA_JSON env var not set');
    creds = JSON.parse(process.env.GOOGLE_SA_JSON);
    if (!creds.client_email || !creds.private_key) {
      throw new Error('GOOGLE_SA_JSON is missing client_email / private_key');
    }
  } catch (err) {
    report.steps.push({ step: 'read-credentials', ok: false, error: err.message });
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(report, null, 2) };
  }
  report.service_account = creds.client_email;
  report.project_id = creds.project_id;

  // --- 1) auth ---------------------------------------------------------------
  let token;
  const authStep = await step('1-auth', async () => {
    token = await getAccessToken(creds);
    return { note: 'access token obtained' };
  });
  report.steps.push(authStep);
  if (!authStep.ok) {
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(report, null, 2) };
  }
  const auth = { Authorization: `Bearer ${token}` };

  // --- 2) list the test folder ----------------------------------------------
  let firstFileId = null;
  report.steps.push(
    await step('2-list-folder', async () => {
      if (!folderId) return { skipped: 'no folderId query param provided' };
      const url =
        'https://www.googleapis.com/drive/v3/files?' +
        new URLSearchParams({
          q: `'${folderId}' in parents and trashed=false`,
          fields: 'files(id,name,mimeType,size)',
          pageSize: '20',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        });
      const res = await fetch(url, { headers: auth });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`list failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
      const files = data.files || [];
      const firstNonFolder = files.find((f) => f.mimeType !== 'application/vnd.google-apps.folder');
      firstFileId = firstNonFolder ? firstNonFolder.id : null;
      return {
        file_count: files.length,
        files: files.map((f) => ({ name: f.name, mimeType: f.mimeType })),
      };
    })
  );

  // --- 3) download the first file's first 1KB (proves content read) ---------
  report.steps.push(
    await step('3-download', async () => {
      if (!firstFileId) return { skipped: 'no downloadable file in the folder' };
      const url =
        `https://www.googleapis.com/drive/v3/files/${firstFileId}?` +
        new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
      const res = await fetch(url, { headers: { ...auth, Range: 'bytes=0-1023' } });
      if (!res.ok && res.status !== 206) {
        const t = await res.text().catch(() => '');
        throw new Error(`download failed (${res.status}): ${t.slice(0, 300)}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return { http_status: res.status, bytes_read: buf.length };
    })
  );

  // --- 4) THE KEY TEST: upload a tiny file into the upload target -------------
  let uploadedId = null;
  report.steps.push(
    await step('4-upload (THE KEY TEST)', async () => {
      if (!uploadFolderId) return { skipped: 'no uploadFolderId / folderId to write into' };
      const meta = { name: '_mtc_selftest_DELETE_ME.txt', parents: [uploadFolderId] };
      const body =
        `--${MULTIPART_BOUNDARY}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        `${JSON.stringify(meta)}\r\n` +
        `--${MULTIPART_BOUNDARY}\r\n` +
        'Content-Type: text/plain\r\n\r\n' +
        'MTC splitter smoke test — safe to delete.\r\n' +
        `--${MULTIPART_BOUNDARY}--`;
      const url =
        'https://www.googleapis.com/upload/drive/v3/files?' +
        new URLSearchParams({ uploadType: 'multipart', supportsAllDrives: 'true', fields: 'id,name' });
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': `multipart/related; boundary=${MULTIPART_BOUNDARY}` },
        body,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // This is the quota error we are hunting for. Surface it verbatim.
        throw new Error(`UPLOAD FAILED (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
      }
      uploadedId = data.id;
      return { uploaded_file_id: data.id, uploaded_name: data.name };
    })
  );

  // --- 5) clean up the dummy file -------------------------------------------
  report.steps.push(
    await step('5-cleanup', async () => {
      if (!uploadedId) return { skipped: 'nothing uploaded to clean up' };
      const url =
        `https://www.googleapis.com/drive/v3/files/${uploadedId}?` +
        new URLSearchParams({ supportsAllDrives: 'true' });
      const res = await fetch(url, { method: 'DELETE', headers: auth });
      if (!res.ok && res.status !== 204) {
        const t = await res.text().catch(() => '');
        throw new Error(`delete failed (${res.status}): ${t.slice(0, 200)}`);
      }
      return { deleted: true };
    })
  );

  // Overall verdict: the write step is the one that matters most.
  const uploadStep = report.steps.find((s) => s.step.startsWith('4-'));
  report.ok = report.steps.every((s) => s.ok);
  report.verdict = uploadStep && uploadStep.ok
    ? 'UPLOAD WORKS — the My Drive share is sufficient, no Shared Drive needed.'
    : 'UPLOAD did not succeed — read step 4 error. If it is a storage-quota error, move 00 MTC Clients into a Shared Drive and add the SA as a member.';

  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(report, null, 2) };
};
