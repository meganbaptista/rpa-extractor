// netlify/functions/disclosure-split-background.js
//
// ============================================================================
// Consumer #1 of the Disclosure Intake Pipeline (see
// DISCLOSURE-INTAKE-PIPELINE.md + INCOMING-SPLITTER-SPEC.md).
// ============================================================================
// Triggered by a `disclosure.uploaded` event (POSTed by the watcher via
// lib/events.publish). Given the combined signed-disclosure PDF, it:
//   1. Downloads the PDF from Drive (by source.fileId) via lib/drive.
//   2. Asks Opus 4.8 to map each CAR form -> its page range, AND audit which
//      required parties (Buyer/Seller/Buyer's Agent/Listing Agent) have signed.
//   3. Splits the PDF into one file per form with pdf-lib (copyPages).
//   4. Names each "<CODE> - <Full Name> - <STATUS>.pdf" where STATUS is `FX`
//      (fully executed) or `Need` + the missing parties (B, S, BA, LA) in fixed
//      order, e.g. `NeedB`, `NeedB+S`. Duplicates keep both via " (2)".
//   5. Uploads the split files into the property folder (location.propertyFolderId).
//   6. Archives the original to Incoming/_processed/ and emits `disclosure.split`.
//
// Background function: Opus is slower than the ~10s sync cap, and publish() fires
// this fire-and-forget (202). Idempotent on event.id via a "done" blob store.
//
// Signature reading here is document-level (Opus reads the PDF). A crisp-render
// pass (like disclosure-intake's stage A/B for scanned checkboxes) can be added
// later if wet-signed scans need more accuracy.
// ============================================================================

console.log('[disclosure-split] module loading');

const { getStore } = require('@netlify/blobs');
const { PDFDocument } = require('pdf-lib');
const drive = require('./lib/drive');
const { EVENTS, makeEvent, publish } = require('./lib/events');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';
const MAX_DOC_BYTES = 28 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF');
const DONE_STORE = 'disclosure-split-done';

// Fixed party order for the filename status suffix.
const SIGNER_ORDER = ['B', 'S', 'BA', 'LA'];

console.log('[disclosure-split] module fully loaded, handler ready');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function blobsConfig(name) {
  return { name, siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN };
}

