// netlify/functions/disclosure-intake-check-background.js
//
// ============================================================================
// KEEVA — Buyer-side Disclosure Intake: missing-docs check
// ============================================================================
// When we REP THE BUYER, the listing side emails the seller's disclosures (often
// across several emails, as combined PDFs or many single-form PDFs). This reads
// the incoming PDFs, identifies the REAL CAR forms actually included, accumulates
// them per deal (keyed by the property address read off the forms), and
// reconciles the running set against THAT deal's audit list (the Disclosures
// section). It reports present / still-needed / verify so a TC knows what is
// still outstanding. Non-blocking, draft/heads-up only.
//
// Mirrors the signature-audit + disclosure-review pattern: async BACKGROUND
// function (Opus is slower than Netlify's ~10s sync limit), Opus 4.8, result
// POSTed to a Zapier catch hook that updates a Process Street comment and/or
// drafts a chase email.
//
// ----------------------------------------------------------------------------
// FLOW
//   Gmail label "Buyer Signed Disclosures" -> Zapier -> POST here:
//     { auditList, documents:[{name,url?|base64?}], propertyAddress?, callbackUrl? }
//   This function:
//     1. Loads each PDF (fetched from url, or base64 in the body).
//     2. Opus identifies the REAL forms present + reads the property address.
//        (A form is only "present" if its own pages are in the package — NOT if
//         it is merely cross-referenced inside another form.)
//     3. Merges the new forms into the per-deal received-set (blob, keyed by
//        normalized address) so deliveries accumulate across emails.
//     4. Opus reconciles the accumulated set against the audit list (Disclosures
//        section), handling shorthand + conditionals.
//     5. POSTs { present, still_needed, verify, not_applicable, ps_comment } to
//        the callback (Zap B).
//
// Two integration points are intentionally INPUTS, not hard-coded, so the Zap
// wiring can be finalized separately:
//   - the audit list arrives in the request body (however Zapier supplies it).
//   - documents arrive as fetchable URLs (preferred — Netlify caps request
//     bodies ~6MB, and packages run larger) or inline base64 for small/testing.
// ============================================================================

console.log('[disclosure-intake] module loading');

const zlib = require('zlib');
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { canonicalAddress } = require('./lib/address');
const usageLog = require('./lib/usage-log');
// Crisp-render dependency: pdf-parse (pdfjs under the hood) with its CanvasFactory polyfill,
// which rasterizes pages server-side so Netlify Functions don't need the native canvas package.
// pdf-lib is deliberately NOT used here any more — see pdfPageCount() for why.
const { CanvasFactory } = require('pdf-parse/worker');
const { PDFParse } = require('pdf-parse');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';
const CALLBACK_URL_ENV = process.env.DISCLOSURE_INTAKE_CALLBACK_URL || '';

// Published-CSV URL of the master "audit lists" Google Sheet (one row per deal:
// property address + that deal's required disclosure docs). The opening
// automation writes a row; the function looks up the deal by address here. If
// unset, the audit list must be passed in the request body instead.
const AUDIT_LIST_CSV_URL = process.env.AUDIT_LIST_CSV_URL || '';

// Published-CSV URL of the "Current Form Versions" Google Sheet (form code/name ->
// current revision MM/YY). Maintained by the TC, updated ~1-2x/year as CAR releases
// new versions. The intake flags any received form whose printed revision is OLDER
// than the current. If unset, version checking is skipped.
const FORM_VERSIONS_CSV_URL = process.env.FORM_VERSIONS_CSV_URL || '';

// Per-deal accumulation lives here, keyed by normalized property address.
const STATE_STORE = 'disclosure-intake-state';

// Memoized identify() results live here, keyed by a hash of the documents themselves.
const IDENTIFY_CACHE_STORE = 'disclosure-intake-identify-cache';

// Safety cap on a single document we will pull into memory / send to the model.
const MAX_DOC_BYTES = 28 * 1024 * 1024;

