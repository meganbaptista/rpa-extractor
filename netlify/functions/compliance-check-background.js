// netlify/functions/compliance-check-background.js
//
// ============================================================================
// KEEVA — Purchase-agreement DOCUMENT COMPLIANCE check (opening-time)
// ============================================================================
// Verify the executed contract package contains every document on the deal's
// COMPLIANCE list. Runs at ESCROW OPEN (when Jill opens escrow and the compliance
// list is calculated) — NOT at signature-audit time, because the list does not
// exist yet when the contract is first audited.
//
// Same engine as the disclosure intake, pointed at the purchase-agreement packet
// and the "Compliance Documents" list: identify the documents actually present in
// the package, reconcile against the required list, report present / missing.
// Non-blocking, heads-up only. Async BACKGROUND function (Opus is slower than
// Netlify's ~10s sync cap); result POSTed to a callback (Zap → Process Street).
//
// ----------------------------------------------------------------------------
// FLOW
//   Opening automation (builds the compliance list) -> POST here:
//     { documents:[{name,url?|base64?}], complianceList?, propertyAddress?, callbackUrl? }
//   This function:
//     1. Loads the contract package PDF(s) (fetch url, or base64; .zip expanded).
//     2. Opus identifies the documents actually INCLUDED (own pages present).
//     3. Resolves the compliance list (body wins; else looked up by address from
//        the "Compliance Documents" column of the AUDIT_LIST_CSV_URL sheet).
//     4. Opus reconciles present-vs-required, handling shorthand + conditionals.
//     5. POSTs { documents_status, present, missing, not_applicable, ps_comment }
//        to the callback.
//
// Only documents physically IN the uploaded package can be confirmed present;
// items normally held elsewhere (e.g. BRBC/POF/BCA) read as missing unless they
// are in the package — the reconcile is told they may live elsewhere.
// ============================================================================

console.log('[compliance-check] module loading');

const { canonicalAddress } = require('./lib/address');
const usageLog = require('./lib/usage-log');
const { callClaude: callClaudeShared } = require('./lib/claude');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';
const CALLBACK_URL_ENV = process.env.COMPLIANCE_CHECK_CALLBACK_URL || '';

// Published-CSV master sheet. The compliance list lives in the "Compliance
// Documents" column, looked up by address. Falls back to AUDIT_LIST_CSV_URL (same
// sheet the disclosure intake reads). If unset, the list must be in the body.
const COMPLIANCE_LIST_CSV_URL = process.env.COMPLIANCE_LIST_CSV_URL || process.env.AUDIT_LIST_CSV_URL || '';

const MAX_DOC_BYTES = 28 * 1024 * 1024;