// ----------------------------------------------------------------------------
// Opus 4.8 call (adaptive thinking, high effort). Retries on 429/529.
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
      max_tokens: maxTokens || 20000,
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content }],
    }),
  });

  if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter ? Math.min(parseFloat(retryAfter) * 1000, 30000) : Math.min(1000 * Math.pow(2, attempt), 30000);
    console.log(`[disclosure-split] ${response.status}, retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
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
// THE PROMPT — split map + signature audit in one pass over the package.
// ----------------------------------------------------------------------------
const ANALYZE_PROMPT =
  'This PDF is a combined package of California real estate disclosure forms that have been returned SIGNED. Do TWO things and return ONE JSON object.\n\n' +
  '1) SPLIT MAP. Identify every distinct CAR disclosure/report form whose OWN pages are physically in this package (a form counts only if its own pages are here, NOT if it is merely referenced inside another form). For each form return: "code" (the standard CAR code, e.g. TDS, SPQ, SBSA, AVID, FHDS, LPD, WBSA, ESD), "name" (the full form name), "revision" (the printed revision date in M/YY, or "" if none), and "pages" (the array of 1-indexed page numbers in THIS PDF that belong to that form, in order). Use each form\'s header/footer, its form code, and its "Page X of Y" line to find its exact page span; a form is usually a contiguous run of pages. Every page of the PDF should belong to exactly one form when possible.\n\n' +
  '2) SIGNATURE AUDIT. For EACH form determine who has signed/initialed everywhere that form requires. The four possible parties are: B = Buyer, S = Seller, BA = Buyer\'s Agent, LA = Listing/Seller\'s Agent. Return per form:\n' +
  '   - "required_signers": the subset of ["B","S","BA","LA"] this form actually requires to sign or initial (judge from the form\'s own signature and initial lines; NOT every form needs all four).\n' +
  '   - "present_signers": the subset of required_signers who have ACTUALLY completed their signature AND every initial they are required to on that form. A party counts as present ONLY if all of their required marks are done; if any required initial or signature for that party is missing, do NOT include them.\n' +
  'Judge by how a party actually signed: a wet signature, a DocuSign/e-sign block, or initials all count. A pre-printed or typed party name (e.g. a typed "Seller" name that is a trust or LLC) is NOT a signature.\n\n' +
  'Respond with ONLY this JSON (no prose, no fences):\n' +
  '{"forms":[{"code":"TDS","name":"Real Estate Transfer Disclosure Statement","revision":"12/25","pages":[3,4,5],"required_signers":["S","B","BA","LA"],"present_signers":["S","B","BA","LA"]}]}';

// Map a signer value (token or word) to one of B/S/BA/LA, else null.
function toToken(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'b' || s === 'buyer' || s === 'buyers') return 'B';
  if (s === 's' || s === 'seller' || s === 'sellers') return 'S';
  if (s === 'ba' || /buyer'?s?\s*agent/.test(s) || s === 'buyer agent') return 'BA';
  if (s === 'la' || /listing\s*agent/.test(s) || /seller'?s?\s*agent/.test(s) || s === 'seller agent') return 'LA';
  return null;
}
function normSigners(arr) {
  const set = new Set((Array.isArray(arr) ? arr : []).map(toToken).filter(Boolean));
  return SIGNER_ORDER.filter((t) => set.has(t));
}

// FX when every required signer is present; else Need<missing, in fixed order>.
function statusSuffix(form) {
  const required = normSigners(form.required_signers);
  const present = new Set(normSigners(form.present_signers));
  const missing = required.filter((t) => !present.has(t));
  if (!missing.length) return 'FX';
  return 'Need' + SIGNER_ORDER.filter((t) => missing.includes(t)).join('+');
}

// Sanitize a form code/name for a filename (Drive tolerates most chars, but keep
// it clean and slash-free).
function clean(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Build "<CODE> - <Name> - <STATUS>.pdf", appending " (2)", " (3)"... if that
// name is already taken (existing folder file or one produced this run).
function uniqueName(base, taken) {
  let name = `${base}.pdf`;
  let n = 2;
  while (taken.has(name.toLowerCase())) {
    name = `${base} (${n}).pdf`;
    n++;
  }
  taken.add(name.toLowerCase());
  return name;
}

// ----------------------------------------------------------------------------
exports.handler = async function (event) {
  let envelope;
  try {
    envelope = JSON.parse(event.body || '{}');
  } catch (err) {
    console.error('[disclosure-split] invalid JSON body');
    return { statusCode: 400 };
  }

  const source = envelope.source || {};
  const location = envelope.location || {};
  const fileId = source.fileId;
  const propertyFolderId = location.propertyFolderId;
  const incomingFolderId = location.incomingFolderId;
  const eventId = envelope.id || fileId || '';

  if (envelope.event && envelope.event !== EVENTS.DISCLOSURE_UPLOADED) {
    console.log(`[disclosure-split] ignoring event type ${envelope.event}`);
    return { statusCode: 200 };
  }
  if (!fileId || !propertyFolderId) {
    console.error('[disclosure-split] missing source.fileId or location.propertyFolderId');
    return { statusCode: 400 };
  }

  const done = getStore(blobsConfig(DONE_STORE));
  try {
    if (await done.get(eventId, { type: 'json' }).catch(() => null)) {
      console.log(`[disclosure-split] already processed ${eventId}, skipping`);
      return { statusCode: 200 };
    }

    // 1) Download + sanity-check the PDF.
    const buffer = await drive.download(fileId);
    if (!(buffer && buffer.length >= 4 && buffer.subarray(0, 4).equals(PDF_MAGIC))) {
      throw new Error(`downloaded file is not a PDF (${source.fileName || fileId})`);
    }
    if (buffer.length > MAX_DOC_BYTES) throw new Error(`file too large (${buffer.length}B)`);

    // 2) Analyze: split map + signature audit.
    const content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') }, title: source.fileName || 'disclosures.pdf' },
      { type: 'text', text: ANALYZE_PROMPT },
    ];
    const parsed = parseJson(await callClaude(content, 20000));
    const forms = (Array.isArray(parsed.forms) ? parsed.forms : [])
      .map((f) => ({
        code: clean(f.code),
        name: clean(f.name),
        revision: String(f.revision || '').trim(),
        pages: (Array.isArray(f.pages) ? f.pages : []).map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= 1),
        required_signers: f.required_signers,
        present_signers: f.present_signers,
      }))
      .filter((f) => (f.code || f.name) && f.pages.length);

    if (!forms.length) {
      throw new Error('no forms with page ranges identified — leaving original in place for manual handling');
    }

    // 3) Load the source once; prepare the extractor.
    const srcDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pageCount = srcDoc.getPageCount();
    async function extract(pages) {
      const out = await PDFDocument.create();
      const idx = pages.map((n) => n - 1).filter((i) => i >= 0 && i < pageCount);
      if (!idx.length) return null;
      const copied = await out.copyPages(srcDoc, idx);
      copied.forEach((p) => out.addPage(p));
      return Buffer.from(await out.save());
    }

    // Name-collision set = existing files already in the property folder.
    const existing = await drive.listChildren(propertyFolderId, { excludeFolders: true }).catch(() => []);
    const taken = new Set(existing.map((f) => String(f.name || '').toLowerCase()));

    // 4) Split + name + upload each form.
    const results = [];
    const coveredPages = new Set();
    for (const form of forms) {
      form.pages.forEach((p) => coveredPages.add(p));
      const status = statusSuffix(form);
      const label = [form.code, form.name].filter(Boolean).join(' - ');
      const base = `${label} - ${status}`;
      const filename = uniqueName(base, taken);
      const bytes = await extract(form.pages);
      if (!bytes) { console.warn(`[disclosure-split] ${label}: no valid pages, skipped`); continue; }
      const uploaded = await drive.uploadMultipart({ name: filename, parents: [propertyFolderId], mimeType: 'application/pdf', bytes });
      results.push({ code: form.code, name: form.name, status, filename, fileId: uploaded.id, pages: form.pages });
      console.log(`[disclosure-split] wrote "${filename}" (pages ${form.pages.join(',')})`);
    }

    // Any pages no form claimed -> one Unsorted file for manual review, flagged.
    const unsortedPages = [];
    for (let p = 1; p <= pageCount; p++) if (!coveredPages.has(p)) unsortedPages.push(p);
    let unsorted = null;
    if (unsortedPages.length) {
      const bytes = await extract(unsortedPages);
      if (bytes) {
        const filename = uniqueName('Unsorted - review', taken);
        const uploaded = await drive.uploadMultipart({ name: filename, parents: [propertyFolderId], mimeType: 'application/pdf', bytes });
        unsorted = { filename, fileId: uploaded.id, pages: unsortedPages };
        console.warn(`[disclosure-split] ${unsortedPages.length} page(s) unassigned -> "${filename}"`);
      }
    }

    // 5) Archive the original into Incoming/_processed/.
    if (incomingFolderId) {
      try {
        const processed = await drive.ensureFolder('_processed', incomingFolderId);
        await drive.moveFile(fileId, { addParents: [processed.id], removeParents: [incomingFolderId] });
        console.log('[disclosure-split] archived original to _processed/');
      } catch (err) {
        console.warn(`[disclosure-split] could not archive original (non-fatal): ${err.message}`);
      }
    }

    // 6) Mark done + emit disclosure.split for downstream consumers.
    await done.setJSON(eventId, { at: new Date().toISOString(), files: results.map((r) => r.filename) });
    const splitEvent = makeEvent(EVENTS.DISCLOSURE_SPLIT, {
      id: eventId,
      source,
      location,
      split: results,
      unsorted,
    });
    await publish(splitEvent);

    console.log(`[disclosure-split] complete — ${results.length} form(s) filed to ${location.propertyFolderName || propertyFolderId}` + (unsorted ? `, ${unsortedPages.length} page(s) unsorted` : ''));
    return { statusCode: 200 };
  } catch (err) {
    console.error('[disclosure-split] ERROR:', err.message);
    // Do NOT mark done and do NOT archive on error, so a re-drop reprocesses.
    return { statusCode: 500 };
  }
};
