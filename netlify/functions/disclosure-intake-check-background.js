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

const { getStore } = require('@netlify/blobs');

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
const PREPARED_BY_US_DEFAULTS = ['property profile', 'mls client', 'ba avid', 'receipt for reports', 'rfr'];
function isPreparedByUs(name) {
  const n = String(name || '').toLowerCase();
  const keys = PREPARED_BY_US_DEFAULTS.concat(
    (process.env.DISCLOSURE_PREPARED_BY_US || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  return keys.some((k) => k && n.includes(k));
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
// Load each document as base64. Accepts { base64 } directly, or { url } to fetch.
// ----------------------------------------------------------------------------
async function loadDocuments(documents) {
  const out = [];
  for (const d of (documents || [])) {
    if (!d) continue;
    const name = d.name || d.filename || 'document.pdf';
    try {
      if (d.base64) {
        out.push({ name, base64: d.base64 });
        continue;
      }
      if (d.url) {
        const res = await fetch(d.url);
        if (!res.ok) { console.warn(`[disclosure-intake] could not fetch ${name} (${res.status})`); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_DOC_BYTES) { console.warn(`[disclosure-intake] ${name} too large (${buf.length}B), skipping`); continue; }
        out.push({ name, base64: buf.toString('base64') });
        continue;
      }
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
  'address from the forms. Respond with ONLY this JSON (no prose, no fences): ' +
  '{"property_address":"<street, city, state, zip>","forms":[{"code":"TDS","name":"Real Estate Transfer Disclosure Statement"}]}';

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
      const raw = await callClaude(content, 10000);
      const parsed = parseJson(raw);
      const forms = Array.isArray(parsed.forms) ? parsed.forms
        .map((f) => ({ code: String(f.code || '').trim(), name: String(f.name || '').trim() }))
        .filter((f) => f.code || f.name) : [];
      return { propertyAddress: String(parsed.property_address || '').trim(), forms, dropped };
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
  return { propertyAddress: '', forms: [], dropped };
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

exports.handler = async function (event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { console.error('[disclosure-intake] invalid JSON body'); return { statusCode: 400 }; }

  const { auditList, documents, propertyAddress = '', callbackUrl } = body;
  const callback = callbackUrl || CALLBACK_URL_ENV;

  try {
    const docs = await loadDocuments(documents);
    if (!docs.length) throw new Error('No documents could be loaded (need fetchable url or base64)');

    // 1) Identify the real forms in this delivery + read the address.
    const { propertyAddress: detectedAddr, forms: newForms, dropped } = await identifyForms(docs);
    if (dropped && dropped.length) console.warn(`[disclosure-intake] dropped oversized doc(s) to fit the model: ${dropped.join(', ')}`);
    const address = (detectedAddr || propertyAddress || '').trim();
    if (!address) throw new Error('Could not read a property address from the documents');
    const key = normalizeAddress(address);
    console.log(`[disclosure-intake] ${address}: identified ${newForms.length} form(s) in this delivery`);

    // 2) Accumulate into the per-deal received set.
    const store = getStore(blobsConfig(STATE_STORE));
    const prior = (await store.get(key, { type: 'json' })) || { address, received: [] };
    const received = mergeForms(prior.received, newForms);
    await store.setJSON(key, { address, received, updatedAt: Date.now() });
    console.log(`[disclosure-intake] ${address}: ${received.length} form(s) received so far (was ${prior.received.length})`);

    // 3) Resolve the deal's required-docs list (request body wins for testing;
    //    otherwise look it up by the address we just read off the documents),
    //    then reconcile the accumulated set against it.
    let listText = (auditList && String(auditList).trim()) || '';
    if (!listText) listText = await fetchAuditListByAddress(address);
    if (!listText) throw new Error(`No audit list for "${address}" — pass auditList in the body, or add a matching row to the AUDIT_LIST_CSV_URL sheet.`);
    const result = await reconcile(listText, received);

    const present = Array.isArray(result.present) ? result.present : [];
    const verify = Array.isArray(result.verify) ? result.verify : [];
    const na = Array.isArray(result.not_applicable) ? result.not_applicable : [];

    // Split the reconciled "still needed" into what we must REQUEST from the listing
    // side vs what our team prepares in-house. Only the listing-side items drive the
    // count, the chase email, and the status; prepared-by-us items stay visible in
    // the PS comment as our own to-do.
    const stillNeededAll = Array.isArray(result.still_needed) ? result.still_needed : [];
    const preparedByUs = stillNeededAll.filter(isPreparedByUs);
    const stillNeeded = stillNeededAll.filter((x) => !isPreparedByUs(x));
    const overall = stillNeeded.length ? (result.overall || 'outstanding') : 'complete';

    const psComment =
      `Disclosure intake — ${address}\n` +
      `Status: ${overall} | ${present.length} of the required disclosures received; ${stillNeeded.length} to request from listing side\n\n` +
      `TO REQUEST FROM LISTING SIDE:\n${bullets(stillNeeded, (x) => x)}\n\n` +
      `RECEIVED:\n${bullets(present, (x) => x)}\n\n` +
      (preparedByUs.length ? `PREPARED BY US (do not request):\n${bullets(preparedByUs, (x) => x)}\n\n` : '') +
      (verify.length ? `VERIFY:\n${bullets(verify, (x) => `${x.item}: ${x.note}`)}\n\n` : '') +
      (na.length ? `NOT APPLICABLE / LATER:\n${bullets(na, (x) => `${x.item}: ${x.note}`)}\n` : '');

    // Ready-to-send chase email for the outstanding items. Zap B drops this into a
    // Gmail draft when still_needed_count > 0. No em dashes (Megan's standing
    // preference); it's a draft she reviews, so greeting/recipient are finalized then.
    const signer = process.env.DISCLOSURE_SIGNER_NAME || 'Megan';
    const chaseEmailSubject = `Outstanding disclosures for ${address}`;
    const chaseEmailBody = stillNeeded.length
      ? 'Hi,\n\n' +
        `Thank you for sending over the disclosures for ${address}. ` +
        'After reviewing the package against our file, the following items are still outstanding:\n\n' +
        stillNeeded.map((x) => `- ${x}`).join('\n') +
        '\n\nWhen you have a moment, please send these over so we can wrap up our review. ' +
        'If any have already been provided or do not apply, just let me know.\n\n' +
        `Thanks!\n${signer}`
      : '';

    const payload = {
      property_address: address,
      overall_status: overall,
      still_needed_count: stillNeeded.length,
      // Received Count = how many of THIS deal's required disclosures are in hand
      // (meaningful for a TC). The raw count of distinct forms parsed across all
      // deliveries is kept separately as received_forms_total for diagnostics.
      received_count: present.length,
      received_forms_total: received.length,
      still_needed_text: stillNeeded.join(', '),
      prepared_by_us_text: preparedByUs.join(', '),
      summary: result.summary || '',
      ps_comment: psComment,
      chase_email_subject: chaseEmailSubject,
      chase_email_body: chaseEmailBody,
      result: { present, still_needed: stillNeeded, prepared_by_us: preparedByUs, verify, not_applicable: na },
    };

    console.log(`[disclosure-intake] ${address}: ${overall} — ${stillNeeded.length} to request, ${preparedByUs.length} prepared by us`);
    await sendCallback(callback, payload);
    return { statusCode: 200 };
  } catch (err) {
    console.error('[disclosure-intake] ERROR:', err.message);
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
    return { statusCode: 500 };
  }
};
