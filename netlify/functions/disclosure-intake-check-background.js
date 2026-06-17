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
const { getStore } = require('@netlify/blobs');
const { canonicalAddress } = require('./lib/address');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';
const CALLBACK_URL_ENV = process.env.DISCLOSURE_INTAKE_CALLBACK_URL || '';

// Published-CSV URL of the master "audit lists" Google Sheet (one row per deal:
// property address + that deal's required disclosure docs). The opening
// automation writes a row; the function looks up the deal by address here. If
// unset, the audit list must be passed in the request body instead.
const AUDIT_LIST_CSV_URL = process.env.AUDIT_LIST_CSV_URL || '';

// Per-deal accumulation lives here, keyed by normalized property address.
const STATE_STORE = 'disclosure-intake-state';

// Safety cap on a single document we will pull into memory / send to the model.
const MAX_DOC_BYTES = 28 * 1024 * 1024;

// Items the BUYER side assembles in-house (title/MLS/AVID/receipts). Never request
// these from the listing side and don't count them as "still needed" — they move to
// a "prepared by us" bucket so the TC still sees them on our own to-do. Editable;
// extend with the DISCLOSURE_PREPARED_BY_US env (comma-separated keywords).
// DIA: we technically don't need it. "Los Angeles County Local Area Disclosures":
// not a county requirement; we add our own per-brokerage version. Both are ours to
// handle, so never request them from the listing side.
const PREPARED_BY_US_DEFAULTS = [
  'property profile', 'mls client', 'ba avid', 'receipt for reports', 'rfr',
  'dia', 'los angeles county local area',
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
    for (const r of rows.slice(1)) {
      if (addrMatch(r[addrCol] || '', address)) return String(r[listCol] || '').trim();
    }
    console.warn(`[disclosure-intake] no audit-list row matched "${address}"`);
    return '';
  } catch (err) {
    console.warn(`[disclosure-intake] audit-list lookup failed: ${err.message}`);
    return '';
  }
}

// ----------------------------------------------------------------------------
// ZIP support. Zapier's "Upload File" step bundles all the email's attachments
// into ONE .zip on Drive, so a single document URL can actually be 22 PDFs. We
// detect the zip, extract the PDFs, drop blocked/non-PDF entries, and feed the
// real PDFs downstream. Pure Node built-ins (zlib) — no extra dependency.
// ----------------------------------------------------------------------------
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const PDF_MAGIC = Buffer.from('%PDF');

// Filenames inside the zip we never want to send to the model (big non-disclosure
// reports + invoices). Mirrors the Zapier Code-step BLOCK list, plus invoice.
const BLOCK_NAME = /(previous\s*home\s*inspection|home\s*inspection|inspection\s*report|\binspection\b|termite|wood\s*destroying|sewer|\broof\b|chimney|\bpool\b|\bspa\b|hvac|geolog|\bsoils?\b|\bsurvey\b|appraisal|invoice|\bphotos?\b)/i;

