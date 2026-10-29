// netlify/functions/lib/drive-share.js
//
// GOOGLE DRIVE SHARE LINKS IN A DISCLOSURE EMAIL, read as Megan's own Google
// account (the intake's Drive login, lib/drive.js).
//
// 135 S Vendome (2026-10-28): the listing side sent "the Google Drive Link with
// the Seller Disclosures, Lease Agreements, RFR with past reports/invoices, NHD
// and Prelim Title Report". Drive FOLDER links were not read at all (they
// cannot be fetched without a login), so the run saw only the offer papers,
// called all 15 disclosures missing and drafted a request for every one.
// Megan's team downloaded the files and sent them to themselves.
//
// A folder is walked with the SAME rules as a whole-folder Dropbox zip
// (lib/unzip.js): Buyer Reports / Receipts / Prelim / Permits / title folders
// are skipped unless the file's name says disclosure, explanation, addendum,
// TDS, SPQ or AVID; a prior sale's folder is skipped outright. Google Docs are
// exported as PDF. Nothing is downloaded that will not be read.
//
// A folder the account cannot open is said in plain words (a report line),
// never silently treated as "no disclosures".

const D = require('./drive');
const U = require('./unzip');

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const NATIVE = /^application\/vnd\.google-apps\.(document|spreadsheet|presentation|drawing)$/;
const MAX_FILES = 200;
const MAX_DEPTH = 5;

/** A Drive link's kind, id and resource key (newer "anyone with the link" shares carry one). */
function parseDriveLink(url) {
  const u = String(url || '').replace(/&amp;/g, '&');
  if (!/drive\.google\.com|docs\.google\.com/i.test(u)) return null;
  const key = (u.match(/[?&]resourcekey=([A-Za-z0-9_-]+)/i) || [])[1];
  const folder = (u.match(/\/folders\/([A-Za-z0-9_-]{6,})/) || [])[1];
  if (folder) return { kind: 'folder', id: folder, resourceKey: key };
  const file = (u.match(/\/(?:file|document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{6,})/) || u.match(/[?&]id=([A-Za-z0-9_-]{6,})/) || [])[1];
  if (file) return { kind: 'file', id: file, resourceKey: key };
  return null;
}

/** Drive API calls as Megan, with every resource key we know (needed for link-shared items). */
function driveApi(getToken = D.getAccessToken) {
  const keys = new Map();
  const headers = async () => {
    const h = { Authorization: `Bearer ${await getToken()}` };
    if (keys.size) h['X-Goog-Drive-Resource-Keys'] = [...keys].map(([id, k]) => `${id}/${k}`).join(',');
    return h;
  };
  const call = async (url, what) => {
    const res = await fetch(url, { headers: await headers() });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const e = new Error(`${what} failed (${res.status}): ${t.slice(0, 200)}`);
      e.status = res.status;
      throw e;
    }
    return res;
  };
  const q = (o) => new URLSearchParams({ supportsAllDrives: 'true', ...o });
  return {
    remember(id, key) { if (id && key) keys.set(id, key); },
    async meta(id) {
      return (await call(`${DRIVE_FILES}/${encodeURIComponent(id)}?${q({ fields: 'id,name,mimeType,size,resourceKey' })}`, 'open')).json();
    },
    async list(folderId) {
      const out = [];
      let pageToken;
      do {
        const p = q({ q: `'${folderId}' in parents and trashed=false`, fields: 'files(id,name,mimeType,size,resourceKey),nextPageToken', pageSize: '200', includeItemsFromAllDrives: 'true' });
        if (pageToken) p.set('pageToken', pageToken);
        const data = await (await call(`${DRIVE_FILES}?${p}`, 'list')).json();
        out.push(...(data.files || []));
        pageToken = data.nextPageToken;
      } while (pageToken);
      return out;
    },
    async download(id) {
      return Buffer.from(await (await call(`${DRIVE_FILES}/${encodeURIComponent(id)}?${q({ alt: 'media' })}`, 'download')).arrayBuffer());
    },
    async exportPdf(id) {
      return Buffer.from(await (await call(`${DRIVE_FILES}/${encodeURIComponent(id)}/export?${new URLSearchParams({ mimeType: 'application/pdf' })}`, 'export')).arrayBuffer());
    },
  };
}