console.log('[compliance-check] module fully loaded, handler ready');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Address + CSV helpers (match the disclosure-intake behavior).
// ---------------------------------------------------------------------------
function normalizeAddress(addr) {
  return String(addr || '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
}
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

// Look up the deal's "Compliance Documents" list by address.
async function fetchComplianceListByAddress(address) {
  if (!COMPLIANCE_LIST_CSV_URL || !address) return '';
  try {
    const res = await fetch(COMPLIANCE_LIST_CSV_URL);
    if (!res.ok) { console.warn(`[compliance-check] sheet fetch ${res.status}`); return ''; }
    const rows = parseCsv(await res.text());
    if (rows.length < 2) return '';
    const header = rows[0].map((h) => String(h).toLowerCase().trim());
    let addrCol = header.findIndex((h) => h.includes('address'));
    // The compliance column, kept distinct from "Required Disclosures".
    let listCol = header.findIndex((h) => /compliance|purchase\s*agreement|contract\s*docs/.test(h));
    if (addrCol < 0) addrCol = 0;
    if (listCol < 0) { console.warn('[compliance-check] no Compliance Documents column found'); return ''; }
    // Last non-empty match wins, so a re-opened deal's newer row beats a cancelled one.
    let match = '';
    for (const r of rows.slice(1)) {
      if (addrMatch(r[addrCol] || '', address)) {
        const v = String(r[listCol] || '').trim();
        if (v) match = v;
      }
    }
    if (match) return match;
    console.warn(`[compliance-check] no compliance row matched "${address}"`);
    return '';
  } catch (err) {
    console.warn(`[compliance-check] compliance lookup failed: ${err.message}`);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Document loading (zip-aware, Drive-interstitial-aware). Mirrors disclosure
// intake so a large packet or a zipped bundle both work. The zip readers and the
// recursive nested-zip walk are shared from lib/unzip.js.
// ---------------------------------------------------------------------------
const { PDF_MAGIC, looksZip, collectPdfs } = require('./lib/unzip');

function describeBuffer(buf, contentType) {
  const head = buf.subarray(0, 16);
  const ascii = head.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
  return `content-type=${contentType || 'n/a'} len=${buf.length} head="${ascii}"`;
}
function isHtml(buf, contentType) {
  if (/text\/html/i.test(contentType || '')) return true;
  const head = buf.subarray(0, 256).toString('latin1').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('<');
}
function driveConfirmUrl(html, originalUrl) {
  const id = (originalUrl.match(/[?&]id=([A-Za-z0-9_-]+)/) || [])[1];
  if (!id) return '';
  const confirm = (html.match(/name="confirm"\s+value="([^"]+)"/i) || html.match(/[?&]confirm=([0-9A-Za-z_-]+)/) || [, 't'])[1];
  const uuid = (html.match(/name="uuid"\s+value="([^"]+)"/i) || [])[1];
  let u = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=${confirm || 't'}`;
  if (uuid) u += `&uuid=${uuid}`;
  return u;
}
async function fetchToBuffer(url, name) {
  let res = await fetch(url);
  if (!res.ok) { console.warn(`[compliance-check] could not fetch ${name} (${res.status})`); return null; }
  let contentType = res.headers.get('content-type') || '';
  let buf = Buffer.from(await res.arrayBuffer());
  if (/google\.com/i.test(url) && isHtml(buf, contentType)) {
    const real = driveConfirmUrl(buf.toString('latin1'), url);
    if (real) {
      const res2 = await fetch(real);
      if (res2.ok) { contentType = res2.headers.get('content-type') || ''; buf = Buffer.from(await res2.arrayBuffer()); }
      else console.warn(`[compliance-check] ${name}: confirm refetch failed (${res2.status})`);
    }
  }
  return { buf, contentType };
}

async function loadDocuments(documents) {
  const out = [];
  for (const d of (documents || [])) {
    if (!d) continue;
    const name = d.name || d.filename || 'document.pdf';
    try {
      let buf = null;
      let contentType = '';
      if (d.base64) buf = Buffer.from(d.base64, 'base64');
      else if (d.url) {
        const fetched = await fetchToBuffer(d.url, name);
        if (!fetched) continue;
        buf = fetched.buf; contentType = fetched.contentType;
      } else continue;

      if (looksZip(buf, name, contentType)) {
        // Recursive: a nested .zip is expanded, not discarded. The old loop kept
        // only top-level PDFs, so a zip-inside-a-zip (Zapier bundles the email's
        // attachments, the agent attached their own zip of disclosures) was
        // dropped with no log line at all.
        const { kept, skipped, truncated } = collectPdfs(buf, name, { maxDocBytes: MAX_DOC_BYTES });
        if (!kept.length && !skipped.length) {
          console.warn(`[compliance-check] could not unzip ${name} | ${describeBuffer(buf, contentType)}`);
          continue;
        }
        for (const k of kept) out.push({ name: k.name, base64: k.data.toString('base64') });
        console.log(`[compliance-check] unzipped ${name}: kept ${kept.length} PDF(s)`
          + (kept.length ? ` (${kept.map(k => k.path).join(', ')})` : '')
          + (skipped.length ? `, skipped ${skipped.length} (${skipped.join(', ')})` : '')
          + (truncated ? ' [TRUNCATED — hit a recursion/size guard, some documents were not read]' : ''));
        continue;
      }

      if (!(buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC))) {
        console.warn(`[compliance-check] ${name} is not a PDF or zip, skipping | ${describeBuffer(buf, contentType)}`);
        continue;
      }
      if (buf.length > MAX_DOC_BYTES) { console.warn(`[compliance-check] ${name} too large (${buf.length}B), skipping`); continue; }
      out.push({ name, base64: buf.toString('base64') });
    } catch (err) {
      console.warn(`[compliance-check] failed to load ${name}: ${err.message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Anthropic calls.
// ---------------------------------------------------------------------------
// Streams via the shared lib/claude transport (survives long generations, retries
// thrown network errors). opts.effort defaults to 'high'; the reconcile call passes
// 'medium' since it is mechanical present-vs-required matching, not a document read.
function callClaude(content, maxTokens, opts = {}) {
  return callClaudeShared({
    fn: 'compliance-check',
    model: MODEL,
    content,
    maxTokens: maxTokens || 8000,
    effort: opts.effort || 'high',
  });
}

function parseJson(raw) {
  let t = (raw || '').trim().replace(/```json|```/g, '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : t);
}

function mergeDocs(a, b) {
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

const IDENTIFY_PROMPT =
  'This PDF is an executed California residential purchase-agreement package (the offer/contract ' +
  'package: RPA plus its agency disclosures, buyer advisories, counter offers, addenda, and related forms). ' +
  'Identify every distinct document/form that is ACTUALLY INCLUDED as its own document (its own pages are ' +
  'physically present). Use the standard CAR code and full name. CRITICAL: a document counts as present ONLY ' +
  'if its own pages are here; do NOT list a form merely because it is referenced or mentioned inside another ' +
  'document. Also read the property street address. Respond with ONLY this JSON (no prose, no fences): ' +
  '{"property_address":"<street, city, state, zip>","documents":[{"code":"RPA","name":"Residential Purchase Agreement"}]}';

async function identifyPackageDocuments(docs) {
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
      const raw = await callClaude(content, 10000);
      const parsed = parseJson(raw);
      const documents = Array.isArray(parsed.documents) ? parsed.documents
        .map((d) => ({ code: String(d.code || '').trim(), name: String(d.name || '').trim() }))
        .filter((d) => d.code || d.name) : [];
      return { propertyAddress: String(parsed.property_address || '').trim(), documents, dropped };
    } catch (err) {
      if (/\b413\b|request_too_large|too\s*large/i.test(err.message || '') && working.length > 1) {
        const big = working.shift();
        dropped.push(big.name);
        console.warn(`[compliance-check] request too large — dropping "${big.name}", retrying with ${working.length}`);
        continue;
      }
      throw err;
    }
  }
  return { propertyAddress: '', documents: [], dropped };
}

// Batch a many-PDF bundle under Claude's request-size limit, merge results.
async function identifyChunked(docs) {
  if (docs.length <= 1) return identifyPackageDocuments(docs);
  const MAX_BATCH_B64 = 18 * 1024 * 1024;
  const MAX_BATCH_DOCS = 10;
  const batches = [];
  let cur = [], curSize = 0;
  for (const d of docs) {
    const sz = (d.base64 || '').length;
    if (cur.length && (cur.length >= MAX_BATCH_DOCS || curSize + sz > MAX_BATCH_B64)) { batches.push(cur); cur = []; curSize = 0; }
    cur.push(d); curSize += sz;
  }
  if (cur.length) batches.push(cur);
  let all = [], address = '';
  for (let i = 0; i < batches.length; i++) {
    const r = await identifyPackageDocuments(batches[i]);
    all = mergeDocs(all, r.documents);
    if (!address && r.propertyAddress) address = r.propertyAddress;
    console.log(`[compliance-check] identify batch ${i + 1}/${batches.length}: ${r.documents.length} doc(s)`);
  }
  return { propertyAddress: address, documents: all };
}

async function reconcileCompliance(listText, docsPresent) {
  const presentText = docsPresent.map((d) => `- ${d.code ? d.code + ' — ' : ''}${d.name}`).join('\n') || '(none identified)';
  const prompt =
    'You are a California transaction coordinator checking a purchase-agreement package against this deal\'s ' +
    'REQUIRED COMPLIANCE DOCUMENTS list. Decide, for each required item, whether it is present in the package.\n\n' +
    'REQUIRED COMPLIANCE DOCUMENTS:\n' + listText + '\n\n' +
    'DOCUMENTS FOUND IN THE PACKAGE:\n' + presentText + '\n\n' +
    'Rules:\n' +
    '- Match shorthand to forms using your knowledge of CAR codes (BRBC, AD-2, RPA, FRR-PA, BIA, PRBS, FHDA/Fair ' +
    'Housing, BHIA, WFA, CCPA, AAA, POF, BCA, counter offers, etc.).\n' +
    '- "COUNTER OFFERS" counts as present only if the package indicates counters exist; if there are none, mark it ' +
    'not_applicable.\n' +
    '- Items typically signed/held OUTSIDE this contract package, or DRAFTED LATER (after opening), should be ' +
    'marked missing only if genuinely required to be in this package now; otherwise put them in not_applicable with ' +
    'a short note. These include: BRBC, POF, BCA ("check BRBC package"), and AAA (usually drafted after opening).\n' +
    '- Only count a document as present if it is truly in the package, not merely referenced.\n\n' +
    'Respond with ONLY this JSON (no prose, no fences):\n' +
    '{"present":["..names.."],"missing":["..names.."],"not_applicable":[{"item":"..","note":".."}],"summary":"one sentence"}';
  return parseJson(await callClaude([{ type: 'text', text: prompt }], 8000, { effort: 'medium' }));
}

function bullets(list, fmt) {
  if (!Array.isArray(list) || !list.length) return '(none)';
  return list.map((x) => `• ${fmt(x)}`).join('\n');
}

async function sendCallback(callbackUrl, payload) {
  if (!callbackUrl) { console.warn('[compliance-check] no callback URL configured'); return; }
  try {
    const res = await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    console.log(`[compliance-check] callback dispatched (status ${res.status})`);
  } catch (err) {
    console.error(`[compliance-check] callback failed (non-fatal): ${err.message}`);
  }
}

exports.handler = async function (event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { console.error('[compliance-check] invalid JSON body'); return { statusCode: 400 }; }

  const { complianceList, propertyAddress = '', callbackUrl, ref = '' } = body;
  const callback = callbackUrl || CALLBACK_URL_ENV;
  // `ref` is an opaque passthrough (e.g. the deal's Google Doc ID or PS run id).
  // We never read it — we just echo it back in the callback so the async result
  // can be routed to the right deal's doc/run by the catch-hook Zap.

  // Accept `documents` as an array of {url|base64}, OR as a plain URL string, OR a
  // single object, OR a `documentUrl` string — so a simple Zapier mapping (just the
  // Drive download URL) works without building a nested array.
  let documents = body.documents;
  if (typeof documents === 'string') documents = documents.trim() ? [{ url: documents.trim() }] : [];
  else if (documents && !Array.isArray(documents)) documents = (documents.url || documents.base64) ? [documents] : [];
  if ((!documents || !documents.length) && body.documentUrl) documents = [{ url: String(body.documentUrl).trim() }];

  try {
    const docs = await loadDocuments(documents);
    if (!docs.length) throw new Error('No documents could be loaded (need fetchable url or base64)');

    // 1) Identify the documents physically present in the package + read address.
    const { propertyAddress: detectedAddr, documents: present } = await identifyChunked(docs);
    const address = canonicalAddress(detectedAddr || propertyAddress || '');
    console.log(`[compliance-check] ${address || '(no address)'}: identified ${present.length} document(s) in the package`);

    // 2) Resolve the compliance list (body wins for the opening Zap that just built
    //    it; otherwise look it up by address from the Compliance Documents column).
    let listText = (complianceList && String(complianceList).trim()) || '';
    if (!listText) listText = await fetchComplianceListByAddress(address);
    if (!listText) throw new Error(`No compliance list for "${address || 'unknown address'}" — pass complianceList in the body, or add a matching Compliance Documents row.`);

    // 3) Reconcile.
    const rec = await reconcileCompliance(listText, present);
    const presentNames = Array.isArray(rec.present) ? rec.present : [];
    const missing = Array.isArray(rec.missing) ? rec.missing : [];
    const na = Array.isArray(rec.not_applicable) ? rec.not_applicable : [];
    const requiredCount = presentNames.length + missing.length;
    const status = missing.length ? 'incomplete' : 'complete';

    const psComment =
      `Document compliance — ${address || 'address unknown'}\n` +
      `Status: ${status} | ${presentNames.length} of ${requiredCount} required documents present; ${missing.length} missing\n\n` +
      `MISSING:\n${bullets(missing, (x) => x)}\n\n` +
      `PRESENT:\n${bullets(presentNames, (x) => x)}\n\n` +
      (na.length ? `NOT APPLICABLE / ELSEWHERE:\n${bullets(na, (x) => `${x.item}: ${x.note}`)}\n` : '');

    const payload = {
      ref,
      property_address: address,
      documents_status: status,
      documents_required_count: requiredCount,
      documents_present_count: presentNames.length,
      documents_missing_count: missing.length,
      documents_missing_text: missing.join(', '),
      documents_present_text: presentNames.join(', '),
      summary: rec.summary || '',
      ps_comment: psComment,
      result: { present: presentNames, missing, not_applicable: na },
    };

    console.log(`[compliance-check] ${address}: ${status} — ${missing.length} missing of ${requiredCount}`);
    await sendCallback(callback, payload);
    return { statusCode: 200 };
  } catch (err) {
    console.error('[compliance-check] ERROR:', err.message);
    await sendCallback(callback, {
      ref,
      property_address: propertyAddress || '',
      documents_status: 'error',
      documents_required_count: 0,
      documents_present_count: 0,
      documents_missing_count: 0,
      documents_missing_text: '',
      documents_present_text: '',
      summary: '',
      ps_comment: `Document compliance check could not complete: ${err.message}`,
      result: { present: [], missing: [], not_applicable: [] },
    });
    return { statusCode: 500 };
  }
};