// Disclosure/advisory forms whose names legitimately contain "inspection" — these
// must NEVER be blocked. AVID = Agent Visual Inspection Disclosure; BIA/BIW = Buyer's
// Inspection Advisory/Waiver. The override wins over BLOCK_NAME.
const NEVER_BLOCK = /(\bavid\b|agent\s*visual\s*inspection|buyer'?s?\s*inspection\s*(advisory|waiver)|inspection\s*(advisory|waiver)|\bbia\b|\bbiw\b)/i;

function isBlockedName(name) {
  return BLOCK_NAME.test(name || '') && !NEVER_BLOCK.test(name || '');
}

function looksZip(buf, name, contentType) {
  if (buf && buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) return true;
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
        let entries;
        try { entries = unzipEntries(buf); }
        catch (e) {
          console.warn(`[disclosure-intake] could not unzip ${name}: ${e.message} | ${describeBuffer(buf, contentType)}`);
          continue; // not a real zip (likely an HTML interstitial / permission page) — skip
        }
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

      // Single document: only forward it if the BYTES are actually a PDF (don't trust
      // the filename — a fetched HTML error/interstitial page would slip through).
      if (!(buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC))) {
        console.warn(`[disclosure-intake] ${name} is not a PDF or zip, skipping | ${describeBuffer(buf, contentType)}`);
        continue;
      }
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
async function callClaude(content, maxTokens, attempt = 0) {
  const MAX_RETRIES = 4;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var not set');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens || 8000,
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
    return callClaude(content, maxTokens, attempt + 1);
  }
  if (!response.ok) throw new Error(`Claude API error ${response.status}: ${await response.text()}`);

  const data = await response.json();
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
  'address from the forms.\n\n' +
  'ALSO do a LIGHT buyer-side response check on the forms that actually have questions/answers (SPQ, TDS, SBSA, ' +
  'and similar Q&A disclosures). Be lenient. Flag ONLY: (a) a question or section left BLANK / unanswered; (b) an ' +
  'item the seller marked YES where there is NO written explanation, the explanation is ILLEGIBLE, or it is present ' +
  'but TOO VAGUE to understand. Do NOT judge whether a disclosed issue is concerning, do NOT flag NO answers, and ' +
  'do NOT review forms that have no questions (receipts, booklets, profiles, AVID, certifications). ' +
  'For each flag give the form code, the question/section reference, the issue, and a short note.\n\n' +
  'Respond with ONLY this JSON (no prose, no fences): ' +
  '{"property_address":"<street, city, state, zip>","forms":[{"code":"TDS","name":"Real Estate Transfer Disclosure Statement"}],' +
  '"response_flags":[{"form":"SPQ","item":"<question/section>","issue":"unanswered|yes_no_explanation|explanation_unclear","note":"<short reason>"}]}';

async function identifyForms(docs) {
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
      // Ceiling is generous: adaptive thinking + effort:high count toward max_tokens,
      // and a multi-form packet can require a lot of reasoning before the small JSON.
      const raw = await callClaude(content, 12000);
      const parsed = parseJson(raw);
      const forms = Array.isArray(parsed.forms) ? parsed.forms
        .map((f) => ({ code: String(f.code || '').trim(), name: String(f.name || '').trim() }))
        .filter((f) => f.code || f.name) : [];
      const responseFlags = Array.isArray(parsed.response_flags) ? parsed.response_flags
        .map((r) => ({ form: String(r.form || '').trim(), item: String(r.item || '').trim(), issue: String(r.issue || '').trim(), note: String(r.note || '').trim() }))
        .filter((r) => r.form || r.item || r.note) : [];
      return { propertyAddress: String(parsed.property_address || '').trim(), forms, responseFlags, dropped };
    } catch (err) {
      const tooLarge = /\b413\b|request_too_large|too\s*large/i.test(err.message || '');
      if (tooLarge && working.length > 1) {
        const big = working.shift(); // largest, list is size-sorted descending
        dropped.push(big.name);
        console.warn(`[disclosure-intake] request too large — dropping biggest doc "${big.name}" and retrying with ${working.length} doc(s)`);
        continue;
      }
      throw err;
    }
  }
  return { propertyAddress: '', forms: [], responseFlags: [], dropped };
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
async function identifyFormsChunked(docs) {
  if (docs.length <= 1) return identifyForms(docs);
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
  for (let i = 0; i < batches.length; i++) {
    const r = await identifyForms(batches[i]);
    allForms = mergeForms(allForms, r.forms);
    if (r.responseFlags && r.responseFlags.length) responseFlags = responseFlags.concat(r.responseFlags);
    if (!address && r.propertyAddress) address = r.propertyAddress;
    if (r.dropped && r.dropped.length) dropped = dropped.concat(r.dropped);
    console.log(`[disclosure-intake] identify batch ${i + 1}/${batches.length} (${batches[i].length} doc[s]): ${r.forms.length} form(s), ${(r.responseFlags || []).length} response flag(s)`);
  }
  return { propertyAddress: address, forms: allForms, responseFlags, dropped };
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
    '- Content/receipt checks: when the form IS present but the item is really a per-answer or signed-receipt check ' +
    '(e.g. "SPQ 7E: Yes", "Earthquake Booklet Receipt" when the booklet is present), mark it "verify".\n' +
    '- Do NOT count a form as received just because it is referenced inside another form.\n\n' +
    'Respond with ONLY this JSON (no prose, no fences):\n' +
    '{"overall":"complete|outstanding","present":["..names.."],"still_needed":["..names.."],' +
    '"verify":[{"item":"..","note":".."}],"not_applicable":[{"item":"..","note":".."}],"summary":"one sentence"}';

  // Reconcile reasons item-by-item over the whole audit list before emitting JSON;
  // give thinking + output ample room so it never truncates mid-answer.
  return parseJson(await callClaude([{ type: 'text', text: prompt }], 16000));
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
async function reconcileAndCallback(address, received, auditList, callback, responseFlags = []) {
  let listText = (auditList && String(auditList).trim()) || '';
  if (!listText) listText = await fetchAuditListByAddress(address);
  if (!listText) throw new Error(`No audit list for "${address}" — pass auditList in the body, or add a matching row to the AUDIT_LIST_CSV_URL sheet.`);
  const result = await reconcile(listText, received);

  const present = Array.isArray(result.present) ? result.present : [];
  const verify = Array.isArray(result.verify) ? result.verify : [];
  const na = Array.isArray(result.not_applicable) ? result.not_applicable : [];
  const flags = Array.isArray(responseFlags) ? responseFlags : [];

  // Split the reconciled "still needed" into what we must REQUEST from the listing
  // side vs what our team prepares in-house. Only the listing-side items drive the
  // count, the chase email, and the status; prepared-by-us items stay visible in
  // the PS comment as our own to-do.
  const stillNeededAll = Array.isArray(result.still_needed) ? result.still_needed : [];
  const preparedByUs = stillNeededAll.filter(isPreparedByUs);
  const stillNeeded = stillNeededAll.filter((x) => !isPreparedByUs(x));
  // Anything to follow up on with the listing side = missing docs OR response flags.
  const followupCount = stillNeeded.length + flags.length;
  const overall = followupCount ? (result.overall === 'complete' ? 'outstanding' : (result.overall || 'outstanding')) : 'complete';

  // Human-readable response issue: "SPQ 7E — marked Yes, no explanation written".
  const flagLine = (f) => `${[f.form, f.item].filter(Boolean).join(' ')}${f.note ? ` — ${f.note}` : ` — ${f.issue}`}`;

  const psComment =
    `Disclosure intake — ${address}\n` +
    `Status: ${overall} | ${present.length} of the required disclosures received; ${stillNeeded.length} to request, ${flags.length} response(s) to clarify\n\n` +
    `TO REQUEST FROM LISTING SIDE:\n${bullets(stillNeeded, (x) => x)}\n\n` +
    (flags.length ? `RESPONSES TO VERIFY:\n${bullets(flags, flagLine)}\n\n` : '') +
    `RECEIVED:\n${bullets(present, (x) => x)}\n\n` +
    (preparedByUs.length ? `PREPARED BY US (do not request):\n${bullets(preparedByUs, (x) => x)}\n\n` : '') +
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
      `Thank you for sending over the disclosures for ${address}. After reviewing the package against our file, a few items still need attention.\n` +
      (stillNeeded.length
        ? '\nStill outstanding:\n' + stillNeeded.map((x) => `- ${x}`).join('\n') + '\n'
        : '') +
      (flags.length
        ? '\nResponses we would appreciate clarification on:\n' + flags.map((f) => `- ${[f.form, f.item].filter(Boolean).join(' ')}${f.note ? `: ${f.note}` : ''}`).join('\n') + '\n'
        : '') +
      '\nWhen you have a moment, please send these over so we can wrap up our review. ' +
      'If any have already been provided or do not apply, just let me know.\n\n' +
      `Thanks!\n${signer}`;
  }

  const payload = {
    property_address: address,
    overall_status: overall,
    still_needed_count: stillNeeded.length,
    response_flags_count: flags.length,
    followup_count: followupCount,
    // Received Count = how many of THIS deal's required disclosures are in hand
    // (meaningful for a TC). The raw count of distinct forms parsed across all
    // deliveries is kept separately as received_forms_total for diagnostics.
    received_count: present.length,
    received_forms_total: received.length,
    still_needed_text: stillNeeded.join(', '),
    prepared_by_us_text: preparedByUs.join(', '),
    response_flags_text: flags.map(flagLine).join('; '),
    summary: result.summary || '',
    ps_comment: psComment,
    chase_email_subject: chaseEmailSubject,
    chase_email_body: chaseEmailBody,
    result: { present, still_needed: stillNeeded, prepared_by_us: preparedByUs, verify, not_applicable: na, response_flags: flags },
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
    auditList, documents, propertyAddress = '', callbackUrl,
    accumulate_only: accumulateOnly = false, finalize = false, batchId = '',
  } = body;
  const callback = callbackUrl || CALLBACK_URL_ENV;

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
      if (batchId) {
        const listing = await store.list({ prefix: `recv:${batchId}:` });
        for (const b of (listing.blobs || [])) {
          slotKeys.push(b.key);
          const item = await store.get(b.key, { type: 'json' });
          if (item && Array.isArray(item.forms)) batchForms = mergeForms(batchForms, item.forms);
          if (item && Array.isArray(item.responseFlags)) batchFlags = batchFlags.concat(item.responseFlags);
        }
      }
      const prior = (await store.get(key, { type: 'json' })) || { address, received: [] };
      const received = mergeForms(prior.received, batchForms);
      await store.setJSON(key, { address, received, updatedAt: Date.now() });
      console.log(`[disclosure-intake] finalize ${address}: merged ${batchForms.length} from ${slotKeys.length} slot(s) -> ${received.length} total`);
      for (const k of slotKeys) { try { await store.delete(k); } catch (e) { /* cleanup best-effort */ } }
      await reconcileAndCallback(address, received, auditList, callback, batchFlags);
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

    const { propertyAddress: detectedAddr, forms: newForms, responseFlags: newFlags = [], dropped } = await identifyFormsChunked(docs);
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
      await store.setJSON(slot, { address, forms: newForms, responseFlags: newFlags });
      if (batchId) await store.setJSON('batch:' + batchId, { address, updatedAt: Date.now() });
      console.log(`[disclosure-intake] ${address}: accumulate-only, stored ${newForms.length} form(s), ${newFlags.length} flag(s) in slot (batch ${batchId || 'n/a'})`);
      return { statusCode: 200 };
    }

    // SINGLE DELIVERY: accumulate into the persistent set + reconcile + callback now.
    const prior = (await store.get(key, { type: 'json' })) || { address, received: [] };
    const received = mergeForms(prior.received, newForms);
    await store.setJSON(key, { address, received, updatedAt: Date.now() });
    console.log(`[disclosure-intake] ${address}: ${received.length} form(s) received so far (was ${prior.received.length})`);
    await reconcileAndCallback(address, received, auditList, callback, newFlags);
    return { statusCode: 200 };
  } catch (err) {
    console.error('[disclosure-intake] ERROR:', err.message);
    // Stay quiet on accumulate-only ingest errors (finalize will surface real issues);
    // only emit an error callback for visible single-delivery / finalize calls.
    if (!accumulateOnly) {
      await sendCallback(callback, {
        property_address: propertyAddress || '',
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