const why = (err) => (err && (err.status === 404 || err.status === 403)
  ? 'it is not shared with the account Keeva reads mail as (ask the agent to share it with you, or to set it to "Anyone with the link")'
  : `Google Drive answered: ${err && err.message ? err.message.slice(0, 160) : 'an error'}`);

/**
 * One Drive link -> the documents to review: { docs: [{ name, base64 }], notes: [{ name, reason, info? }], failed }.
 * `opts`: { maxDocBytes, maxTotalBytes, isBlocked(name), api } (api is for the checks).
 */
async function expandDriveLink(link, opts = {}) {
  const api = opts.api || driveApi();
  const maxDoc = opts.maxDocBytes || Infinity;
  const maxTotal = opts.maxTotalBytes || Infinity;
  const blocked = typeof opts.isBlocked === 'function' ? opts.isBlocked : () => false;
  const docs = [];
  const notes = [];
  api.remember(link.id, link.resourceKey);
  let root;
  try { root = await api.meta(link.id); }
  catch (err) { notes.push({ name: 'Google Drive link', reason: `could not be opened: ${why(err)}` }); return { docs, notes, failed: true }; }
  api.remember(root.id, root.resourceKey);

  let planned = 0;
  let seen = 0;
  const take = async (f, path) => {
    const base = f.name || 'document';
    if (U.inPriorTransactionFolder(path)) return notes.push({ name: path, reason: 'not reviewed: in a prior-sale folder' });
    if (U.inExcludedFolder(path) && !U.RESCUE_NAME.test(base)) return notes.push({ name: path, reason: 'not reviewed: in a non-disclosure folder (reports, receipts, prelim, permits)', info: true });
    try {
      if (NATIVE.test(f.mimeType)) {
        const buf = await api.exportPdf(f.id);
        docs.push({ name: `${base}.pdf`, base64: buf.toString('base64') });
        return undefined;
      }
      const isPdf = f.mimeType === 'application/pdf' || /\.pdf$/i.test(base);
      const isZip = /zip/i.test(f.mimeType || '') || /\.zip$/i.test(base);
      if (!isPdf && !isZip) return notes.push({ name: path, reason: 'not a PDF', info: true });
      const size = Number(f.size || 0);
      // A blocked name (booklets, inspections) is still fetched: the buyer package keeps them (loadDocuments decides).
      if (isPdf && size > maxDoc && !blocked(base)) return notes.push({ name: path, reason: `too large to review (${Math.round(size / 1048576)}MB)` });
      if (planned + size > maxTotal) return notes.push({ name: path, reason: 'not downloaded: the folder is over the size budget' });
      planned += size;
      api.remember(f.id, f.resourceKey);
      const buf = await api.download(f.id);
      docs.push({ name: base, base64: buf.toString('base64') });
    } catch (err) {
      notes.push({ name: path, reason: `could not be downloaded: ${why(err)}` });
    }
    return undefined;
  };

  if (root.mimeType !== FOLDER) {
    await take(root, root.name || 'document');
    return { docs, notes, failed: docs.length === 0 };
  }

  // Breadth-first through the folder; the top folder's own name is not a path segment.
  const queue = [{ id: root.id, path: '', depth: 0 }];
  while (queue.length) {
    const { id, path, depth } = queue.shift();
    let kids;
    try { kids = await api.list(id); }
    catch (err) { notes.push({ name: path || root.name, reason: `folder could not be listed: ${why(err)}` }); continue; }
    for (const k of kids) {
      api.remember(k.id, k.resourceKey);
      const p = path ? `${path}/${k.name}` : k.name;
      if (k.mimeType === FOLDER) {
        if (depth + 1 > MAX_DEPTH) { notes.push({ name: p, reason: 'not opened: folders nested too deep' }); continue; }
        queue.push({ id: k.id, path: p, depth: depth + 1 });
        continue;
      }
      if (++seen > MAX_FILES) { notes.push({ name: root.name, reason: `stopped after ${MAX_FILES} files` }); return { docs, notes, failed: docs.length === 0 }; }
      await take(k, p);
    }
  }
  notes.push({ name: `Google Drive folder "${root.name}"`, reason: `${docs.length} file(s) read`, info: true });
  return { docs, notes, failed: docs.length === 0 };
}

module.exports = { parseDriveLink, expandDriveLink, driveApi };