// Items the BUYER side assembles in-house (title/MLS/AVID/receipts). Never request
// these from the listing side and don't count them as "still needed" — they move to
// a "prepared by us" bucket so the TC still sees them on our own to-do. Editable;
// extend with the DISCLOSURE_PREPARED_BY_US env (comma-separated keywords).
// DIA: we technically don't need it. "Los Angeles County Local Area Disclosures":
// not a county requirement; we add our own per-brokerage version. WFDA: our brokerage
// supplies its own. All are ours to handle, so never request them from the listing side.
// Forms we never chase the listing side for. The test is the SIGNATURE, not the deal:
// if a form requires only the BUYER to sign, the listing side has nothing to send us, so
// requesting it is noise. Add a form here when it is buyer-signature-only; keep deal- or
// brokerage-specific exceptions in the per-property audit list instead, or a form we
// genuinely need chased would be silently suppressed on every file.
const PREPARED_BY_US_DEFAULTS = [
  'property profile', 'mls client', 'ba avid', 'receipt for reports', 'rfr',
  'dia', 'los angeles county local area', 'wfda',
  'bhaa',
];
function isPreparedByUs(name) {
  const n = String(name || '').toLowerCase();
  const keys = PREPARED_BY_US_DEFAULTS.concat(
    (process.env.DISCLOSURE_PREPARED_BY_US || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  // Whole-word match so a short key like "dia" can't catch a substring of another item.
  return keys.some((k) => k && new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(n));
}

console.log('[disclosure-intake] module fully loaded, handler ready');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function blobsConfig(name) {
  return { name, siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN };
}

// Address -> stable key. Lowercase, drop punctuation, collapse whitespace, and
// trim a trailing unit so "937 N Granada Ave, Alhambra CA 91801" lines up across
// emails that format it slightly differently.
function normalizeAddress(addr) {
  return String(addr || '')
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tolerant address match: exact normalized, else same street number + 5-digit
// zip (so "937 N Granada Ave" and "937 N Granada Avenue ... 91801" line up).
function addrTokens(addr) {
  const n = normalizeAddress(addr);
  return { n, num: (n.match(/^\d+/) || [''])[0], zip: (n.match(/\b(\d{5})\b/) || [, ''])[1] };
}
function addrMatch(a, b) {
  const x = addrTokens(a), y = addrTokens(b);
  if (x.n && x.n === y.n) return true;
  if (x.num && x.zip && x.num === y.num && x.zip === y.zip) return true;
  return false;
}

// Minimal CSV parser — handles quoted cells containing commas and newlines
// (the required-docs cell will be a quoted multi-item list).
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Look up a deal's required-docs list by address from the published master sheet.
async function fetchAuditListByAddress(address) {
  if (!AUDIT_LIST_CSV_URL) return '';
  try {
    const res = await fetch(AUDIT_LIST_CSV_URL);
    if (!res.ok) { console.warn(`[disclosure-intake] audit-list sheet fetch ${res.status}`); return ''; }
    const rows = parseCsv(await res.text());
    if (rows.length < 2) return '';
    const header = rows[0].map((h) => String(h).toLowerCase().trim());
    let addrCol = header.findIndex((h) => h.includes('address'));
    let listCol = header.findIndex((h) => /disclos|required|audit|docs|list/.test(h));
    if (addrCol < 0) addrCol = 0;
    if (listCol < 0) listCol = 1;
    // If the same address appears more than once (e.g. a cancelled deal + a re-opened
    // one), prefer the LAST non-empty match — rows are appended, so newest wins.
    let match = '';
    for (const r of rows.slice(1)) {
      if (addrMatch(r[addrCol] || '', address)) {
        const v = String(r[listCol] || '').trim();
        if (v) match = v;
      }
    }
    if (match) return match;
    console.warn(`[disclosure-intake] no audit-list row matched "${address}"`);
    return '';
  } catch (err) {
    console.warn(`[disclosure-intake] audit-list lookup failed: ${err.message}`);
    return '';
  }
}

// Deal context (Year Built, HOA) from the master sheet — facts the disclosure
// package may not contain (sourced from MLS/PP) that we cross-check answers against.
async function fetchDealContext(address) {
  const empty = { yearBuilt: null, hasHoa: null };
  if (!AUDIT_LIST_CSV_URL || !address) return empty;
  try {
    const res = await fetch(AUDIT_LIST_CSV_URL);
    if (!res.ok) return empty;
    const rows = parseCsv(await res.text());
    if (rows.length < 2) return empty;
    const header = rows[0].map((h) => String(h).toLowerCase().trim());
    let addrCol = header.findIndex((h) => h.includes('address'));
    const yearCol = header.findIndex((h) => /year\s*built|yr\s*built|\byear\b/.test(h));
    const hoaCol = header.findIndex((h) => /\bhoa\b|common\s*interest/.test(h));
    if (addrCol < 0) addrCol = 0;
    // Last matching row wins (newest after a re-open).
    let ctx = empty;
    for (const r of rows.slice(1)) {
      if (!addrMatch(r[addrCol] || '', address)) continue;
      const ym = yearCol >= 0 ? String(r[yearCol] || '').match(/\b(1[89]\d{2}|20\d{2})\b/) : null;
      const hoaRaw = hoaCol >= 0 ? String(r[hoaCol] || '').trim().toLowerCase() : '';
      ctx = {
        yearBuilt: ym ? parseInt(ym[1], 10) : null,
        hasHoa: hoaRaw ? /^y|true|1/.test(hoaRaw) : null,
      };
    }
    return ctx;
  } catch (err) {
    console.warn(`[disclosure-intake] deal-context lookup failed: ${err.message}`);
    return empty;
  }
}

// ----------------------------------------------------------------------------
// Form-version currency. CAR forms stamp a revision date ("Revised MM/YY"); the
// listing side sometimes sends an outdated version. We read each received form's
// printed revision and flag any that are OLDER than the current version listed in
// the "Current Form Versions" sheet.
// ----------------------------------------------------------------------------

// Parse a revision like "6/26", "Revised 6/26", "10/2024" -> a comparable number
// (year*12 + month). 2-digit years are read as 20YY. Returns null if unparseable.
function revToNum(s) {
  const m = String(s || '').match(/(\d{1,2})\s*\/\s*(\d{2,4})/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  let year = parseInt(m[2], 10);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12) return null;
  return year * 12 + month;
}
function revLabel(s) {
  const m = String(s || '').match(/(\d{1,2})\s*\/\s*(\d{2,4})/);
  if (!m) return String(s || '').trim();
  let year = m[2]; if (year.length === 4) year = year.slice(2);
  return `${parseInt(m[1], 10)}/${year}`;
}

// Read the current-versions sheet into [{ key, version }] (key = a form code or a
// distinctive name fragment, e.g. "SPQ" or "Orange County Local Area").
async function fetchFormVersions() {
  if (!FORM_VERSIONS_CSV_URL) return [];
  try {
    const res = await fetch(FORM_VERSIONS_CSV_URL);
    if (!res.ok) { console.warn(`[disclosure-intake] form-versions sheet fetch ${res.status}`); return []; }
    const rows = parseCsv(await res.text());
    if (rows.length < 2) return [];
    const header = rows[0].map((h) => String(h).toLowerCase().trim());
    let keyCol = header.findIndex((h) => /form|code|name/.test(h));
    let verCol = header.findIndex((h) => /version|revision|current|date/.test(h));
    if (keyCol < 0) keyCol = 0;
    if (verCol < 0) verCol = 1;
    return rows.slice(1)
      .map((r) => ({ key: String(r[keyCol] || '').trim(), version: String(r[verCol] || '').trim() }))
      .filter((e) => e.key && e.version && revToNum(e.version) != null);
  } catch (err) {
    console.warn(`[disclosure-intake] form-versions lookup failed: ${err.message}`);
    return [];
  }
}

const vnorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Does a received form match a versions-sheet key? Whole-key match against the
// form's code+name (word-bounded), so short codes like "SA" don't match "SBSA".
function formMatchesKey(form, key) {
  const k = vnorm(key);
  if (!k) return false;
  const hay = vnorm(`${form.code || ''} ${form.name || ''}`);
  return new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(hay);
}

// Compare each received form's revision to the current versions; return outdated.
function findOutdatedForms(received, versions) {
  const out = [];
  for (const f of (received || [])) {
    const got = revToNum(f.revision);
    if (got == null) continue; // no readable revision on the received form
    const entry = (versions || []).find((v) => formMatchesKey(f, v.key));
    if (!entry) continue; // no current-version reference for this form
    const cur = revToNum(entry.version);
    if (cur != null && got < cur) {
      out.push({ name: f.name || f.code || entry.key, received: revLabel(f.revision), current: revLabel(entry.version) });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// ZIP support. Zapier's "Upload File" step bundles all the email's attachments
// into ONE .zip on Drive, so a single document URL can actually be 22 PDFs. We
// detect the zip, extract the PDFs, drop blocked/non-PDF entries, and feed the
// real PDFs downstream. Pure Node built-ins (zlib) — no extra dependency.
// ----------------------------------------------------------------------------
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const PDF_MAGIC = Buffer.from('%PDF');

// Filenames we never want to send to the model (big non-disclosure reports +
// invoices). Mirrors the Zapier Code-step BLOCK list, plus invoice.
const BLOCK_NAME = /(previous\s*home\s*inspection|home\s*inspection|inspection\s*report|\binspection\b|termite|wood\s*destroying|sewer|\broof\b|chimney|\bpool\b|\bspa\b|hvac|geolog|\bsoils?\b|\bsurvey\b|appraisal|invoice|\bphotos?\b)/i;

// Informational booklets. These are pure boilerplate: IDENTIFY_PROMPT explicitly
// tells the model the booklet itself is NOT a receipt and must not be counted, and
// CLASSIFY_PROMPT excludes booklet pages from the Q&A pass. So every page of one is
// input tokens spent to be ignored — a single 200-page guide can dominate the whole
// run's cost. The signed RECEIPT for a booklet is a real audit item and is rescued
// by NEVER_BLOCK below.
const BOOKLET_NAME = /(homeowner'?s?\s*guide|environmental\s*hazards?|earthquake\s*safety|combined\s*hazards?\s*book|protect\s*your\s*family|lead[-\s]*based\s*paint\s*pamphlet|\bbooklet\b|\bpamphlet\b)/i;

// Names that must NEVER be blocked, even when they match a pattern above. The
// override wins over BLOCK_NAME and BOOKLET_NAME.
//   - AVID = Agent Visual Inspection Disclosure; BIA/BIW = Buyer's Inspection
//     Advisory/Waiver — disclosure forms whose names contain "inspection".
//   - receipt / acknowledgment — the booklet RECEIPT is a presence check on the
//     audit list. "Receipt for Links to Booklets" matches BOOKLET_NAME and must
//     still reach the model.
const NEVER_BLOCK = /(\bavid\b|agent\s*visual\s*inspection|buyer'?s?\s*inspection\s*(advisory|waiver)|inspection\s*(advisory|waiver)|\bbia\b|\bbiw\b|receipt|acknowledg)/i;

function isBlockedName(name) {
  const n = name || '';
  return (BLOCK_NAME.test(n) || BOOKLET_NAME.test(n)) && !NEVER_BLOCK.test(n);
}

function looksZip(buf, name, contentType) {
  if (buf && buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) return true;
  // Magic bytes win over a misleading name/content-type: a single PDF sometimes
  // arrives named "attachments.zip" served as application/octet-stream. Real PDF
  // bytes are never a zip, so don't route them into the unzip path.
  if (buf && buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC)) return false;
  if (/\.zip$/i.test(name || '')) return true;
  if (/zip/i.test(contentType || '')) return true;
  return false;
}
function looksPdf(buf, name) {
  if (buf && buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC)) return true;
  return /\.pdf$/i.test(name || '');
}

// Minimal ZIP reader: walk the central directory and inflate each entry. Handles
// stored (method 0) and deflate (method 8) — i.e. every normal zip. Skips
// directories, zip64-only entries, and anything it can't inflate.
function unzipEntries(buf) {
  const out = [];
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < cdCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry
    if (compSize === 0xffffffff || localOffset === 0xffffffff) continue; // zip64, skip
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data;
    try {
      if (method === 0) data = comp;
      else if (method === 8) data = zlib.inflateRawSync(comp);
      else continue;
    } catch (e) { continue; }
    out.push({ name: name.split('/').pop(), data });
  }
  return out;
}

// Diagnostic: short, log-safe description of what we actually fetched.
function describeBuffer(buf, contentType) {
  const head = buf.subarray(0, 16);
  const ascii = head.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
  return `content-type=${contentType || 'n/a'} len=${buf.length} head="${ascii}" hex=${head.toString('hex')}`;
}

function isHtml(buf, contentType) {
  if (/text\/html/i.test(contentType || '')) return true;
  const head = buf.subarray(0, 256).toString('latin1').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('<');
}

// Google Drive "uc?export=download" returns an HTML interstitial (instead of the
// file) for anything it can't virus-scan, typically > ~25MB. The real file lives
// behind a confirm token on drive.usercontent.google.com. Build that URL so we can
// refetch the actual bytes.
function driveConfirmUrl(html, originalUrl) {
  const id = (originalUrl.match(/[?&]id=([A-Za-z0-9_-]+)/) || [])[1];
  if (!id) return '';
  const confirm = (html.match(/name="confirm"\s+value="([^"]+)"/i) || html.match(/[?&]confirm=([0-9A-Za-z_-]+)/) || [, 't'])[1];
  const uuid = (html.match(/name="uuid"\s+value="([^"]+)"/i) || [])[1];
  let u = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=${confirm || 't'}`;
  if (uuid) u += `&uuid=${uuid}`;
  return u;
}

// Fetch a URL to a Buffer, transparently resolving the Google Drive scan-warning
// interstitial. Returns { buf, contentType } or null.
async function fetchToBuffer(url, name) {
  let res = await fetch(url);
  if (!res.ok) { console.warn(`[disclosure-intake] could not fetch ${name} (${res.status})`); return null; }
  let contentType = res.headers.get('content-type') || '';
  let buf = Buffer.from(await res.arrayBuffer());
  if (/google\.com/i.test(url) && isHtml(buf, contentType)) {
    const real = driveConfirmUrl(buf.toString('latin1'), url);
    if (real) {
      console.log(`[disclosure-intake] ${name}: got Drive interstitial, refetching via confirm URL`);
      const res2 = await fetch(real);
      if (res2.ok) { contentType = res2.headers.get('content-type') || ''; buf = Buffer.from(await res2.arrayBuffer()); }
      else console.warn(`[disclosure-intake] ${name}: confirm refetch failed (${res2.status})`);
    }
  }
  return { buf, contentType };
}

// ----------------------------------------------------------------------------
// Load each document as base64. Accepts { base64 } directly, or { url } to fetch.
// A .zip is expanded into the disclosure PDFs inside it. Anything that is neither
// a valid zip nor a valid PDF is logged and skipped — never handed to Claude.
// ----------------------------------------------------------------------------
async function loadDocuments(documents) {
  const out = [];
  for (const d of (documents || [])) {
    if (!d) continue;
    const name = d.name || d.filename || 'document.pdf';
    try {
      let buf = null;
      let contentType = '';
      if (d.base64) {
        buf = Buffer.from(d.base64, 'base64');
      } else if (d.url) {
        const fetched = await fetchToBuffer(d.url, name);
        if (!fetched) continue;
        buf = fetched.buf; contentType = fetched.contentType;
      } else {
        continue;
      }

      // ZIP: expand into the PDFs inside, filtering blocked/non-PDF entries.
      if (looksZip(buf, name, contentType)) {
        let entries = null;
        try { entries = unzipEntries(buf); }
        catch (e) {
          console.warn(`[disclosure-intake] could not unzip ${name}: ${e.message} | ${describeBuffer(buf, contentType)}`);
          // Not a real zip. If the bytes are actually a PDF (e.g. a single PDF mis-named
          // attachments.zip), fall through to single-document handling below; otherwise
          // skip (likely an HTML interstitial / permission page).
          if (!(buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC))) continue;
        }
        if (entries) {
          let kept = 0;
          const skippedNames = [];
          for (const e of entries) {
            if (!looksPdf(e.data, e.name)) { skippedNames.push(e.name + ' [not pdf]'); continue; }
            if (isBlockedName(e.name)) { skippedNames.push(e.name + ' [blocked]'); continue; }
            if (e.data.length > MAX_DOC_BYTES) { skippedNames.push(e.name + ' [too large]'); continue; }
            out.push({ name: e.name, base64: e.data.toString('base64') });
            kept++;
          }
          console.log(`[disclosure-intake] unzipped ${name}: kept ${kept} PDF(s)` + (skippedNames.length ? `, skipped ${skippedNames.length} (${skippedNames.join(', ')})` : ''));
          continue;
        }
        // entries === null and bytes are a PDF: fall through to single-document handling.
      }

      // Single document: only forward it if the BYTES are actually a PDF (don't trust
      // the filename — a fetched HTML error/interstitial page would slip through).
      if (!(buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC))) {
        console.warn(`[disclosure-intake] ${name} is not a PDF or zip, skipping | ${describeBuffer(buf, contentType)}`);
        continue;
      }
      // Non-disclosure reports and informational booklets are worthless to every
      // downstream pass and are the single biggest driver of input-token cost. The
      // zip branch above has always filtered them; the single-attachment path did
      // not, so anything emailed as a loose attachment (the common case) bypassed
      // the blocklist entirely and was billed in full.
      if (isBlockedName(name)) { console.log(`[disclosure-intake] ${name} blocked (non-disclosure), skipping`); continue; }
      if (buf.length > MAX_DOC_BYTES) { console.warn(`[disclosure-intake] ${name} too large (${buf.length}B), skipping`); continue; }
      out.push({ name, base64: buf.toString('base64') });
    } catch (err) {
      console.warn(`[disclosure-intake] failed to load ${name}: ${err.message}`);
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Anthropic call (Opus 4.8, adaptive thinking). content is the message content
// array. Returns the joined text. Retries on 429/529.
// ----------------------------------------------------------------------------
// Usage-sheet Note for a doc-bearing call: which step, and exactly which documents
// (with sizes) rode along. Without this a costly row in the sheet is anonymous and
// tracking it back to a property means digging through function logs.
function docsNote(step, docs) {
  const parts = (docs || []).map((d) => {
    const kb = Math.round(((d.base64 || '').length * 0.75) / 1024);
    return `${d.name} (${kb}KB)`;
  });
  return `${step} | ${parts.length} doc(s): ${parts.join('; ')}`;
}

async function callClaude(content, maxTokens, note = '', attempt = 0) {
  const MAX_RETRIES = 4;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var not set');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens || 16000,
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content }],
    }),
  });

  if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter ? Math.min(parseFloat(retryAfter) * 1000, 30000) : Math.min(1000 * Math.pow(2, attempt), 30000);
    console.log(`[disclosure-intake] ${response.status}, retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
    return callClaude(content, maxTokens, note, attempt + 1);
  }
  if (!response.ok) throw new Error(`Claude API error ${response.status}: ${await response.text()}`);

  const data = await response.json();
  await usageLog.logUsage({ fn: 'disclosure-intake', model: MODEL, effort: 'high', usage: data.usage, note });
  if (data.stop_reason === 'max_tokens') throw new Error('Output hit max_tokens — raise the ceiling and re-run.');
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function parseJson(raw) {
  let t = (raw || '').trim().replace(/```json|```/g, '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : t);
}

// ----------------------------------------------------------------------------
// Step 1 — identify the REAL forms present across the documents, and read the
// property address. The "real vs referenced" rule is the key lesson from the
// proof: a form counts only if its own pages are in the package.
// ----------------------------------------------------------------------------
const IDENTIFY_PROMPT =
  'These PDFs are a buyer-side disclosure delivery (one combined packet and/or several single-form PDFs). ' +
  'Identify every distinct California real estate disclosure/report form that is ACTUALLY INCLUDED as its own form ' +
  '(its own pages are physically in the package). Use the standard CAR code and full name. ' +
  'CRITICAL: a form counts as present ONLY if its own form pages are here. Do NOT list a form merely because it is ' +
  'referenced, cross-mentioned, or described inside another form. Examples of what NOT to count: the TDS Section III ' +
  '"Agent Inspection Disclosure" is part of the TDS, not a separate AVID; SBSA discussing wildfire/natural hazards is ' +
  'not a separate Wildfire or NHD form; the DIA describing the ESD is not an ESD. Also read the property street ' +
  'address from the forms.\n' +
  'Also list these as their own present documents when their pages are physically here: the Natural Hazard ' +
  'Disclosure report (any provider — FANHD, JCP-LGS, Disclosure Source); and the RECEIPT/acknowledgment page for the ' +
  '"Homeowner\'s Guide to Environmental Hazards and Earthquake Safety" booklet — both the standard CAR receipt and ' +
  'custom brokerage equivalents such as a "Receipt for Links to Booklets" page (a page acknowledging receipt of the ' +
  'environmental hazards / earthquake safety / HERS / lead booklets). Name that receipt clearly, e.g. ' +
  '"Earthquake/Environmental Hazards Booklet Receipt". CRITICAL: the booklet ITSELF (the multi-page informational ' +
  '"Homeowner\'s Guide to Environmental Hazards and Earthquake Safety", "Environmental Hazards: A Guide for ' +
  'Homeowners...", or earthquake-safety guide content) is NOT a receipt. Count a booklet receipt as present ONLY when ' +
  'an actual ACKNOWLEDGMENT page is included, one with a signature/initial line or wording like "I/we acknowledge ' +
  'receipt of ...". If only the informational booklet pages are present with no such signed/signable acknowledgment ' +
  'page, do NOT list any booklet receipt as present. Also recognize the WBSA (Wooden Balconies and Stairs ' +
  'Addendum, C.A.R. Form WBSA) when its page is present.\n' +
  'For EACH form, also read its printed REVISION DATE and return it as "revision" in M/YY form. CAR forms print it ' +
  'under the title ("C.A.R. Form SPQ, Revised 12/25") and in the footer ("SPQ REVISED 12/25"). Local/county forms ' +
  '(e.g. an Orange County Local Area Disclosure) print their own date. Return empty string for "revision" if no ' +
  'revision date is printed on the form.\n\n' +
  'Respond with ONLY this JSON (no prose, no fences): ' +
  '{"property_address":"<street, city, state, zip>","forms":[{"code":"TDS","name":"Real Estate Transfer Disclosure Statement","revision":"12/25"}]}';

// ----------------------------------------------------------------------------
// Step 1b — DEDICATED answer-review pass. Split out of IDENTIFY_PROMPT on purpose
// so the detail work (read EVERY marked answer, pair each Yes with its OWN
// explanation, catch blanks, catch answer/explanation mismatches) gets a focused
// prompt instead of competing with form-ID + revision reading in one overloaded
// call. Reads the same PDFs; returns response_flags + key_answers only.
// ----------------------------------------------------------------------------
const ANSWER_REVIEW_PROMPT =
  'These PDFs are a buyer-side disclosure delivery (one combined packet and/or several single-form PDFs). Review the ' +
  'SELLER\'S MARKED ANSWERS on every form that has questions/answers (SPQ and its addendum, TDS, SBSA, ESD and similar ' +
  'Q&A disclosures) and flag responses the buyer side would send back to be corrected or completed. READ the ACTUAL ' +
  'marked answer for each item (Yes / No / blank); do not just note items to verify. Work through each Q&A form ' +
  'SECTION BY SECTION and SUB-ITEM BY SUB-ITEM, and do NOT skip any lettered or numbered sub-item: read the TDS ' +
  'Section C items C1 through C14 individually, and every SPQ sub-item individually (e.g. 6G, 7A, 14A, 14B, 14C).\n' +
  'Flag:\n' +
  '(a) a question or sub-item left BLANK / unanswered (issue "unanswered");\n' +
  '(b) ANY sub-item marked YES whose OWN explanation is BLANK, ILLEGIBLE, or TOO VAGUE to understand (issue ' +
  '"yes_no_explanation"). FIRST be certain the YES box is the one actually marked: these packages are SCANNED, and ' +
  'the Yes column (left) sits directly beside the No column (right), so do not transpose them. Treat a sub-item as ' +
  'Yes ONLY when the Yes box is clearly and affirmatively checked. If the No box is checked, the box is blank, or the ' +
  'mark is faint, ambiguous, or you are not certain which box is checked, treat the answer as not-Yes and do NOT ' +
  'raise a yes_no_explanation flag for it. Never infer Yes from a written explanation, a neighboring sub-item, or a ' +
  'shared item-level explanation line: on the SPQ and TDS a single Explanation line serves the whole numbered item, ' +
  'so it belongs to whichever sub-item(s) are actually Yes, not to one marked No. ' +
  'The rule is universal: every Yes on a Q&A form must have its own written explanation, on ' +
  'the TDS and the SPQ alike, regardless of which question or letter it is. Check each Yes sub-item SEPARATELY: when ' +
  'several sub-items in a row are marked Yes but only ONE explanation is written, do NOT assume that one explanation ' +
  'covers the others. Determine which sub-item the explanation actually addresses, and flag every OTHER Yes sub-item ' +
  'as missing its explanation, naming the exact sub-item;\n' +
  '(b2) SEPARATE EXPLANATION ADDENDUM. Sellers often write their explanations on a separate sheet instead of on the ' +
  'form ("Attach additional sheets if necessary" is printed on the TDS itself). That sheet is usually titled ' +
  'something like "Disclosure / Questionnaire Explanations", and it numbers its entries at the ITEM level (e.g. "7.", ' +
  '"8.", "14.") while the SPQ asks at the SUB-item level (7A, 7B, 7C). If a Yes sub-item has NO explanation on the ' +
  'form itself, but an explanation for that ITEM exists elsewhere in this package, you MUST NOT report it as having ' +
  'no explanation, and you MUST NOT treat it as satisfied either. One item-level summary does not automatically ' +
  'satisfy every Yes sub-item under it, and that judgment is a human\'s to make, not yours. Instead raise ' +
  '"issue":"explanation_on_addendum", set "document" to the name/title of the sheet where you found it, and set ' +
  '"reason" to a SHORT quote of what that entry actually says. Do this per Yes sub-item. Only use ' +
  '"yes_no_explanation" when there is genuinely no explanation ANYWHERE in the package, on the form or on any ' +
  'separate sheet;\n' +
  '(c) a sub-item that HAS a written explanation but whose box is marked NO or left BLANK: a seller writes an ' +
  'explanation only when the answer is Yes, so the mark should be Yes. Set "issue":"answer_contradicts_package", ' +
  '"discrepancy_type":"incorrect", "marked" = the marked answer (No or blank), "should_be":"Yes", and "reason":"an ' +
  'explanation is provided, so this should be marked Yes";\n' +
  '(d) an answer that CONTRADICTS a fact evident in this package (the seller likely marked it wrong) — read the ' +
  'actual mark and report it. In particular:\n' +
  '   - HOA / common interest: if anything in the package shows the property is in an HOA or common interest ' +
  'development (an HOA or CC&R disclosure is present, HOA dues are referenced, or the forms otherwise indicate an ' +
  'HOA), then the HOA questions MUST be YES — TDS Section C common-interest/HOA items (e.g. C12, C13, C14) and SPQ ' +
  '6G and SPQ Section 14. If any of those is marked NO (or left blank), flag it, naming the exact item and that it ' +
  'should be YES because the property is in an HOA.\n' +
  '   - Provided documents: SPQ Section 6 asks whether specific reports/booklets/advisories were provided (e.g. 6K). ' +
  'If that document is PHYSICALLY PRESENT in this package, the matching "provided?" box should be YES; flag it if it ' +
  'is not marked YES.\n' +
  '   - WBSA consistency: if a WBSA (Wooden Balconies and Stairs Addendum) is in this package, then the SPQ ' +
  'question about wooden balconies / decks / stairways / elevated wooden elements / SB 326 or SB 721 inspection ' +
  '(this is SPQ 6K) should be answered consistently — i.e. YES. If SPQ 6K is marked NO while a WBSA was provided, ' +
  'flag it: the seller provided a WBSA, which is inconsistent with a No on 6K.\n' +
  '   - Year built / lead paint: if the property\'s year built is evident anywhere in the package, the pre-1978 ' +
  'lead-based-paint question (SPQ 7E) must match it — built 1978 or later means 7E should be NO; built before 1978 ' +
  'means 7E should be YES (and an LPD is required). Flag a contradicting answer. If the year built is NOT in the ' +
  'package, skip this check.\n' +
  'ALSO check TDS Section II (the Seller\'s Information checklist of features the property HAS). Go through EVERY row ' +
  'of this checklist in order and do not skip any. For any item the ' +
  'seller marked the property HAS but left its REQUIRED DETAIL blank, raise a "detail_incomplete" flag: in ' +
  'particular (a) Water Heater checked but its type (Gas/Solar/Electric) all blank; (b) a Pool, Spa, or Pool/Spa ' +
  'Heater shown present but its type (Gas/Solar/Electric) box not checked; (c) Roof checked or its Type filled but ' +
  'the Age left blank; and any similar checked item whose type or age line is blank (Water Supply type, Gas Supply ' +
  'type). ALSO, the fill-in fields in the BOTTOM block of TDS page 1 are expected to be completed by the seller: ' +
  'flag each of these as "detail_incomplete" whenever its line is left BLANK, even if no adjacent box is checked: ' +
  '"Exhaust Fan(s) in:" (location), "220 Volt Wiring in:" (location), "Fireplace(s) in:" (location), and "Roof(s): ' +
  'Type" and "Age". For EACH, return a flag with "form":"TDS", "item" = the item name including ' +
  'its TDS subsection (e.g. "II A Water Heater", "II A Pool/Spa Heater", "II A Roof", "II A Exhaust Fan(s)"), ' +
  '"issue":"detail_incomplete", "marked":"present", and ' +
  '"reason" = the specific blank detail phrased to drop into a request, e.g. "the type (Gas/Solar/Electric) is left ' +
  'blank", "the Age is left blank", or "the location is left blank". For the Section II CHECKLIST items (not the ' +
  'bottom fill-in block) do NOT flag an item that is simply not checked / not present.\n' +
  'ALSO check these REQUIRED HEADER FIELDS and flag any that are blank with "issue":"unanswered": (1) the TDS ' +
  'disclosure date, the "...AS OF (DATE) ____" line near the top of TDS page 1 (the date the seller completes the ' +
  'TDS, NOT a signature or DocuSign date); return "form":"TDS", "item":"disclosure date", "reason":"the disclosure ' +
  'date near the top of page 1 is left blank". (2) the SPQ Assessor\'s Parcel Number ("Assessor\'s Parcel No.") in ' +
  'the SPQ page 1 header; return "form":"SPQ", "item":"APN", "reason":"the Assessor\'s Parcel Number in the header ' +
  'is left blank". Flag these only when the field is genuinely blank.\n' +
  'ALSO check the FHDS (Fire Hardening and Defensible Space Disclosure and Addendum, C.A.R. Form FHDS) if its pages ' +
  'are anywhere in the package (it may be embedded inside a combined packet). The required-complete standard is: the ' +
  'Section 2 fire-hardening compliance boxes are checked AND Section 3 is completed, specifically Section 3A is ' +
  'marked (the Property IS or is NOT subject to a local vegetation management ordinance) AND a Section 3C ' +
  'responsibility option is selected. If an FHDS is present but Section 2 is unchecked, or Section 3A is unmarked, ' +
  'or no Section 3C option is selected, raise a flag: "form":"FHDS", "item" = the incomplete part (e.g. "Section 2" ' +
  'or "Section 3"), "issue":"verify_mismatch", "reason" = a complete request sentence, e.g. "the FHDS is present but ' +
  'Section 2 boxes are not checked and Section 3 is not completed; please complete Section 2, mark Section 3A, ' +
  'select a Section 3C option, and resend the FHDS". Do NOT flag an FHDS that is fully completed, and do NOT raise ' +
  'this if no FHDS is in the package.\n' +
  'ALSO inspect the SELLER signature block(s) on the signed disclosure forms (TDS, SPQ, SBSA and similar). The pre-' +
  'printed party name on a form (the typed "Seller" name line, which is often a trust or LLC) is NOT the signature ' +
  'and must NEVER by itself trigger this flag. Judge ONLY by how the seller actually SIGNED. Raise an entity_signer ' +
  'flag ONLY when, across the ENTIRE package, the seller signed with a bare entity name (trust, LLC, corporation, ' +
  'estate, or partnership) and NO individual ever signed in a representative capacity. If an individual signs in a ' +
  'representative capacity ANYWHERE in the seller signing blocks (e.g. "Jane Smith, Trustee", "John Doe, Manager", ' +
  '"..., its President", or a DocuSign signature showing an individual person\'s name), the signature is CORRECT: do ' +
  'NOT flag it. When you are not certain an individual signed in a representative capacity, do NOT raise this flag. ' +
  'When you do flag, return "form":"Seller signature", "item":"entity signer", ' +
  '"issue":"entity_signer", and "reason" = a one-line request naming the entity, e.g. "Seller signed as an entity ' +
  '(Smith Family Trust); please have the seller sign as an individual on behalf of the entity (e.g. Jane Smith, ' +
  'Trustee or authorized signer)". Do NOT flag an ordinary individual seller signature.\n' +
  'Do NOT moralize about whether a disclosed issue is concerning, and do NOT review forms with no questions ' +
  '(receipts, booklets, profiles, AVID, certifications).\n' +
  'For EACH flag return: "form" (e.g. SPQ, TDS); "item" = the CONCISE question code ONLY (e.g. 6K, C14, 14C, 7E) ' +
  'with NO words like "Section" or "Item" and NO parentheticals such as "(common area)"; "issue"; "marked" = the ' +
  'marked answer ("Yes", "No", or "blank"). For a CORRECTION (answer_contradicts_package), classify it into ONE ' +
  '"discrepancy_type" and fill the matching fields, so each reads like a TC requesting revised disclosures:\n' +
  '  - "incorrect" (the Yes/No answer is wrong on its face): set "should_be" (Yes/No) and "reason" = one concise ' +
  'factual reason (e.g. "the property is a condominium").\n' +
  '  - "inconsistent" (one form\'s answer genuinely conflicts with a RELATED answer on another form that actually ' +
  'addresses it): set "other_form" AND set "reason" to the SPECIFIC conflicting answer on that other form (e.g. ' +
  '"the seller indicates they occupy the property") so the request is not vague. Flag a REAL conflict only, do not ' +
  'invent one. Real example: SPQ 18E marked "property is tenant occupied = Yes" conflicts with the TDS where the ' +
  'seller indicates they occupy the property. If you cannot point to a concrete conflicting answer on a specific ' +
  'form, do not use this type.\n' +
  '  - "document" (a supporting document in the package contradicts it): set "document" = the doc (e.g. "a WBSA ' +
  '(Wooden Balconies and Stairs Addendum)") and "should_be".\n' +
  '  - "transaction" (information elsewhere in the transaction contradicts it): set "source" = one of MLS, title, ' +
  'the HOA documents, the purchase agreement, the legal description, escrow instructions.\n' +
  'Keep each reason to ONE concise sentence, state FACTS only, do NOT use "appears", "may", or "possibly", and do ' +
  'NOT use em or en dashes in any field.\n' +
  'ALSO return key_answers for the facts we cross-check against our own records: "spq_7e" = the marked answer to ' +
  'SPQ question 7E (one of "yes" / "no" / "blank", or "na" if there is no SPQ in the package); "hoa_any_no" = ' +
  '"yes" if ANY HOA / common-interest question (TDS Section C items C12/C13/C14, SPQ 6G, SPQ Section 14) is marked ' +
  'No or left blank, "no" if they are all Yes, "na" if those forms are not present; "fire_clearance" = the marked ' +
  'answer ("yes" / "no" / "blank", or "na" if there is no SPQ) to the SPQ GOVERNMENTAL-section question asking ' +
  'whether there are existing or proposed government requirements that tall grass, brush or other vegetation be ' +
  'cleared or that flammable materials be removed. FIND THIS QUESTION BY ITS DESCRIPTION, NOT BY A FIXED LETTER: it ' +
  'is item 17F on the SPQ revised 12/24 and item 17G on the SPQ revised 6/26, and the letter can move again on other ' +
  'revisions; "fire_clearance_item" = the item letter/number exactly as printed on this form (e.g. "17F" or "17G"), ' +
  'or "" if not found; "fhds" = "yes" if a Fire Hardening Disclosure and Advisory (C.A.R. Form FHDS) is present AND ' +
  'completed as required (its Section 2 compliance boxes are checked AND its Section 3 question is marked Yes), "no" ' +
  'if an FHDS is present but Section 2 boxes are left unchecked or Section 3 is not marked Yes, or "na" if no FHDS is ' +
  'in the package.\n\n' +
  'Respond with ONLY this JSON (no prose, no fences): ' +
  '{"response_flags":[{"form":"SPQ","item":"6K","issue":"unanswered|yes_no_explanation|explanation_on_addendum|explanation_unclear|answer_contradicts_package|detail_incomplete|verify_mismatch","discrepancy_type":"incorrect|inconsistent|document|transaction","marked":"Yes|No|blank","should_be":"Yes|No","reason":"<for incorrect; for explanation_on_addendum, a short quote of the addendum entry>","other_form":"<for inconsistent>","document":"<for document; for explanation_on_addendum, the sheet it was found on>","source":"<for transaction>"}],' +
  '"key_answers":{"spq_7e":"yes|no|blank|na","hoa_any_no":"yes|no|na","fire_clearance":"yes|no|blank|na","fire_clearance_item":"17F","fhds":"yes|no|na"}}';

const EMPTY_KEY_ANSWERS = { spq_7e: 'na', hoa_any_no: 'na', fire_clearance: 'na', fire_clearance_item: '', fhds: 'na' };

// ----------------------------------------------------------------------------
// IDENTIFY MEMOIZATION — the most expensive call in the pipeline, cached on content.
//
// identify() sends every document to Opus as a full PDF and reads it end to end (form IDs,
// revisions, the address, AND the key_answers cross-checks). The usage ledger for
// 2026-07-12..14 puts it at 48% of ALL spend: 19 calls, ~162k input tokens each, ~$0.85 a call.
//
// It also runs FIRST, before the renderer. So when the renderer was OOM-killed, Netlify
// retried the function from the top and identify was billed AGAIN — having already succeeded.
// One packet (attachments.zip) ran identify 12 times with a byte-identical 174,444-token
// payload between 07-13T23:41 and 07-14T01:23: $10.94 spent, ~$10.03 of it pure duplicate,
// 32% of the entire three-day bill, for zero additional output.
//
// The OOM is fixed, but the SHAPE of that failure is permanent: any crash downstream of
// identify re-bills identify. So memoize it on a hash of the document bytes. A retry, or a
// re-drop of the same packet, is then free. A genuinely new packet is unaffected.
//
// The key covers the model, the prompt and every document's name+bytes, so changing the
// prompt or the model invalidates the cache on its own — no manual bust needed. Every cache
// operation is swallowed on failure: a broken cache must never fail a disclosure run, it
// just means we pay for the call like before.
const IDENTIFY_CACHE_VERSION = 'v1';

function identifyCacheKey(docs) {
  const h = crypto.createHash('sha256');
  h.update(IDENTIFY_CACHE_VERSION);
  h.update(MODEL);
  h.update(IDENTIFY_PROMPT);
  // Sorted, so the same packet keys the same regardless of document order (identifyForms
  // re-sorts by size internally, and upstream ordering is not guaranteed stable).
  const fingerprints = docs
    .map((d) => crypto.createHash('sha256').update(String(d.name || '')).update('\0').update(d.base64 || '').digest('hex'))
    .sort();
  for (const fp of fingerprints) h.update(fp);
  return `identify:${h.digest('hex')}`;
}

async function readIdentifyCache(key) {
  try {
    const store = getStore(blobsConfig(IDENTIFY_CACHE_STORE));
    return await store.get(key, { type: 'json' });
  } catch (err) {
    console.warn(`[disclosure-intake] identify cache read failed (non-fatal): ${err.message}`);
    return null;
  }
}

async function writeIdentifyCache(key, result) {
  try {
    const store = getStore(blobsConfig(IDENTIFY_CACHE_STORE));
    await store.setJSON(key, { ...result, cachedAt: new Date().toISOString() });
  } catch (err) {
    console.warn(`[disclosure-intake] identify cache write failed (non-fatal): ${err.message}`);
  }
}

async function identifyForms(docs) {
  const key = identifyCacheKey(docs);

  const cached = await readIdentifyCache(key);
  if (cached && Array.isArray(cached.forms) && cached.forms.length) {
    console.log(`[disclosure-intake] identify CACHE HIT (${key.slice(9, 21)}, cached ${cached.cachedAt}) — `
      + `skipped a ~$0.85 Opus call over ${docs.length} doc(s): ${cached.forms.map((f) => f.code || f.name).join(', ')}`);
    return { propertyAddress: cached.propertyAddress || '', forms: cached.forms, dropped: cached.dropped || [] };
  }

  const result = await identifyFormsUncached(docs);

  // Cache only a real, non-empty identification. An empty result means the model found
  // nothing or the size-shedding loop ran out of documents; caching that would make a bad
  // run permanent for this packet, and re-running an empty one is cheap by comparison.
  if (result && Array.isArray(result.forms) && result.forms.length) {
    await writeIdentifyCache(key, result);
    console.log(`[disclosure-intake] identify cached (${key.slice(9, 21)}) — a retry of this packet is now free`);
  } else {
    console.log('[disclosure-intake] identify returned no forms — NOT cached, so a re-run can still succeed');
  }
  return result;
}

async function identifyFormsUncached(docs) {
  // Backstop: Claude caps a request at ~32MB / 100 pages. If a large file (e.g. an
  // inspection report that slipped past the Zapier filter) makes the combined request
  // too large (413), drop the single biggest doc and retry, rather than failing the
  // whole run. Disclosures are small; the big outlier is almost always the non-disclosure.
  let working = docs.slice().sort((a, b) => (b.base64 || '').length - (a.base64 || '').length);
  const dropped = [];
  while (working.length) {
    const content = working.map((d) => ({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: d.base64 },
      title: d.name,
    }));
    content.push({ type: 'text', text: IDENTIFY_PROMPT });
    try {
      // Form-ID + revision + address only now (the answer review is a separate pass),
      // so the output is small. Keep a comfortable ceiling for adaptive thinking over a
      // multi-form packet.
      const raw = await callClaude(content, 24000, docsNote('identify', working));
      const parsed = parseJson(raw);
      const forms = Array.isArray(parsed.forms) ? parsed.forms
        .map((f) => ({ code: String(f.code || '').trim(), name: String(f.name || '').trim(), revision: String(f.revision || '').trim() }))
        .filter((f) => f.code || f.name) : [];
      // What identify actually RETURNED. Without this the ledger records that a costly
      // call happened and nothing about its output, so a bad identification is invisible
      // until a human spots a wrong "request from listing side" list days later.
      console.log(`[disclosure-intake] identify returned ${forms.length} form(s): ${forms.map((f) => f.code || f.name).join(', ') || '(none)'}`);
      return { propertyAddress: String(parsed.property_address || '').trim(), forms, dropped };
    } catch (err) {
      const tooLarge = /\b413\b|request_too_large|too\s*large/i.test(err.message || '');
      if (tooLarge && working.length > 1) {
        const big = working.shift(); // largest, list is size-sorted descending
        dropped.push(big.name);
        console.warn(`[disclosure-intake] identify: request too large — dropping biggest doc "${big.name}" and retrying with ${working.length} doc(s)`);
        continue;
      }
      throw err;
    }
  }
  return { propertyAddress: '', forms: [], dropped };
}

// ----------------------------------------------------------------------------
// Crisp-render answer review. Scanned packets have no text layer, so the model reads
// checkboxes from pixels; relying on Anthropic's internal PDF rasterization transposed
// adjacent Yes/No boxes. Instead we render the Q&A pages OURSELVES at high DPI and send
// sharp PNGs. Two stages: (A) render every page small + ask which pages carry seller-
// marked answers; (B) re-render only those pages large and run the answer review on the
// images. Falls back to the document-block path if rendering/classification yields nothing.
// ----------------------------------------------------------------------------
const QA_THUMB_SCALE = 0.7;                 // stage A: small thumbnails, just enough to classify
// stage B. Was 2.5, which renders ~1980px tall — but the API caps images at 1568px on the
// long edge and downscales anything bigger BEFORE the model sees it. So 2.5 bought no extra
// sharpness at all; it just cost memory (a factor in the OOM) and tokens. 1.9 lands at
// ~1505px: under the cap, so it reaches the model at full fidelity, un-downscaled.
const QA_HIRES_SCALE = 1.9;
const QA_MAX_RENDER_PAGES = 60;             // safety cap on pages rendered from one document
const QA_MAX_BATCH_B64 = 18 * 1024 * 1024;  // keep each review request well under the 32MB cap
const QA_MAX_BATCH_IMAGES = 20;

const CLASSIFY_PROMPT =
  'These are page thumbnails from a California real estate disclosure delivery: one image per page, each preceded ' +
  'by its page number. Identify every page that contains SELLER-ANSWERED content, meaning a page where the seller ' +
  'marks Yes/No (or similar) checkboxes or fills in / handwrites answers or explanations. Those are the ' +
  'question-and-answer disclosure pages we must read closely. They include forms such as the TDS, SPQ and its ' +
  'addenda, ESD, CSPQ, SBSA, FHDS (Fire Hardening), the Residential Earthquake Hazards Report, the water heater / ' +
  'smoke / carbon monoxide statement, the lead-based paint disclosure (LPD), septic or well disclosures (SWPI), and ' +
  'solar questionnaires. Judge by the FUNCTIONAL test (does the seller mark or write answers on the page?), NOT by ' +
  'the form name, so you also catch Q&A pages whose form is not in that list. EXCLUDE pages that are purely ' +
  'informational or advisory text, provider Natural Hazard Disclosure (NHD) reports, booklets, the Agent Visual ' +
  'Inspection Disclosure (AVID) narrative, receipts, cover sheets, and signature-only pages. Respond with ONLY this ' +
  'JSON, no prose: {"qa_pages":[1,2,3]} listing the 1-indexed page numbers, in order.';

// ----------------------------------------------------------------------------
// STANDARD FONT DATA — the reason the audit reported filled fields as blank.
//
// pdf-parse points pdf.js at its standard fonts relative to its OWN module path
// (`new URL('legacy/build/standard_fonts/', <its module URL>)`). esbuild bundles
// pdf-parse into the function, which rewrites that path to the build output dir, where
// standard_fonts/ does not exist. pdf.js then has NO standard font data.
//
// Fonts EMBEDDED in a PDF still draw. Fonts that are NOT embedded (the standard 14 —
// Helvetica, Times, Courier) draw as NOTHING. On the C.A.R. disclosures the blank form is
// embedded (HelveticaWorld, ZDingbats) but EVERY seller-entered value is
// Helvetica-BoldOblique, which is NOT embedded. So the Lambda renders a pristine blank
// TDS, hands it to the model, and the model truthfully reports "left blank". It never
// reproduces on a Mac, which supplies Helvetica itself.
//
// Fixing this via netlify.toml `external_node_modules` was tried and CRASHED the function
// (native canvas binding stops being bundled; silent death ~52s in, no error logged). So
// resolve it here instead, through pdfjs-dist — which IS external, so its standard_fonts/
// really exists on disk in the Lambda. Falls back to undefined (previous behaviour) if it
// cannot be resolved, so a bad path can never take the pipeline down.
let STANDARD_FONT_DATA_URL;
try {
  const path = require('path');
  const pdfjsPkg = require.resolve('pdfjs-dist/package.json');
  const dir = path.join(path.dirname(pdfjsPkg), 'standard_fonts') + path.sep;
  STANDARD_FONT_DATA_URL = require('fs').existsSync(dir) ? dir : undefined;
  console.log(`[disclosure-intake] standardFontDataUrl = ${STANDARD_FONT_DATA_URL || 'NOT FOUND — non-embedded fonts will render blank'}`);
} catch (err) {
  console.warn(`[disclosure-intake] could not resolve pdfjs standard_fonts: ${err.message}`);
}

// Render pages of a PDF to PNG base64 via pdf-parse. scale multiplies the 72dpi base;
// maxPages caps render work. Returns [{ pageNumber, base64 }].
// ----------------------------------------------------------------------------
// CHUNKED RENDERING — why this is not one big getScreenshot() call any more.
//
// It used to render every page of a document in ONE call and hold the whole result in
// memory. That fitted inside the 1GB Lambda only because pdf.js had NO standard font data
// and was silently skipping the non-embedded fonts (i.e. only because of the bug). The
// moment standardFontDataUrl resolved and pdf.js actually loaded and rasterised those
// fonts, a 46-page render blew the ceiling and the function was OOM-killed mid-render:
// no stack, no error, just `Duration:` and a retry. Three retries, three kills.
//
// So: render at most RENDER_CHUNK_PAGES pages per parser, then destroy the parser to free
// its canvases before the next chunk. `partial` renders exactly the pages asked for, so we
// never rasterise a page we do not need.
//
// Chunk size measured against a real 80-page packet (peak RSS, 1GB Lambda ceiling):
//   all pages in one parser (the old code) → 1148MB  ← the OOM, reproduced
//   chunks of 8                            →  770MB
//   chunks of 4                            →  670MB  ← here: ~350MB headroom, costs ~0.5s
//   chunks of 2                            →  645MB  (diminishing returns, slower)
// NOTE the peak lands in the THUMBNAIL pass, not the hi-res one: 60 thumbnails are only
// ~15MB of PNG but pdfjs's own working set is what climbs. So chunk size — not
// QA_HIRES_SCALE — is the lever that actually governs whether this function survives.
const RENDER_CHUNK_PAGES = 4;

async function renderPagesAsImages(buffer, pageNumbers, scale) {
  const out = [];
  const s = (typeof scale === 'number' && scale > 0) ? scale : 1.0;
  for (let i = 0; i < pageNumbers.length; i += RENDER_CHUNK_PAGES) {
    const chunk = pageNumbers.slice(i, i + RENDER_CHUNK_PAGES);
    const parser = new PDFParse({
      data: new Uint8Array(buffer),
      CanvasFactory,
      ...(STANDARD_FONT_DATA_URL ? { standardFontDataUrl: STANDARD_FONT_DATA_URL } : {}),
    });
    try {
      const result = await parser.getScreenshot({ scale: s, partial: chunk });
      for (const p of (result.pages || [])) {
        if (p.data) out.push({ pageNumber: p.pageNumber, base64: Buffer.from(p.data).toString('base64') });
      }
    } finally {
      await parser.destroy();   // frees the canvases before the next chunk
    }
  }
  return out;
}

// Count pages with pdfjs, NOT pdf-lib.
//
// This used to be `PDFDocument.load(buffer).getPageCount()`. pdf-lib THROWS on PDFs with
// corrupt object refs ("Expected instance of PDFDict, but got instance of undefined") — and
// real seller-disclosure packets have them routinely (same corruption class as the RPA
// `Invalid object ref` packets in CLAUDE.md §4c). One in six of the packets on hand does it.
//
// The throw was caught upstream in reviewAnswers(), so it never crashed — it did something
// worse. The doc silently contributed ZERO images, and the review fell back to the
// document-block path: the very path whose blank-looking renders produce the bogus
// "left blank" flags this crisp-image renderer exists to eliminate. So the packets that most
// need crisp rendering were precisely the ones that never got it, quietly.
//
// pdfjs tolerates the corruption and reads these files fine (the 80-page packet pdf-lib
// choked on counts and renders correctly). It's already our renderer, so this also drops a
// dependency rather than adding one.
async function pdfPageCount(buffer) {
  const parser = new PDFParse({
    data: new Uint8Array(buffer),
    CanvasFactory,
    ...(STANDARD_FONT_DATA_URL ? { standardFontDataUrl: STANDARD_FONT_DATA_URL } : {}),
  });
  try {
    const info = await parser.getInfo();
    return Number(info.total) || 0;
  } finally {
    await parser.destroy();
  }
}

// Render every page (up to maxPages). Kept for callers that want the whole document.
async function renderAllPagesAsImages(buffer, scale, maxPages) {
  const count = await pdfPageCount(buffer);
  if (!count) return [];
  const total = Math.min(count, maxPages || count);
  const pages = Array.from({ length: total }, (_, i) => i + 1);
  return renderPagesAsImages(buffer, pages, scale);
}

// A document this size or smaller skips the classifier entirely and has EVERY page reviewed.
//
// WHY: classifyQAPages is a model call, and it is NOT deterministic. Measured on one 46-page
// file, same prompt, three runs: [26,27,29,30,31,32,33,37,38,39,40] / [26,27,29,30,31,32,33,37,38]
// / [26,27,29,30,31,32,33,37,38]. Pages 39-40 were audited once and silently skipped twice.
// Which pages get audited is a coin flip.
//
// That gamble was survivable while an unseen page produced a FALSE FLAG (loud, a human caught
// it). It stopped being survivable once the prompt was scoped to forbid flagging pages it cannot
// see: now an unseen page produces SILENCE. On 8 Willow Way the TDS Section C page never reached
// the model, so C2/C12/C13/C14 — all four marked Yes with a blank explanation line — drew no flag
// at all. A silent miss on a document a buyer signs is worse than a false flag.
//
// The classifier exists to avoid rendering 60 pages of a big combined packet. It has no business
// gambling on a 3-page TDS. So for a small single-form PDF, review every page: deterministic, and
// CHEAPER (it also drops a classify call). Big packets still classify, but now record what was
// skipped, so a miss can never be silent again.
const QA_REVIEW_ALL_MAX_PAGES = 12;

// Stage A: ask the model which page numbers carry seller-answered content.
async function classifyQAPages(thumbs, label = '') {
  const content = [];
  for (const t of thumbs) {
    content.push({ type: 'text', text: `Page ${t.pageNumber}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: t.base64 } });
  }
  content.push({ type: 'text', text: CLASSIFY_PROMPT });
  const raw = await callClaude(content, 8000, `classify | ${label || 'doc'} | ${thumbs.length} page thumb(s)`);
  const parsed = parseJson(raw);
  return Array.isArray(parsed.qa_pages)
    ? parsed.qa_pages.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= 1)
    : [];
}

// Render one document's Q&A pages to crisp PNGs (stage A classify + stage B hi-res).
// Returns [] when the doc has no Q&A pages (e.g. an NHD report or booklet).
// Returns { images, selection } — selection is a one-line human-readable record of WHICH pages
// were reviewed and which were skipped, so it can be carried into the usage ledger.
async function renderQAPageImages(buffer, name) {
  const pageCount = await pdfPageCount(buffer);
  if (!pageCount) return { images: [], selection: `${name}: unreadable (0 pages)` };

  let qaNums;
  let selection;

  if (pageCount <= QA_REVIEW_ALL_MAX_PAGES) {
    // Small single-form PDF (a TDS, an SPQ, a one-page explanations addendum): review it all.
    // No classifier, so no coin flip, and nothing can be silently dropped.
    qaNums = Array.from({ length: pageCount }, (_, i) => i + 1);
    selection = `${name}: all ${pageCount}pp (classifier bypassed)`;
  } else {
    let thumbs = await renderAllPagesAsImages(buffer, QA_THUMB_SCALE, QA_MAX_RENDER_PAGES);
    if (!thumbs.length) return { images: [], selection: `${name}: no pages rendered` };
    const thumbNums = thumbs.map((t) => t.pageNumber);
    qaNums = await classifyQAPages(thumbs, name);
    thumbs = null;   // drop ~46 thumbnails before rendering the hi-res pass

    // What the classifier THREW AWAY. Previously nothing recorded this, which is exactly how a
    // dropped TDS page hid for weeks: the ledger showed a review had run and said nothing about
    // the pages it never looked at.
    const kept = new Set(qaNums);
    const skipped = thumbNums.filter((n) => !kept.has(n));
    selection = `${name}: reviewed ${qaNums.length}/${thumbNums.length}pp [${qaNums.join(',') || 'none'}]`
      + (skipped.length ? ` SKIPPED [${skipped.join(',')}]` : '');
    if (skipped.length) {
      console.warn(`[disclosure-intake] ${name}: classifier SKIPPED ${skipped.length} page(s): ${skipped.join(', ')} `
        + '— these were NOT audited. A form on a skipped page draws no flags, correct or otherwise.');
    }
  }

  if (!qaNums.length) {
    console.log(`[disclosure-intake] ${name}: no Q&A pages classified`);
    return { images: [], selection };
  }

  // Render the Q&A pages straight from the original buffer. buildSubPdf() is gone: it
  // filtered out-of-range page numbers, which shifted the sub-PDF's pages relative to
  // qaNums, so every image after a dropped page got labelled with the WRONG page number.
  // `partial` renders exactly these pages and each one reports its own true pageNumber.
  const hi = await renderPagesAsImages(buffer, qaNums, QA_HIRES_SCALE);
  console.log(`[disclosure-intake] ${name}: rendered ${hi.length} Q&A page(s) hi-res (pages ${hi.map((p) => p.pageNumber).join(', ')})`);
  return {
    images: hi.map((p) => ({ name: `${name} qa-p${p.pageNumber}`, base64: p.base64 })),
    selection,
  };
}

// Parse the answer-review JSON into the { responseFlags, keyAnswers } shape callers expect.
function parseAnswerReview(raw) {
  const parsed = parseJson(raw);
  const responseFlags = Array.isArray(parsed.response_flags) ? parsed.response_flags
    .map((r) => ({
      form: String(r.form || '').trim(),
      item: String(r.item || '').trim(),
      issue: String(r.issue || '').trim(),
      discrepancy_type: String(r.discrepancy_type || '').trim().toLowerCase(),
      marked: String(r.marked || '').trim(),
      should_be: String(r.should_be || '').trim(),
      reason: String(r.reason || r.note || '').trim(),
      other_form: String(r.other_form || '').trim(),
      document: String(r.document || '').trim(),
      source: String(r.source || '').trim(),
    }))
    .filter((r) => r.form || r.item || r.reason || r.other_form || r.document || r.source) : [];
  const ka = parsed.key_answers || {};
  const keyAnswers = {
    spq_7e: String(ka.spq_7e || 'na').toLowerCase().trim(),
    hoa_any_no: String(ka.hoa_any_no || 'na').toLowerCase().trim(),
    fire_clearance: String(ka.fire_clearance || 'na').toLowerCase().trim(),
    fire_clearance_item: String(ka.fire_clearance_item || '').trim(),
    fhds: String(ka.fhds || 'na').toLowerCase().trim(),
  };
  return { responseFlags, keyAnswers };
}

// First non-"na" value wins per field (the SPQ/TDS usually land in one batch).
function mergeKeyAnswers(acc, next) {
  if (!next) return acc;
  if (acc.spq_7e === 'na' && next.spq_7e && next.spq_7e !== 'na') acc.spq_7e = next.spq_7e;
  if (acc.hoa_any_no === 'na' && next.hoa_any_no && next.hoa_any_no !== 'na') acc.hoa_any_no = next.hoa_any_no;
  if (acc.fire_clearance === 'na' && next.fire_clearance && next.fire_clearance !== 'na') {
    acc.fire_clearance = next.fire_clearance;
    if (next.fire_clearance_item) acc.fire_clearance_item = next.fire_clearance_item;
  }
  if (acc.fhds === 'na' && next.fhds && next.fhds !== 'na') acc.fhds = next.fhds;
  return acc;
}

// Answer review over crisp Q&A page images. Renders each doc's Q&A pages, batches the
// images under the request cap, and runs ANSWER_REVIEW_PROMPT on them. Falls back to the
// document-block review if nothing renders, so the review is never silently skipped.
async function reviewAnswers(docs) {
  let qaImages = [];
  const selections = [];
  for (const d of docs) {
    try {
      const buf = Buffer.from(d.base64 || '', 'base64');
      const { images, selection } = await renderQAPageImages(buf, d.name);
      qaImages = qaImages.concat(images);
      if (selection) selections.push(selection);
    } catch (err) {
      console.warn(`[disclosure-intake] Q&A render/classify failed for "${d.name}": ${err.message}`);
      selections.push(`${d.name}: RENDER FAILED (${err.message.slice(0, 40)}) — not audited`);
    }
  }
  console.log(`[disclosure-intake] page selection: ${selections.join(' | ') || '(none)'}`);
  if (!qaImages.length) {
    console.log('[disclosure-intake] no Q&A page images; falling back to document-block answer review');
    return reviewAnswersFromDocuments(docs);
  }

  // Batch the images under the request size/count cap.
  const batches = [];
  let cur = [], curSize = 0;
  for (const img of qaImages) {
    const sz = (img.base64 || '').length;
    if (cur.length && (cur.length >= QA_MAX_BATCH_IMAGES || curSize + sz > QA_MAX_BATCH_B64)) {
      batches.push(cur); cur = []; curSize = 0;
    }
    cur.push(img); curSize += sz;
  }
  if (cur.length) batches.push(cur);

  let responseFlags = [];
  const keyAnswers = { ...EMPTY_KEY_ANSWERS };
  for (let i = 0; i < batches.length; i++) {
    // labels is for the usage-sheet Note only — it is NOT sent to the model, so this
    // stays a pure logging change and the review behaviour is untouched.
    const labels = batches[i].map((img) => img.name || 'page');
    const content = batches[i].map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: img.base64 },
    }));
    content.push({ type: 'text', text: ANSWER_REVIEW_PROMPT });
    // Record WHICH pages were reviewed, not just how many. classifyQAPages is a model
    // call and is NOT deterministic (same 46-page file, three runs, two different page
    // sets), so "11 page(s)" alone can't tell you afterwards whether the page carrying a
    // given form was ever actually looked at.
    // The selection record rides along on batch 1 so the ledger row shows not just which pages
    // WERE reviewed but which were skipped — a miss is then visible in the Sheet, not silent.
    const selectionNote = i === 0 && selections.length ? ` || selection: ${selections.join(' ; ')}` : '';
    const raw = await callClaude(content, 48000, `answer-review-images | batch ${i + 1}/${batches.length} | ${batches[i].length} page(s): ${labels.join(', ')}${selectionNote}`);
    const parsed = parseAnswerReview(raw);
    if (parsed.responseFlags.length) responseFlags = responseFlags.concat(parsed.responseFlags);
    mergeKeyAnswers(keyAnswers, parsed.keyAnswers);
    console.log(`[disclosure-intake] answer-review image batch ${i + 1}/${batches.length} (${batches[i].length} page[s]): ${parsed.responseFlags.length} flag(s)`);
  }
  return { responseFlags, keyAnswers, dropped: [] };
}

// Document-block answer review (fallback): sends the whole PDF(s) to the model and lets
// Anthropic rasterize. Used when crisp Q&A-page rendering yields nothing. Same 413
// drop-biggest backstop as identifyForms.
async function reviewAnswersFromDocuments(docs) {
  let working = docs.slice().sort((a, b) => (b.base64 || '').length - (a.base64 || '').length);
  const dropped = [];
  while (working.length) {
    const content = working.map((d) => ({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: d.base64 },
      title: d.name,
    }));
    content.push({ type: 'text', text: ANSWER_REVIEW_PROMPT });
    try {
      // Generous ceiling: this is the heavy reasoning pass (read every marked answer,
      // pair Yes with explanation, run the contradiction checks) before a small JSON.
      const raw = await callClaude(content, 48000, docsNote('answer-review-docs', working));
      const { responseFlags, keyAnswers } = parseAnswerReview(raw);
      return { responseFlags, keyAnswers, dropped };
    } catch (err) {
      const tooLarge = /\b413\b|request_too_large|too\s*large/i.test(err.message || '');
      if (tooLarge && working.length > 1) {
        const big = working.shift();
        dropped.push(big.name);
        console.warn(`[disclosure-intake] answer-review: request too large — dropping biggest doc "${big.name}" and retrying with ${working.length} doc(s)`);
        continue;
      }
      throw err;
    }
  }
  return { responseFlags: [], keyAnswers: { ...EMPTY_KEY_ANSWERS }, dropped };
}

// Merge two form lists, de-duping on code (case-insensitive), then name.
function mergeForms(a, b) {
  const seen = new Set();
  const out = [];
  for (const f of [...(a || []), ...(b || [])]) {
    const key = (f.code || f.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// Identify across MANY docs (e.g. 22 PDFs from one unzipped attachment bundle) by
// batching them under Claude's request-size limit, identifying each batch, and
// merging the forms. The first non-empty address wins. One unzipped bundle can
// easily exceed 32MB of base64 in a single request, so batching is required.
// Run BOTH passes over one batch concurrently (latency ~ the slower of the two)
// and combine into the shape callers already expect.
async function identifyAndReview(batch) {
  const [idr, ansr] = await Promise.all([identifyForms(batch), reviewAnswers(batch)]);
  return {
    propertyAddress: idr.propertyAddress || '',
    forms: idr.forms || [],
    responseFlags: ansr.responseFlags || [],
    keyAnswers: ansr.keyAnswers || { ...EMPTY_KEY_ANSWERS },
    dropped: [...(idr.dropped || []), ...(ansr.dropped || [])],
  };
}

async function identifyFormsChunked(docs) {
  if (docs.length <= 1) return identifyAndReview(docs);
  const MAX_BATCH_B64 = 18 * 1024 * 1024; // keep each request well under the 32MB cap
  const MAX_BATCH_DOCS = 10;              // and bounded on page/doc count
  const batches = [];
  let cur = [], curSize = 0;
  for (const d of docs) {
    const sz = (d.base64 || '').length;
    if (cur.length && (cur.length >= MAX_BATCH_DOCS || curSize + sz > MAX_BATCH_B64)) {
      batches.push(cur); cur = []; curSize = 0;
    }
    cur.push(d); curSize += sz;
  }
  if (cur.length) batches.push(cur);

  let allForms = [], address = '', dropped = [], responseFlags = [];
  const keyAnswers = { ...EMPTY_KEY_ANSWERS };
  for (let i = 0; i < batches.length; i++) {
    const r = await identifyAndReview(batches[i]);
    allForms = mergeForms(allForms, r.forms);
    if (r.responseFlags && r.responseFlags.length) responseFlags = responseFlags.concat(r.responseFlags);
    // First batch with a real (non-na) answer wins — the SPQ/TDS live in one batch.
    if (r.keyAnswers) {
      if (keyAnswers.spq_7e === 'na' && r.keyAnswers.spq_7e && r.keyAnswers.spq_7e !== 'na') keyAnswers.spq_7e = r.keyAnswers.spq_7e;
      if (keyAnswers.hoa_any_no === 'na' && r.keyAnswers.hoa_any_no && r.keyAnswers.hoa_any_no !== 'na') keyAnswers.hoa_any_no = r.keyAnswers.hoa_any_no;
      if (keyAnswers.fire_clearance === 'na' && r.keyAnswers.fire_clearance && r.keyAnswers.fire_clearance !== 'na') {
        keyAnswers.fire_clearance = r.keyAnswers.fire_clearance;
        if (r.keyAnswers.fire_clearance_item) keyAnswers.fire_clearance_item = r.keyAnswers.fire_clearance_item;
      }
      if (keyAnswers.fhds === 'na' && r.keyAnswers.fhds && r.keyAnswers.fhds !== 'na') keyAnswers.fhds = r.keyAnswers.fhds;
    }
    if (!address && r.propertyAddress) address = r.propertyAddress;
    if (r.dropped && r.dropped.length) dropped = dropped.concat(r.dropped);
    console.log(`[disclosure-intake] identify batch ${i + 1}/${batches.length} (${batches[i].length} doc[s]): ${r.forms.length} form(s), ${(r.responseFlags || []).length} response flag(s)`);
  }
  return { propertyAddress: address, forms: allForms, responseFlags, keyAnswers, dropped };
}

// ----------------------------------------------------------------------------
// Step 2 — reconcile the accumulated received set against the deal's audit list.
// Opus matches shorthand to forms and reasons about conditional/"if any" items.
// ----------------------------------------------------------------------------
async function reconcile(auditList, received) {
  const receivedText = received.map((f) => `- ${f.code ? f.code + ' — ' : ''}${f.name}`).join('\n') || '(nothing identified yet)';
  const prompt =
    'You are a California transaction coordinator reconciling a BUYER-side disclosure delivery against this deal\'s ' +
    'required-documents list. Decide, for each required item, whether it has been received.\n\n' +
    'REQUIRED (the deal audit list — focus on disclosure documents; ignore purchase/escrow/closing-only items unless ' +
    'they are clearly disclosure items):\n' + auditList + '\n\n' +
    'RECEIVED SO FAR (accumulated across all emails for this deal):\n' + receivedText + '\n\n' +
    'Rules:\n' +
    '- Use your knowledge of CAR forms to match the list\'s shorthand (TDS, SPQ, SBSA, LA AVID, BA AVID, LPD, WCMD, ' +
    'SFLS, MCA, DIA, NHD, RFR, etc.) to the received forms.\n' +
    '- Conditionals: items marked "if any", "only SFR required", "once completed", "Contingency Release(s)", or that ' +
    'are inherently later/escrow items, are "not_applicable" unless clearly required and absent.\n' +
    '- NHD is a PRESENT/MISSING item, never "verify". If a Natural Hazard Disclosure report (any provider — FANHD, ' +
    'JCP-LGS, Disclosure Source, etc.) is in the package, put the NHD requirement in "present". If it is absent, put it ' +
    'in "still_needed".\n' +
    '- Earthquake / Environmental Hazards booklet RECEIPT is a PRESENCE check, never "verify". If the receipt/' +
    'acknowledgment page for the "Homeowner\'s Guide to Environmental Hazards and Earthquake Safety" booklet is in the ' +
    'package — the standard CAR receipt OR a custom brokerage equivalent (e.g. "Receipt for Links to Booklets", or any ' +
    'page acknowledging receipt of the environmental hazards / earthquake safety / HERS / lead booklets) — put it in ' +
    '"present". The booklet ITSELF does NOT satisfy this; only an actual signed/signable acknowledgment page does, so ' +
    'if only the informational booklet pages were sent, treat the receipt as absent. If absent, put it in ' +
    '"still_needed". Do NOT add a "confirm signed" note for it.\n' +
    '- "verify" is reserved ONLY for genuine per-answer content confirmations where the form is present but a specific ' +
    'answer should be eyeballed (e.g. "SPQ 7E: Yes, pre-1978 build"). Keep verify minimal; do NOT put whole documents ' +
    'or receipts there.\n' +
    '- Do NOT count a form as received just because it is referenced inside another form.\n\n' +
    'Respond with ONLY this JSON (no prose, no fences):\n' +
    '{"overall":"complete|outstanding","present":["..names.."],"still_needed":["..names.."],' +
    '"verify":[{"item":"..","note":".."}],"not_applicable":[{"item":"..","note":".."}],"summary":"one sentence"}';

  // Reconcile reasons item-by-item over the whole audit list before emitting JSON;
  // give thinking + output ample room so it never truncates mid-answer.
  // Name the forms, don't just count them. The count alone cannot distinguish "identify
  // never found the TDS" from "identify found it and reconcile discarded it" — which are
  // opposite bugs with opposite fixes. Netlify logs age out; the usage sheet does not, so
  // this belongs in the Note where it survives.
  const recvCodes = (received || []).map((f) => (f && (f.code || f.name)) || '?').join(', ');
  return parseJson(await callClaude([{ type: 'text', text: prompt }], 16000,
    `reconcile | ${(received || []).length} received form(s): ${recvCodes || '(none)'}`));
}

function bullets(list, fmt) {
  if (!Array.isArray(list) || !list.length) return '(none)';
  return list.map((x) => `• ${fmt(x)}`).join('\n');
}

async function sendCallback(callbackUrl, payload) {
  if (!callbackUrl) { console.warn('[disclosure-intake] no callback URL configured'); return; }
  try {
    const res = await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    console.log(`[disclosure-intake] callback dispatched (status ${res.status})`);
  } catch (err) {
    console.error(`[disclosure-intake] callback failed (non-fatal): ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// Reconcile the accumulated received set for a deal against its audit list and
// POST the result to the callback. Shared by single-delivery mode and finalize.
// ----------------------------------------------------------------------------
async function reconcileAndCallback(address, received, auditList, callback, responseFlags = [], keyAnswers = {}, threadId = '', droppedDocs = []) {
  let listText = (auditList && String(auditList).trim()) || '';
  if (!listText) listText = await fetchAuditListByAddress(address);
  if (!listText) throw new Error(`No audit list for "${address}" — pass auditList in the body, or add a matching row to the AUDIT_LIST_CSV_URL sheet.`);
  const result = await reconcile(listText, received);

  // Cross-check the seller's answers against our own records (Year Built, HOA from
  // the master sheet) — facts the disclosure package may not contain. Adds flags the
  // package-only check can't catch (e.g. SPQ 7E when the build year isn't in the pack).
  const ctx = await fetchDealContext(address);
  const ka = keyAnswers || {};
  // Tolerant parse: the model may answer "Yes" / "marked yes" / "y" etc., not exactly "yes".
  const norm7e = String(ka.spq_7e || '').toLowerCase();
  const sev = (/\bna\b|not\s*applicable/.test(norm7e)) ? '' : ((/\byes\b/.test(norm7e) || norm7e === 'y') ? 'yes' : ((/\bno\b/.test(norm7e) || norm7e === 'n') ? 'no' : ''));
  const hoaNo = /\byes\b/.test(String(ka.hoa_any_no || '').toLowerCase());
  const debugContext = `yearBuilt=${ctx.yearBuilt} hasHoa=${ctx.hasHoa} spq_7e=${ka.spq_7e}(->${sev || 'na'}) hoa_any_no=${ka.hoa_any_no} fire_clearance=${ka.fire_clearance || 'na'}(${ka.fire_clearance_item || '?'}) fhds=${ka.fhds || 'na'}`;
  console.log(`[disclosure-intake] context check ${address}: ${debugContext}`);
  const ctxFlags = [];
  const hasFlag = (re) => (Array.isArray(responseFlags) ? responseFlags : []).some((f) => re.test(`${f.form || ''} ${f.item || ''} ${f.reason || ''}`));
  if (ctx.yearBuilt && sev && !hasFlag(/7e/i)) {
    if (ctx.yearBuilt >= 1978 && sev === 'yes') {
      ctxFlags.push({ form: 'SPQ', item: '7E', issue: 'answer_contradicts_package', discrepancy_type: 'incorrect', marked: 'Yes', should_be: 'No', reason: `the property was built in ${ctx.yearBuilt}` });
    } else if (ctx.yearBuilt < 1978 && sev === 'no') {
      ctxFlags.push({ form: 'SPQ', item: '7E', issue: 'answer_contradicts_package', discrepancy_type: 'incorrect', marked: 'No', should_be: 'Yes', reason: `the property was built in ${ctx.yearBuilt}` });
    }
  }
  if (ctx.hasHoa === true && hoaNo && !hasFlag(/hoa|common\s*interest|c1[234]|6g|section\s*14/i)) {
    ctxFlags.push({ form: 'SPQ', item: '14', issue: 'answer_contradicts_package', discrepancy_type: 'incorrect', marked: 'No', should_be: 'Yes', reason: 'the property is in an HOA' });
  }
  if (ctxFlags.length) responseFlags = (Array.isArray(responseFlags) ? responseFlags : []).concat(ctxFlags);

  // SFLS carries reference sqft in the audit list (e.g. "SFLS - Tax: 2,230 MLS: 2,854 sqft").
  // Many brokerages don't require the SFLS form; we just want confirmation. Strip the sqft
  // and, when it's still outstanding, turn it into a clear ask to the listing side.
  const fmtSfls = (name, stillNeeded) => {
    if (/^\s*sfls\b/i.test(String(name || ''))) {
      return stillNeeded
        ? 'SFLS - If your brokerage does not require this form, please email us confirming this'
        : 'SFLS';
    }
    return name;
  };

  const present = (Array.isArray(result.present) ? result.present : []).map((n) => fmtSfls(n, false));
  let verify = Array.isArray(result.verify) ? result.verify : [];
  const na = Array.isArray(result.not_applicable) ? result.not_applicable : [];

  // Resolve the compliance list's "Confirm X marked YES" items ourselves from the
  // answers we read during identify, instead of handing them back for a human to
  // eyeball. Each entry maps a verify item (by text) to the mark we read; the expected
  // answer is parsed from the item text (defaults to Yes). When the mark matches we
  // note it as checked; when it doesn't we raise a revision request. Items we cannot
  // read (no SPQ, no FHDS, etc.) stay under VERIFY. The fire-clearance question's
  // letter moves by SPQ revision (17F on 12/24, 17G on 6/26); identify located it by
  // description and returned whatever letter the form printed.
  const fireItem = String(ka.fire_clearance_item || '').trim() || 'brush/vegetation clearance';
  const yesno = (v) => {
    const s = String(v || '').toLowerCase();
    if (/\bna\b|not\s*applicable/.test(s)) return 'na';
    if (/yes|^y$/.test(s)) return 'yes';
    if (/\bno\b|^n$/.test(s)) return 'no';
    if (/blank/.test(s)) return 'blank';
    return '';
  };
  // hoa_any_no is "yes" when ANY HOA question is No/blank, so the HOA reading (are they
  // all Yes?) is its inverse.
  const hoaReading = ka.hoa_any_no === 'no' ? 'yes' : (ka.hoa_any_no === 'yes' ? 'no' : 'na');
  const VERIFY_READINGS = [
    { re: /hoa|common\s*interest|\bc\s*,?\s*1[234]\b|\b6g\b|section\s*14/i, mark: hoaReading, refDefault: 'HOA disclosures', reasonBad: 'the property is in an HOA / common interest development, so it should be Yes' },
    { re: /brush|defensible|vegetation|fire\s*hazard|wildfire|17\s*[fg]\b/i, mark: yesno(ka.fire_clearance), refDefault: `SPQ ${fireItem}`, reasonBad: 'the property is in a high fire hazard area, so it should be Yes' },
    { re: /\bfhds\b|fire\s*hardening/i, mark: yesno(ka.fhds), refDefault: 'FHDS', reasonBad: 'Section 2 and/or Section 3 are not completed as required; please send the completed FHDS' },
    { re: /\b7e\b|pre[-\s]*1978|lead[-\s]*based\s*paint/i, mark: yesno(ka.spq_7e), refDefault: 'SPQ 7E', reasonBad: 'the property was built before 1978, so it should be Yes' },
  ];
  const confirmedReadings = [];
  const verifyKept = [];
  for (const v of verify) {
    const hay = `${v.item || ''} ${v.note || ''}`;
    const r = VERIFY_READINGS.find((x) => x.re.test(hay));
    if (!r || r.mark === '' || r.mark === 'na') { verifyKept.push(v); continue; }
    if (hasFlag(r.re)) continue; // already resolved via the sheet-based context check above
    const expected = /marked\s*no\b|=\s*no\b/i.test(hay) ? 'no' : 'yes';
    // Reference the item the way the compliance list named it (e.g. "TDS C,12,13,14").
    const ref = `${v.item ? v.item + ' ' : ''}${String(v.note || '').replace(/^\s*confirm\s+/i, '').replace(/\s*marked\s+(yes|no)\b.*$/i, '').trim()}`.trim() || r.refDefault;
    if (r.mark === expected) {
      confirmedReadings.push(`${ref}: marked ${expected === 'yes' ? 'Yes' : 'No'} as expected`);
    } else {
      const markWord = r.mark === 'no' ? 'No' : (r.mark === 'blank' ? 'left blank' : r.mark);
      const reason = /not\s*completed|send the completed/i.test(r.reasonBad) ? r.reasonBad : `marked ${markWord}, but ${r.reasonBad}`;
      responseFlags = (Array.isArray(responseFlags) ? responseFlags : []).concat([{ form: '', item: ref, issue: 'verify_mismatch', reason }]);
    }
  }
  verify = verifyKept;

  // An explanation the seller DID write, but on a separate addendum sheet and at the ITEM level
  // (one paragraph for SPQ 7) when the form asks per SUB-item (7A / 7B / 7C).
  //
  // Two things are both wrong here. Auto-accepting it is wrong: one summary must never satisfy a
  // whole section on a document a buyer signs. But telling the seller "no explanation is
  // provided" is ALSO wrong, and worse in practice: they DID provide one and they signed it, so
  // we would be chasing them for work already done, and they would reply with the sheet.
  //
  // So it is neither a revise nor a confirm. It leaves the flag list entirely, which keeps it out
  // of the chase email and out of followupCount, and becomes a VERIFY line, the section a human
  // already reads. The pipeline never decides whether that paragraph covers the sub-item. A
  // person does. That is the whole point.
  const allFlags = Array.isArray(responseFlags) ? responseFlags : [];
  const addendumFlags = allFlags.filter((f) => f.issue === 'explanation_on_addendum');
  const flags = allFlags.filter((f) => f.issue !== 'explanation_on_addendum');
  for (const f of addendumFlags) {
    const noDash = (s) => String(s || '').replace(/\s*[—–]\s*/g, ', ').trim();
    const ref = [f.form, f.item].filter(Boolean).join(' ') || 'this item';
    const where = noDash(f.document);
    const quote = noDash(f.reason);
    verify.push({
      item: ref,
      note: `explanation found on a separate addendum${where ? ` (${where})` : ''}; verify it covers this sub-item`
        + (quote ? `. It reads: "${quote}"` : ''),
    });
  }
  if (addendumFlags.length) {
    console.log(`[disclosure-intake] ${addendumFlags.length} item(s) explained on a separate addendum, routed to VERIFY `
      + `(NOT chased from the seller): ${addendumFlags.map((f) => [f.form, f.item].filter(Boolean).join(' ')).join(', ')}`);
  }

  // Form-version currency: flag any received form whose printed revision is OLDER
  // than the current version listed in the Current Form Versions sheet, so we can
  // request the up-to-date version from the listing side.
  const formVersions = await fetchFormVersions();
  const outdated = findOutdatedForms(received, formVersions);
  const outdatedLine = (o) => `${o.name}: received ${o.received}, current ${o.current}`;
  const revisionsRead = (received || []).filter((f) => f.revision).map((f) => `${f.code || f.name}=${f.revision}`).join(', ') || '(none read)';
  const versionsDebug = `versionsSheetRows=${formVersions.length} outdated=${outdated.length} | revisionsRead: ${revisionsRead}`;
  console.log(`[disclosure-intake] version check ${address}: ${versionsDebug}`);

  // Split the reconciled "still needed" into what we must REQUEST from the listing
  // side vs what our team prepares in-house. Only the listing-side items drive the
  // count, the chase email, and the status; prepared-by-us items stay visible in
  // the PS comment as our own to-do.
  const stillNeededAll = (Array.isArray(result.still_needed) ? result.still_needed : []).map((n) => fmtSfls(n, true));
  const preparedByUs = stillNeededAll.filter(isPreparedByUs);
  // Brokerage Affiliate Disclosures ("if any" items requested at opening): if not in the
  // package we assume the brokerage has none, so never re-request — move to not_applicable.
  const isAssumeNone = (name) => /brokerage\s*affiliate|affiliated\s*business\b/i.test(String(name || ''));
  const assumeNone = stillNeededAll.filter((x) => !isPreparedByUs(x) && isAssumeNone(x));
  for (const x of assumeNone) na.push({ item: x, note: 'Requested at opening; if not provided, assume the brokerage has none on file.' });
  const stillNeeded = stillNeededAll.filter((x) => !isPreparedByUs(x) && !isAssumeNone(x));
  // Anything to follow up on with the listing side = missing docs OR response flags
  // OR outdated form versions.
  const followupCount = stillNeeded.length + flags.length + outdated.length;
  const overall = followupCount ? (result.overall === 'complete' ? 'outstanding' : (result.overall || 'outstanding')) : 'complete';

  // Flag formatting. "Revise" flags (the seller's answer should be corrected) use the
  // standard wording; everything else is a confirm/clarify line. No em dashes.
  const stripDashes = (s) => String(s || '').replace(/\s*[—–]\s*/g, ', ');
  const flagRef = (f) => [f.form, f.item].filter(Boolean).join(' ');
  const isRevise = (f) => !!f.should_be || !!f.other_form || !!f.document || !!f.source
    || f.issue === 'answer_contradicts_package' || f.issue === 'detail_incomplete'
    || f.issue === 'verify_mismatch' || f.issue === 'entity_signer'
    || f.issue === 'yes_no_explanation' || f.issue === 'unanswered' || f.issue === 'explanation_unclear';
  const sourceVerb = (src) => (/(documents|instructions)\b/i.test(src) ? 'indicate' : 'indicates');
  // Type-specific wording so each correction reads like a TC, not a template.
  const reviseLine = (f) => {
    const ref = flagRef(f);
    // TDS Section II item marked present but its required detail (type/age/location)
    // is blank: ask the listing side to complete it rather than treating it as a Yes/No.
    if (f.issue === 'detail_incomplete') {
      return `${ref}: ${stripDashes(f.reason)}; please specify it or mark Unknown.`;
    }
    // A compliance-list "Confirm marked YES" item we read and found not as expected,
    // or a seller who signed as an entity. The reason is already a complete request.
    if (f.issue === 'verify_mismatch') {
      return `${ref}: ${stripDashes(f.reason)}.`;
    }
    if (f.issue === 'entity_signer') {
      return stripDashes(f.reason);
    }
    // Response-completion issues: the seller needs to complete/clarify the answer, so
    // these are revision requests (not "confirm") and never a Yes/No correction.
    if (f.issue === 'yes_no_explanation') {
      return `${ref}: ${stripDashes(f.reason) || 'marked Yes with no written explanation'}; please provide an explanation.`;
    }
    if (f.issue === 'unanswered') {
      return `${ref}: ${stripDashes(f.reason) || 'left blank / unanswered'}; please answer this question.`;
    }
    if (f.issue === 'explanation_unclear') {
      return `${ref}: ${stripDashes(f.reason) || 'the written explanation is unclear'}; please clarify it.`;
    }
    const marked = f.marked || 'No';
    const t = f.discrepancy_type || (f.other_form ? 'inconsistent' : f.document ? 'document' : f.source ? 'transaction' : 'incorrect');
    if (t === 'inconsistent' && f.other_form) {
      const detail = stripDashes(f.reason);
      return detail
        ? `${ref}: Marked ${marked}; however, this is inconsistent with ${stripDashes(f.other_form)}, where ${detail}. The response should be revised for consistency.`
        : `${ref}: Marked ${marked}; however, this response is inconsistent with ${stripDashes(f.other_form)}. The response should be revised for consistency.`;
    }
    if (t === 'document' && f.document) {
      return `${ref}: Marked ${marked}; however, ${stripDashes(f.document)} is included in the disclosure package. The response should be revised to ${f.should_be || 'Yes'}.`;
    }
    if (t === 'transaction' && f.source) {
      return `${ref}: Marked ${marked}; however, ${stripDashes(f.source)} ${sourceVerb(f.source)} otherwise. The response should be revised accordingly.`;
    }
    return `${ref}: Marked ${marked}; however, ${stripDashes(f.reason)}. The response should be revised to ${f.should_be || 'Yes'}.`;
  };
  const ISSUE_TEXT = { unanswered: 'left blank / unanswered', yes_no_explanation: 'marked Yes with no written explanation', explanation_unclear: 'the written explanation is unclear' };
  const confirmLine = (f) => `${flagRef(f)}: ${stripDashes(f.reason) || ISSUE_TEXT[f.issue] || 'please confirm this item'}`;
  const flagLine = (f) => (isRevise(f) ? reviseLine(f) : confirmLine(f));
  const reviseFlags = flags.filter(isRevise);
  const confirmFlags = flags.filter((f) => !isRevise(f));

  // BIW alert: a Buyer Inspection Waiver should NOT be forwarded to the buyer with the
  // disclosures. If one is in the package, flag it for removal (internal note, not the
  // chase email). Matches BIW specifically — never the BIA buyer inspection ADVISORY.
  const biwFound = (received || []).some((f) => /\bbiw\b|buyer'?s?\s*inspection\s*waiver|waiver\s*of\s*(the\s*)?(right\s*to\s*)?inspect|inspection\s*waiver/i.test(`${f.code || ''} ${f.name || ''}`));
  const biwAlert = biwFound
    ? 'ACTION: A Buyer Inspection Waiver (BIW) is in this package. Remove it before forwarding the disclosures to the buyer.'
    : '';

  const psComment =
    `Disclosure intake — ${address}\n` +
    `Status: ${overall} | ${present.length} of the required disclosures received; ${stillNeeded.length} to request, ${flags.length} response(s) to clarify\n\n` +
    (biwAlert ? `** ${biwAlert} **\n\n` : '') +
    `TO REQUEST FROM LISTING SIDE:\n${bullets(stillNeeded, (x) => x)}\n\n` +
    (outdated.length ? `OUTDATED VERSIONS (request current):\n${bullets(outdated, outdatedLine)}\n\n` : '') +
    (reviseFlags.length ? `RESPONSES TO REVISE:\n${bullets(reviseFlags, reviseLine)}\n\n` : '') +
    (confirmFlags.length ? `RESPONSES TO CONFIRM:\n${bullets(confirmFlags, confirmLine)}\n\n` : '') +
    `RECEIVED:\n${bullets(present, (x) => x)}\n\n` +
    (preparedByUs.length ? `PREPARED BY US (do not request):\n${bullets(preparedByUs, (x) => x)}\n\n` : '') +
    (confirmedReadings.length ? `CONFIRMED (we checked these):\n${bullets(confirmedReadings, (x) => x)}\n\n` : '') +
    (verify.length ? `VERIFY:\n${bullets(verify, (x) => `${x.item}: ${x.note}`)}\n\n` : '') +
    (na.length ? `NOT APPLICABLE / LATER:\n${bullets(na, (x) => `${x.item}: ${x.note}`)}\n` : '');

  // Ready-to-send chase email. Zap B drops this into a Gmail draft when followup_count
  // > 0 (missing docs and/or responses to clarify). No em dashes (Megan's standing
  // preference); it's a draft she reviews, so greeting/recipient are finalized then.
  const signer = process.env.DISCLOSURE_SIGNER_NAME || 'Megan';
  const chaseEmailSubject = `Outstanding disclosures for ${address}`;
  let chaseEmailBody = '';
  if (followupCount) {
    chaseEmailBody =
      'Hi,\n\n' +
      'Thank you for sending the disclosures. After reviewing the package against our file, a few items still need attention.\n' +
      (stillNeeded.length
        ? '\nStill outstanding:\n' + stillNeeded.map((x) => `- ${x}`).join('\n') + '\n'
        : '') +
      (outdated.length
        ? '\nThe following were sent in an outdated version. Please send the current version:\n' + outdated.map((o) => `- ${o.name} (received ${o.received}; current ${o.current})`).join('\n') + '\n'
        : '') +
      (reviseFlags.length
        ? '\nPlease revise or complete the following disclosures:\n' + reviseFlags.map((f) => `- ${reviseLine(f)}`).join('\n') + '\n'
        : '') +
      (confirmFlags.length
        ? '\nPlease confirm the following:\n' + confirmFlags.map((f) => `- ${confirmLine(f)}`).join('\n') + '\n'
        : '') +
      '\nWhen you have a moment, please send these over so we can wrap up our review. ' +
      'If any have already been provided or do not apply, just let me know.\n\n' +
      `Thanks!\n${signer}`;
    // Backstop for Megan's no-em-dash rule across the whole email body.
    chaseEmailBody = stripDashes(chaseEmailBody);
  }

  // A dropped document is SILENT data loss: the 413 backstop discards the biggest doc to
  // make the request fit, and that is almost always the disclosure package itself. Every
  // form in it then reads as "never received" and gets chased from the listing side. This
  // must surface in the output the human actually reads, not only in an ephemeral log.
  const droppedList = Array.isArray(droppedDocs) ? droppedDocs.filter(Boolean) : [];
  const droppedAlert = droppedList.length
    ? `WARNING: ${droppedList.length} document(s) were too large to send to the model and were NOT reviewed: `
      + `${droppedList.join(', ')}. Any form inside them is reported as missing. Re-run with these split up before trusting this result.`
    : '';
  if (droppedList.length) console.error(`[disclosure-intake] ${address}: ${droppedAlert}`);

  const payload = {
    property_address: address,
    gmail_thread_id: threadId,
    // NOTE: overall_status is deliberately left alone. Zapier/Process Street may filter on
    // its existing values, so a new enum could break the downstream flow silently. The
    // drop is surfaced as its own field instead; map dropped_alert into the email/PS card.
    overall_status: overall,
    dropped_docs_text: droppedList.join(', '),
    dropped_alert: droppedAlert,
    still_needed_count: stillNeeded.length,
    response_flags_count: flags.length,
    outdated_count: outdated.length,
    followup_count: followupCount,
    // Received Count = how many of THIS deal's required disclosures are in hand
    // (meaningful for a TC). The raw count of distinct forms parsed across all
    // deliveries is kept separately as received_forms_total for diagnostics.
    received_count: present.length,
    received_forms_total: received.length,
    still_needed_text: stillNeeded.join(', '),
    prepared_by_us_text: preparedByUs.join(', '),
    response_flags_text: flags.map(flagLine).join('; '),
    outdated_versions_text: outdated.map(outdatedLine).join('; '),
    biw_found: biwFound ? 'yes' : 'no',
    biw_alert: biwAlert,
    context_debug: debugContext,
    versions_debug: versionsDebug,
    summary: result.summary || '',
    ps_comment: psComment,
    chase_email_subject: chaseEmailSubject,
    chase_email_body: chaseEmailBody,
    result: { present, still_needed: stillNeeded, prepared_by_us: preparedByUs, confirmed: confirmedReadings, verify, not_applicable: na, response_flags: flags, outdated_versions: outdated },
  };

  console.log(`[disclosure-intake] ${address}: ${overall} — ${stillNeeded.length} to request, ${flags.length} response flag(s), ${preparedByUs.length} prepared by us`);
  await sendCallback(callback, payload);
}

exports.handler = async function (event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { console.error('[disclosure-intake] invalid JSON body'); return { statusCode: 400 }; }

  // Modes:
  //   default       — { documents, ... }            ingest + reconcile + callback (single delivery)
  //   accumulate     — { documents, batchId,
  //                      accumulate_only:true }       ingest only, NO callback (per-attachment loop)
  //   finalize       — { batchId, finalize:true }     reconcile the batch's deal + callback once
  const {
    auditList, documents, propertyAddress = '', callbackUrl, threadId = '',
    accumulate_only: accumulateOnly = false, finalize = false, batchId = '',
  } = body;
  const callback = callbackUrl || CALLBACK_URL_ENV;
  // Gmail thread of the triggering email, passed straight through to the callback so
  // Zap B can draft the chase as a reply in that thread. Accept threadId or thread_id.
  const gmailThreadId = threadId || body.thread_id || '';

  try {
    const store = getStore(blobsConfig(STATE_STORE));

    // FINALIZE: a batch of accumulate-only POSTs is done. Gather every per-delivery
    // slot written for this batch, merge them into the deal's persistent received set
    // (done here, single-threaded, so it's race-free), reconcile, and call back once.
    if (finalize) {
      let address = canonicalAddress(propertyAddress || '');
      if (!address && batchId) {
        const map = await store.get('batch:' + batchId, { type: 'json' });
        address = (map && map.address) || '';
      }
      if (!address) {
        // Nothing was accumulated for this batch (e.g. a non-disclosure email where
        // everything got filtered out). Skip quietly rather than emit an error.
        console.warn(`[disclosure-intake] finalize: nothing accumulated for batch ${batchId || 'n/a'}, skipping`);
        return { statusCode: 200 };
      }
      const key = normalizeAddress(address);
      const slotKeys = [];
      let batchForms = [];
      let batchFlags = [];
      const batchKeyAnswers = { spq_7e: 'na', hoa_any_no: 'na', fire_clearance: 'na', fire_clearance_item: '', fhds: 'na' };
      if (batchId) {
        const listing = await store.list({ prefix: `recv:${batchId}:` });
        for (const b of (listing.blobs || [])) {
          slotKeys.push(b.key);
          const item = await store.get(b.key, { type: 'json' });
          if (item && Array.isArray(item.forms)) batchForms = mergeForms(batchForms, item.forms);
          if (item && Array.isArray(item.responseFlags)) batchFlags = batchFlags.concat(item.responseFlags);
          if (item && item.keyAnswers) {
            if (batchKeyAnswers.spq_7e === 'na' && item.keyAnswers.spq_7e && item.keyAnswers.spq_7e !== 'na') batchKeyAnswers.spq_7e = item.keyAnswers.spq_7e;
            if (batchKeyAnswers.hoa_any_no === 'na' && item.keyAnswers.hoa_any_no && item.keyAnswers.hoa_any_no !== 'na') batchKeyAnswers.hoa_any_no = item.keyAnswers.hoa_any_no;
            if (batchKeyAnswers.fire_clearance === 'na' && item.keyAnswers.fire_clearance && item.keyAnswers.fire_clearance !== 'na') {
              batchKeyAnswers.fire_clearance = item.keyAnswers.fire_clearance;
              if (item.keyAnswers.fire_clearance_item) batchKeyAnswers.fire_clearance_item = item.keyAnswers.fire_clearance_item;
            }
            if (batchKeyAnswers.fhds === 'na' && item.keyAnswers.fhds && item.keyAnswers.fhds !== 'na') batchKeyAnswers.fhds = item.keyAnswers.fhds;
          }
        }
      }
      const prior = (await store.get(key, { type: 'json' })) || { address, received: [] };
      const received = mergeForms(prior.received, batchForms);
      await store.setJSON(key, { address, received, updatedAt: Date.now() });
      console.log(`[disclosure-intake] finalize ${address}: merged ${batchForms.length} from ${slotKeys.length} slot(s) -> ${received.length} total`);
      for (const k of slotKeys) { try { await store.delete(k); } catch (e) { /* cleanup best-effort */ } }
      await reconcileAndCallback(address, received, auditList, callback, batchFlags, batchKeyAnswers);
      return { statusCode: 200 };
    }

    // INGEST: load + identify this delivery's documents.
    const docs = await loadDocuments(documents);
    if (!docs.length) {
      // An empty delivery is normal in a loop (e.g. the body-Drive-links POST when an
      // email has only attachments). Skip quietly in accumulate mode.
      if (accumulateOnly) { console.log('[disclosure-intake] accumulate-only with no documents, skipping'); return { statusCode: 200 }; }
      throw new Error('No documents could be loaded (need fetchable url or base64)');
    }

    const { propertyAddress: detectedAddr, forms: newForms, responseFlags: newFlags = [], keyAnswers: newKeyAnswers = {}, dropped } = await identifyFormsChunked(docs);
    if (dropped && dropped.length) console.warn(`[disclosure-intake] dropped oversized doc(s) to fit the model: ${dropped.join(', ')}`);
    const address = canonicalAddress(detectedAddr || propertyAddress || '');
    if (!address) throw new Error('Could not read a property address from the documents');
    const key = normalizeAddress(address);
    console.log(`[disclosure-intake] ${address}: identified ${newForms.length} form(s) in this delivery`);

    // ACCUMULATE-ONLY (per-attachment loop): write this delivery's forms to a UNIQUE
    // per-delivery slot keyed by batch (no shared read-modify-write, so concurrent
    // background functions can't clobber each other). finalize merges the slots later.
    if (accumulateOnly) {
      const slot = `recv:${batchId || 'nobatch'}:${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      await store.setJSON(slot, { address, forms: newForms, responseFlags: newFlags, keyAnswers: newKeyAnswers });
      if (batchId) await store.setJSON('batch:' + batchId, { address, updatedAt: Date.now() });
      console.log(`[disclosure-intake] ${address}: accumulate-only, stored ${newForms.length} form(s), ${newFlags.length} flag(s) in slot (batch ${batchId || 'n/a'})`);
      return { statusCode: 200 };
    }

    // SINGLE DELIVERY: accumulate into the persistent set + reconcile + callback now.
    const prior = (await store.get(key, { type: 'json' })) || { address, received: [] };
    const received = mergeForms(prior.received, newForms);
    await store.setJSON(key, { address, received, updatedAt: Date.now() });
    console.log(`[disclosure-intake] ${address}: ${received.length} form(s) received so far (was ${prior.received.length})`);
    await reconcileAndCallback(address, received, auditList, callback, newFlags, newKeyAnswers, gmailThreadId, dropped);
    return { statusCode: 200 };
  } catch (err) {
    console.error('[disclosure-intake] ERROR:', err.message);
    // Stay quiet on accumulate-only ingest errors (finalize will surface real issues);
    // only emit an error callback for visible single-delivery / finalize calls.
    if (!accumulateOnly) {
      await sendCallback(callback, {
        property_address: propertyAddress || '',
        gmail_thread_id: gmailThreadId,
        overall_status: 'error',
        still_needed_count: 0,
        received_count: 0,
        still_needed_text: '',
        summary: '',
        ps_comment: `Disclosure intake check could not complete: ${err.message}`,
        result: { present: [], still_needed: [], verify: [], not_applicable: [] },
      });
    }
    return { statusCode: 500 };
  }
};
