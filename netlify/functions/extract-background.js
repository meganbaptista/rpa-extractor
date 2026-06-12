// ── EXTRACT-BACKGROUND.JS ───────────────────────────────────────────────────
// Diagnostic checkpoints (remove once we confirm module loads cleanly):
console.log('[extract-background] module loading (line 1)');

// Self-contained Netlify background function for long-running RPA/RLA
// extraction. The filename suffix `-background.js` triggers Netlify's
// background-function mode (15-minute timeout, no synchronous HTTP response
// back to caller). Invoked async by submit.js via fetch.
//
// Why is this duplicated from extract.js instead of using require()?
// Netlify bundles each file in netlify/functions/ as its own isolated
// Lambda — when this file did `require('./extract.js')`, the bundler didn't
// include extract.js as a dependency, so the require failed at module load
// and the function returned 500 before any console.log fired. Inlining the
// logic avoids that bundling issue entirely.
//
// Differences from extract.js:
//   • Reads jobId from body and writes result to Netlify Blobs instead of
//     returning the extraction as an HTTP response
//   • Removed the airtable_search and airtable_table paths — those are only
//     called by other Zapier flows and don't need backgrounding
//
// Body shape received from submit.js:
//   { jobId, documents, prompt_override? }

// ── DEPENDENCIES ────────────────────────────────────────────────────────────
// pdf-parse 2.x: PDFParse class with getText() returning per-page text.
// pdf-lib: copies selected pages into a fresh PDF for the targeted call.
// @netlify/blobs: persistence layer for job status, read by result.js
const { PDFDocument } = require('pdf-lib');
console.log('[extract-background] pdf-lib loaded');
// pdf-parse 2.x depends on pdfjs-dist which needs DOMMatrix/Path2D/ImageData
// polyfills that Node.js doesn't provide. The library can load @napi-rs/canvas
// for these, but that package doesn't bundle into Lambda environments without
// a special layer. pdf-parse ships its own CanvasFactory under the /worker
// export specifically for environments like Netlify Functions where the
// canvas package isn't available. Importing it before pdf-parse is loaded
// and passing it into every PDFParse() constructor avoids the DOMMatrix
// crash entirely.
const { CanvasFactory } = require('pdf-parse/worker');
console.log('[extract-background] pdf-parse worker (CanvasFactory) loaded');
const { PDFParse } = require('pdf-parse');
console.log('[extract-background] pdf-parse loaded');
const { getStore } = require('@netlify/blobs');
console.log('[extract-background] @netlify/blobs loaded');

// ── BLOB STORE ACCESS (explicit credentials) ────────────────────────────────
// Auto-config (via connectLambda or implicit context) doesn't work reliably
// in background functions invoked via fetch from another function. Using
// explicit credentials is bulletproof regardless of invocation path.
function getJobStore() {
  if (!process.env.NETLIFY_BLOBS_TOKEN) {
    throw new Error('NETLIFY_BLOBS_TOKEN env var is not set — generate a Netlify Personal Access Token and add it as a site environment variable.');
  }
  return getStore({
    name: 'extraction-jobs',
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN
  });
}

// Separate store for the PDF payload, written by submit.js and read here.
// We delete the payload after extraction completes (or fails) so we don't
// retain PDF data longer than needed.
function getPayloadStore() {
  if (!process.env.NETLIFY_BLOBS_TOKEN) {
    throw new Error('NETLIFY_BLOBS_TOKEN env var is not set — generate a Netlify Personal Access Token and add it as a site environment variable.');
  }
  return getStore({
    name: 'extraction-payloads',
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN
  });
}
// Best-effort cleanup of the payload blob once extraction completes (or
// fails). If this throws, we just log — the payload's TTL will eventually
// evict it anyway, no point failing the whole job for a cleanup miss.
async function deletePayloadSafe(payloadStore, jobId) {
  if (!payloadStore || !jobId) return;
  try {
    await payloadStore.delete(jobId);
    console.log('extract-background: deleted payload for job ' + jobId);
  } catch (cleanupErr) {
    console.warn('extract-background: payload cleanup failed (non-fatal): ' + cleanupErr.message);
  }
}

console.log('[extract-background] module fully loaded, handler ready');

// ── PAGE-DETECTION MARKERS ──────────────────────────────────────────────────
// These two literal strings have been stable in CAR purchase agreement forms
// for years and appear on EXACTLY the two RPA pages the targeted call needs:
//   • "Date Prepared:" → top-left of page 1 of the RPA/VLPA/RIPA/CPA
//   • "REAL ESTATE BROKERS SECTION" → header of the last page of the RPA
// If CAR ever renames either, page detection silently fails and we fall back
// to sending the full package (current behavior). No regression.
const DATE_PREPARED_MARKER = 'Date Prepared:';
const BROKERS_SECTION_MARKER = 'REAL ESTATE BROKERS SECTION';

// ── IMAGE FALLBACK CONFIG ──────────────────────────────────────────────────
// Cap on how many pages we'll render server-side and send to Sonnet as images.
// The RPA is always 17 pages and typically starts within the first 10 pages of
// a package, so 30 covers >99% of legitimate real estate packages. Bounds:
//   • Render time (~330ms/page) — 30 pages renders in ~10s, fits within the
//     parallel-with-main-call window
//   • Cost — ~$0.0005 per page in vision tokens, so 30 pages adds ~$0.015
//   • Attention — keeps the model focused on the relevant page set
// If a real package exceeds this cap, the call truncates and logs a warning.
const MAX_FALLBACK_PAGES = 30;

// ── HELPER: extract text from each page of a PDF buffer ─────────────────────
// Returns an array of strings, one per page (page 1 at index 0).
async function getPageTexts(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer), CanvasFactory });
  try {
    const result = await parser.getText();
    // result.pages is [{num, text}, ...] sorted by page number.
    return result.pages.map((p) => p.text || '');
  } finally {
    await parser.destroy();
  }
}

// ── HELPER: TEXT-LAYER page detection (fast, free, works on born-digital PDFs) ──
// Scans each document's text layer for the two markers. Returns -1 indices
// for any marker not found. Fails on print-and-rescan PDFs whose text layer
// has been destroyed — that's what the vision fallback below handles.
async function locateRpaPagesViaText(documents) {
  const result = { dpDoc: -1, dpPage: -1, brokersDoc: -1, brokersPage: -1 };

  for (let docIdx = 0; docIdx < documents.length; docIdx++) {
    const buffer = Buffer.from(documents[docIdx].data, 'base64');
    let pageTexts;
    try {
      pageTexts = await getPageTexts(buffer);
    } catch (err) {
      console.warn('pdf-parse failed on document ' + docIdx + ' (' + (documents[docIdx].label || 'unlabeled') + '): ' + err.message);
      continue;
    }

    for (let pageIdx = 0; pageIdx < pageTexts.length; pageIdx++) {
      const text = pageTexts[pageIdx];
      if (result.dpDoc === -1 && text.indexOf(DATE_PREPARED_MARKER) !== -1) {
        result.dpDoc = docIdx;
        result.dpPage = pageIdx;
      }
      if (result.brokersDoc === -1 && text.indexOf(BROKERS_SECTION_MARKER) !== -1) {
        result.brokersDoc = docIdx;
        result.brokersPage = pageIdx;
      }
    }

    if (result.dpDoc !== -1 && result.brokersDoc !== -1) break;
  }

  return result;
}

// ── HELPER: VISION page detection (fallback for print-and-rescan PDFs) ─────
// When text extraction can't find the markers (PDF text layer is broken or
// missing), send the full PDF to Claude Haiku with a single-purpose tool that
// returns the 1-indexed page numbers for the two markers. Haiku's vision
// pipeline reads the rendered pages directly — same way the model reads pages
// with broken text layers during normal extraction.
//
// Multi-document packages: the vision fallback only checks document 0. If a
// caller ever splits the RPA across multiple uploaded files (uncommon), the
// vision path won't find it and we fall through to the full-package behavior.
async function locateRpaPagesViaVision(documents, apiKey) {
  const result = { dpDoc: -1, dpPage: -1, brokersDoc: -1, brokersPage: -1 };

  if (!documents.length) return result;
  // Use the first document — typically the full package is uploaded as one file.
  const docIdx = 0;

  const locateTool = {
    name: 'locate_pages',
    description: 'Report the 1-indexed page numbers where two markers appear in the document.',
    input_schema: {
      type: 'object',
      properties: {
        date_prepared_page: {
          type: 'integer',
          description: 'The 1-indexed page number where the literal label "Date Prepared:" appears at the top-left. This is page 1 of the California Residential Purchase Agreement (RPA/VLPA/RIPA/CPA). The page typically has a footer reading "RPA REVISED 12/25 (PAGE 1 OF 17)" or similar. Return 0 if not found anywhere in the document.'
        },
        brokers_section_page: {
          type: 'integer',
          description: 'The 1-indexed page number where the heading "REAL ESTATE BROKERS SECTION" appears at the top of the page. This is the LAST page of the RPA, typically with a footer reading "PAGE 17 OF 17". Return 0 if not found anywhere in the document.'
        }
      },
      required: ['date_prepared_page', 'brokers_section_page']
    }
  };

  const body = {
    // Switched from Haiku to Sonnet for vision page detection. Haiku was
    // returning 0/0 (page-not-found) too often on print/rescan PDFs because
    // OCR'ing tiny footer text is at the edge of its vision capability.
    // Sonnet is more reliable here. Adds ~$0.10 per vision-path contract.
    model: 'claude-sonnet-4-5',
    max_tokens: 200,
    tools: [locateTool],
    tool_choice: { type: 'tool', name: 'locate_pages' },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: documents[docIdx].data } },
        { type: 'text', text: 'Find two specific pages in this multi-document package.\n\nPage A is page 1 of the RPA (California Residential Purchase Agreement). Identifiers:\n• Top-left has the literal label "Date Prepared:" followed by a date\n• Header "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS" centered at top\n• Footer reads "RPA REVISED 12/25 (PAGE 1 OF 17)" or similar variant\n• Paragraph 1 "OFFER" begins on this page\n\nPage B is the LAST page of the RPA (typically PAGE 17 OF 17). Identifiers:\n• Heading "REAL ESTATE BROKERS SECTION"\n• Two subsections labeled "A. Buyer\'s Brokerage Firm" and "B. Seller\'s Brokerage Firm"\n• Footer reads "RPA REVISED 12/25 (PAGE 17 OF 17)"\n\nBoth pages are present in this document. Return your best-guess 1-indexed page numbers via the locate_pages tool.' }
      ]
    }]
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();

  if (!Array.isArray(data.content)) {
    console.warn('vision page-detection: unexpected response shape, no content array');
    return result;
  }
  const toolUse = data.content.find((b) => b.type === 'tool_use');
  if (!toolUse || !toolUse.input) {
    console.warn('vision page-detection: no tool_use block in response');
    return result;
  }

  const dpPageOneIndexed = toolUse.input.date_prepared_page;
  const brokersPageOneIndexed = toolUse.input.brokers_section_page;

  if (typeof dpPageOneIndexed === 'number' && dpPageOneIndexed > 0) {
    result.dpDoc = docIdx;
    result.dpPage = dpPageOneIndexed - 1; // convert to 0-indexed
  }
  if (typeof brokersPageOneIndexed === 'number' && brokersPageOneIndexed > 0) {
    result.brokersDoc = docIdx;
    result.brokersPage = brokersPageOneIndexed - 1;
  }
  return result;
}

// ── HELPER: orchestrate text-first, vision-fallback page detection ─────────
// This is the hybrid: try free text extraction first. Only pay for a vision
// call if text fails. Born-digital PDFs cost nothing extra; print/rescan PDFs
// pay one cheap Haiku call.
async function locateRpaPagesWithFallback(documents, apiKey) {
  const textResult = await locateRpaPagesViaText(documents);
  if (textResult.dpDoc !== -1 && textResult.brokersDoc !== -1) {
    console.log('page detection: text-layer path succeeded');
    return { located: textResult, method: 'text' };
  }

  console.log(
    'page detection: text-layer path missed ' +
    '(date_prepared_found=' + (textResult.dpDoc !== -1) +
    ', brokers_section_found=' + (textResult.brokersDoc !== -1) + '), ' +
    'trying vision fallback'
  );

  try {
    const visionResult = await locateRpaPagesViaVision(documents, apiKey);
    if (visionResult.dpDoc !== -1 && visionResult.brokersDoc !== -1) {
      console.log('page detection: vision fallback succeeded ' +
        '(date_prepared=page' + (visionResult.dpPage + 1) +
        ', brokers_section=page' + (visionResult.brokersPage + 1) + ')');
      return { located: visionResult, method: 'vision' };
    }
    console.warn(
      'page detection: vision fallback also missed ' +
      '(date_prepared_found=' + (visionResult.dpDoc !== -1) +
      ', brokers_section_found=' + (visionResult.brokersDoc !== -1) + ')'
    );
    return { located: visionResult, method: 'vision-failed' };
  } catch (visionErr) {
    console.warn('page detection: vision fallback errored: ' + visionErr.message);
    return { located: textResult, method: 'vision-errored' };
  }
}

// ── HELPER: build a 2-page PDF from located pages, return base64 ───────────
async function buildTrimmedPdf(documents, located) {
  const newPdf = await PDFDocument.create();

  if (located.dpDoc === located.brokersDoc) {
    // Both target pages live in the same source PDF — load it once.
    // ignoreEncryption: many CAR/DocuSign PDFs are permissions-encrypted
    // (empty owner password, restriction flags) but fully readable. Without
    // this flag pdf-lib throws on load and the trim is skipped.
    const srcBuffer = Buffer.from(documents[located.dpDoc].data, 'base64');
    const srcPdf = await PDFDocument.load(srcBuffer, { ignoreEncryption: true });
    const [dpPage, brokersPage] = await newPdf.copyPages(
      srcPdf,
      [located.dpPage, located.brokersPage]
    );
    newPdf.addPage(dpPage);
    newPdf.addPage(brokersPage);
  } else {
    // The two target pages live in different source PDFs (e.g. RPA uploaded
    // as two separate files). Load each source separately.
    const dpBuffer = Buffer.from(documents[located.dpDoc].data, 'base64');
    const dpSrc = await PDFDocument.load(dpBuffer, { ignoreEncryption: true });
    const [dpPage] = await newPdf.copyPages(dpSrc, [located.dpPage]);
    newPdf.addPage(dpPage);

    const brokersBuffer = Buffer.from(documents[located.brokersDoc].data, 'base64');
    const brokersSrc = await PDFDocument.load(brokersBuffer, { ignoreEncryption: true });
    const [brokersPage] = await newPdf.copyPages(brokersSrc, [located.brokersPage]);
    newPdf.addPage(brokersPage);
  }

  const newBytes = await newPdf.save();
  return Buffer.from(newBytes).toString('base64');
}

// ── HELPER: build a trimmed RPA document for the MAIN call ─────────────────
// Different goal than buildTrimmedPdf (which is for the targeted call's 2-page
// extraction). The main call needs: page 1 of RPA (paragraph 1, paragraph 3
// terms table), pages 2-4 (allocations, addenda, financing), pages 15-17
// (paragraph 33 acceptance, brokers section), plus everything before and
// after the RPA inside the same document (counter offers, addenda). Skips
// RPA pages 5-14 — pure legal boilerplate the model doesn't extract from.
//
// Returns null if trimming is unsafe (RPA split across documents, RPA too
// short to benefit, pdf-lib error). Caller falls back to the original
// document data when null.
async function buildTrimmedMainPdf(documents, located) {
  // Safety: only trim when the RPA lives in a single document. If RPA p1 and
  // last page are in different uploaded files, skip the main trim — too many
  // edge cases to reason about (which doc gets the "before" pages, etc.)
  if (located.dpDoc !== located.brokersDoc) {
    return null;
  }

  const docIdx = located.dpDoc;
  const rpaStartIdx = located.dpPage;
  const rpaEndIdx = located.brokersPage;
  const rpaLength = rpaEndIdx - rpaStartIdx + 1;

  // Safety: if RPA is shorter than 8 pages, first-4 and last-3 overlap or
  // touch — no boilerplate to remove. Skip the trim.
  if (rpaLength < 8) {
    return null;
  }

  const srcBuffer = Buffer.from(documents[docIdx].data, 'base64');
  const srcPdf = await PDFDocument.load(srcBuffer, { ignoreEncryption: true });
  const totalPages = srcPdf.getPageCount();

  // Build the list of page indices to keep, in document order.
  const indicesToKeep = [];
  // (a) Everything BEFORE the RPA in this document (counter offers, etc).
  for (let i = 0; i < rpaStartIdx; i++) indicesToKeep.push(i);
  // (b) RPA pages 1-4 (offer terms, agency, paragraph 3 contract table).
  for (let i = rpaStartIdx; i <= rpaStartIdx + 3; i++) indicesToKeep.push(i);
  // (c) RPA pages 15-17 (paragraph 33 acceptance, brokers section, signatures).
  for (let i = rpaEndIdx - 2; i <= rpaEndIdx; i++) indicesToKeep.push(i);
  // (d) Everything AFTER the RPA in this document (addenda, advisories).
  for (let i = rpaEndIdx + 1; i < totalPages; i++) indicesToKeep.push(i);

  const newPdf = await PDFDocument.create();
  const copiedPages = await newPdf.copyPages(srcPdf, indicesToKeep);
  copiedPages.forEach((p) => newPdf.addPage(p));

  const newBytes = await newPdf.save();
  return Buffer.from(newBytes).toString('base64');
}
// Used as a final fallback when text-layer detection AND vision page detection
// both fail. By rendering server-side we get clear images that the model can
// read directly, sidestepping whatever Anthropic's internal PDF rendering does
// that causes vision page detection to fail on print/rescan packages. At
// scale 0.5 each page is ~120KB and tokenizes to ~160 tokens (~12x cheaper
// than the equivalent PDF page in vision mode).
//
// `maxPages` caps how many pages are actually rendered via pdf-parse's
// `first: N` option. This skips rendering work entirely for pages beyond the
// cap, not just truncating output. Important for packages with 50+ pages
// where rendering all of them would blow the function timeout.
async function renderAllPagesAsImages(buffer, maxPages) {
  // Peek at total page count so we can log when we're truncating.
  // getInfo is lightweight — doesn't render anything.
  let totalPages = null;
  try {
    const peekParser = new PDFParse({ data: new Uint8Array(buffer), CanvasFactory });
    const info = await peekParser.getInfo();
    // pdf-parse 2.x returns page count under `total`.
    totalPages = info.total || null;
    await peekParser.destroy();
  } catch (peekErr) {
    // Non-fatal — we just skip the truncation warning if peek fails.
  }

  if (totalPages && maxPages && totalPages > maxPages) {
    console.warn(
      'image fallback: package has ' + totalPages + ' pages, ' +
      'rendering only first ' + maxPages + ' (cap)'
    );
  }

  const parser = new PDFParse({ data: new Uint8Array(buffer), CanvasFactory });
  try {
    const options = { scale: 0.5 };
    if (maxPages) options.first = maxPages;
    const result = await parser.getScreenshot(options);
    return result.pages
      .filter((p) => p.data)
      .map((p) => ({
        pageNumber: p.pageNumber,
        base64: Buffer.from(p.data).toString('base64')
      }));
  } finally {
    await parser.destroy();
  }
}

exports.handler = async function(event, context) {
  console.log('[extract-background] handler invoked');

  // Background functions don't return useful HTTP responses to the caller —
  // submit.js's fetch gets 202 from Netlify's runtime, then we run async.
  // We respond { statusCode: 200 } at the end purely for log readability.
  let jobId = null;
  let store = null;
  let payloadStore = null;
  let existing = {};

  try {
    const body = JSON.parse(event.body);
    jobId = body.jobId;

    if (!jobId) {
      console.error('extract-background invoked without jobId');
      return { statusCode: 400 };
    }

    console.log('extract-background: starting job ' + jobId);

    // Grab the existing pending record so we preserve submitted_at/expires_at
    // when we write the completed or failed state.
    store = getJobStore();
    existing = (await store.get(jobId, { type: 'json' })) || {};

    // Fetch the actual PDF payload from the payload store. Submit.js stashed
    // it there because the 256 KB invocation-payload limit prevented sending
    // PDFs through the fetch body.
    payloadStore = getPayloadStore();
    const payload = await payloadStore.get(jobId, { type: 'json' });
    if (!payload || !payload.documents) {
      throw new Error('Payload not found in extraction-payloads store for jobId=' + jobId);
    }
    console.log('extract-background: loaded payload (' + payload.documents.length + ' documents)');

    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }

    const startedAt = Date.now();
    const documents = payload.documents;
    const promptOverride = payload.prompt_override;
    const content = [];

    documents.forEach(doc => {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: doc.data },
        title: doc.label
      });
    });

    // ── RLA / CUSTOM PROMPT PATH (unchanged JSON-text behavior) ───────────────
    if (promptOverride) {
      content.push({ type: 'text', text: promptOverride });

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 2500,
          messages: [{ role: 'user', content }]
        })
      });

      const data = await response.json();
      await store.setJSON(jobId, {
        ...existing,
        status: 'complete',
        result: data,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt
      });
      console.log('extract-background: job ' + jobId + ' complete (RLA path)');
      await deletePayloadSafe(payloadStore, jobId);
      return { statusCode: 200 };
    }

    // ── RPA PATH: TOOL USE (structured outputs) ───────────────────────────────
    // Each field is defined as a tool parameter with its own description.
    // The model fills each field with the field's description in active context,
    // which dramatically improves accuracy on commonly-missed fields like
    // date_rpa_prepared and buyer_agent_*.

    const FIELDS = require('./lib/rpa-fields').FIELDS;

    const extractionTool = {
      name: "extract_contract_fields",
      description: "Extract structured fields from a California real estate purchase agreement package. The package may include the original purchase agreement (RPA, VLPA, RIPA, or CPA — all use the same structure), counter offers (BCO, SCO), addenda, MLS listing, and property profile report. Cross-reference all documents to fill gaps. Each field below has its own specific extraction rules — read each field's description carefully before populating it. Normalize all text to proper case (never ALL CAPS). Use empty string for any field not found.",
      input_schema: {
        type: "object",
        properties: FIELDS,
        required: Object.keys(FIELDS)
      }
    };

    // Build content for the main extraction call.
    const mainContent = [...content, {
      type: 'text',
      text: 'Extract all required fields from the attached California real estate purchase agreement package by calling the extract_contract_fields tool. Read each field description carefully — they contain specific source-priority and disambiguation rules.'
    }];

    const callApi = (msgContent, tool) => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        tools: [tool],
        tool_choice: { type: "tool", name: tool.name },
        messages: [{ role: 'user', content: msgContent }]
      })
    }).then(r => r.json());

    const findToolUse = (resp) => Array.isArray(resp.content)
      ? resp.content.find(b => b.type === 'tool_use')
      : null;

    // ─── TARGETED CALL DEFINITIONS ────────────────────────────────────────────
    // Pulled OUT of the conditional block so we can fire the targeted call in
    // parallel with the main call (see PARALLEL EXECUTION below).
    const TARGETED_FIELD_NAMES = [
      'date_rpa_prepared',
      'buyer_agent_name',
      'buyer_agent_dre',
      'buyer_agent_brokerage_name',
      'buyer_agent_brokerage_dre',
      'buyer_agent_address',
      'buyer_agent_email',
      'buyer_agent_phone',
      // buyer_agent_name_2 and _dre_2 intentionally NOT in the trigger list —
      // they're legitimately empty when only one agent signs, so an empty
      // value here doesn't mean the main call failed.
      'seller_agent_name',
      'seller_agent_dre',
      'seller_agent_brokerage_name',
      'seller_agent_brokerage_dre',
      'seller_agent_address',
      'seller_agent_email',
      'seller_agent_phone'
      // seller_agent_email_2 (co-listing agent) is an MLS-only concept — the
      // targeted call only sees the 2-page RPA trim, so it never sources it.
    ];

    const TARGETED_FIELDS = {
      date_rpa_prepared: FIELDS.date_rpa_prepared,
      buyer_agent_name: FIELDS.buyer_agent_name,
      buyer_agent_dre: FIELDS.buyer_agent_dre,
      buyer_agent_name_2: FIELDS.buyer_agent_name_2,
      buyer_agent_dre_2: FIELDS.buyer_agent_dre_2,
      buyer_agent_brokerage_name: FIELDS.buyer_agent_brokerage_name,
      buyer_agent_brokerage_dre: FIELDS.buyer_agent_brokerage_dre,
      buyer_agent_address: FIELDS.buyer_agent_address,
      buyer_agent_email: FIELDS.buyer_agent_email,
      buyer_agent_phone: FIELDS.buyer_agent_phone,
      // Seller agent — sourced ONLY from subsection B "Seller's Brokerage Firm"
      // on the last page of the RPA. The targeted call sees only the 2-page RPA
      // trim (no MLS), so these descriptions point exclusively at subsection B.
      // The merge step decides whether these win over the main call.
      seller_agent_name: { type: "string", description: "Seller's agent name from the FIRST 'By' line in subsection B 'Seller's Brokerage Firm' on the LAST PAGE of the RPA. CRITICAL: subsection A 'Buyer's Brokerage Firm' sits directly ABOVE subsection B on the same page with an identical layout — DO NOT pull this name from subsection A, that is the buyer's agent, a completely different person. The seller agent name is on the line directly under 'B. Seller's Brokerage Firm'. The name may be a faint cursive DocuSign signature with the printed name beside or below it — read the printed name. If the name is illegible, return empty string (do not guess). Example: 'By Lauren Reichenberg   DRE Lic. # 01415570' → return 'Lauren Reichenberg'." },
      seller_agent_dre: { type: "string", description: "Seller agent INDIVIDUAL DRE license number from the FIRST 'By' line in subsection B on the LAST PAGE of the RPA. This is the individual agent's DRE, NOT the brokerage's DRE (which sits on the firm-name line). DO NOT pull from subsection A — that is the buyer agent's DRE, a different number. Example: 'By Lauren Reichenberg   DRE Lic. # 01415570' → return '01415570'." },
      seller_agent_brokerage_name: { type: "string", description: "Seller's brokerage/listing firm name from the 'B. Seller's Brokerage Firm' line in subsection B on the LAST PAGE of the RPA. DO NOT pull from subsection A (that is the buyer's brokerage). Example: 'B. Seller's Brokerage Firm Compass' → return 'Compass'." },
      seller_agent_brokerage_dre: { type: "string", description: "Seller brokerage DRE on the SAME LINE as the seller brokerage firm name in subsection B (NOT the agent's individual DRE line). DO NOT pull from subsection A. Example: 'B. Seller's Brokerage Firm Compass   DRE Lic. # 01991628' → return '01991628'." },
      seller_agent_address: { type: "string", description: "Seller agent OFFICE STREET ADDRESS from subsection B on the LAST PAGE of the RPA — the Address line between the 'By' lines and the Email line. Combine Address + City + State + Zip into one string. This is a STREET ADDRESS, never a phone number. Subsection B's contact lines are frequently BLANK — if the Address line after the label is empty, return empty string (do NOT borrow the address from subsection A). DO NOT pull from subsection A." },
      seller_agent_email: { type: "string", description: "Seller agent email from subsection B on the LAST PAGE of the RPA — shares the line with 'Phone #'. Subsection B's email is frequently BLANK — if empty, return empty string (do NOT borrow the email from subsection A, that is the buyer agent's email). DO NOT pull from subsection A, CCPA pages, advisories, or the document footer." },
      seller_agent_phone: { type: "string", description: "Seller agent phone from subsection B, on the SAME line as seller_agent_email, after 'Phone #'. Frequently BLANK in subsection B — if empty, return empty string (do NOT borrow from subsection A). DO NOT pull from subsection A." }
    };

    const targetedTool = {
      name: "extract_targeted_fields",
      description: "Extract a small set of fields from a California real estate purchase agreement package. You have ONE job: locate two specific pages and extract from them. (1) Find page 1 of the original RPA/VLPA/RIPA/CPA — identifiable by the literal label 'Date Prepared:' at the top-left and the footer 'PAGE 1 OF 17' or similar — and extract the date next to that label. (2) Find the LAST PAGE of the same RPA — identifiable by the 'REAL ESTATE BROKERS SECTION' header and the footer 'PAGE 17 OF 17' or similar — and extract everything from subsection A 'Buyer's Brokerage Firm'. Both pages exist in the package. The RPA is always present. Read each field description carefully and return values directly from those two pages.",
      input_schema: {
        type: "object",
        properties: TARGETED_FIELDS,
        required: Object.keys(TARGETED_FIELDS)
      }
    };

    const TARGETED_PROMPT = `Your task is narrow and specific. The attached package contains a California real estate purchase agreement (RPA / VLPA / RIPA / CPA). Find these two pages in the document set and extract from them by calling the extract_targeted_fields tool:

• Page 1 of the RPA — top-left contains the literal text "Date Prepared:" followed by a date. The footer on this page reads "RPA REVISED 12/25 (PAGE 1 OF 17)" or similar variant. Extract the date for date_rpa_prepared.

• Last page of the RPA (typically PAGE 17 OF 17) — titled "REAL ESTATE BROKERS SECTION". This page contains TWO subsections that look almost identical. Buyer fields come from subsection A; seller fields come from subsection B:

  ┌─────────────────────────────────────────────────────────┐
  │ A. Buyer's Brokerage Firm  [BUYER firm]    DRE # [...]  │  ← buyer_agent_* fields
  │    By [BUYER agent 1]                      DRE # [...]  │  ← buyer_agent_* fields
  │    By [BUYER agent 2 if any]               DRE # [...]  │  ← buyer_agent_* fields
  │    Address [BUYER office addr]  City  State  Zip        │  ← buyer_agent_* fields
  │    Email [BUYER agent email]    Phone # [BUYER phone]   │  ← buyer_agent_* fields
  │    ☐ More than one agent from the same firm...          │
  ├─────────────────────────────────────────────────────────┤
  │ B. Seller's Brokerage Firm [SELLER firm]   DRE # [...]  │  ← seller_agent_* fields
  │    By [SELLER agent 1]                     DRE # [...]  │  ← seller_agent_* fields
  │    Address [SELLER office addr] City State Zip          │  ← seller_agent_* fields
  │    Email [SELLER email]         Phone # [SELLER phone]  │  ← seller_agent_* fields
  └─────────────────────────────────────────────────────────┘

The two subsections are mirror images with identical labels (firm, By, DRE, Address, Email, Phone) but completely different people. Keep them strictly separated:
• EVERY buyer_agent_* field MUST come from subsection A only. Never pull a buyer field from subsection B.
• EVERY seller_agent_* field MUST come from subsection B only. Never pull a seller field from subsection A.
A common failure mode is locking onto the right subsection for the agent name, then drifting into the other subsection for the remaining fields. Re-anchor on the correct subsection header — "A. Buyer's Brokerage Firm" for buyer fields, "B. Seller's Brokerage Firm" for seller fields — before each field.

This matters most when the SAME brokerage represents both sides (dual agency) and/or the agency boxes are checked "both the Buyer's and Seller's Agent." Even then, the buyer agent is whoever signs under subsection A and the seller agent is whoever signs under subsection B — they are different people with different DRE numbers. Anchor on the subsection header and the DRE, never on the dual-agency wording.

Subsection B's contact lines (Address, Email, Phone) are frequently BLANK even when the seller agent name and DRE are filled in. When a subsection B contact line is blank, return an EMPTY STRING for that field — do NOT borrow the buyer's address, email, or phone from subsection A to fill a seller field.

Address fields are STREET ADDRESSES like "23046 Avenida De La Carlota, Ste 600, Laguna Hills, CA 92653" — never a phone number. If you are about to return digits like "949-707-4400" for an address, stop and re-read the Address line in the correct subsection.

ANTI-HALLUCINATION RULES — read carefully:

When you CAN clearly read the value on the page (text is sharp, label is visible, value is filled in), return it. The RPA is always present and the agent name/DRE fields are usually filled in, so the common case is non-empty.

But when you CANNOT clearly read a value — page is blurry, OCR text is garbled, label is visible but the line after it is blank or unreadable, or you genuinely cannot find the field — return an EMPTY STRING. An honest blank is always better than a guess.

Specifically, NEVER do any of the following:

• NEVER return "2025" or any year that comes from the form's copyright footer "© 2025 California Association of REALTORS®". The copyright year is NOT the Date Prepared.
• NEVER return "<UNKNOWN>", "N/A", "TBD", "see addendum", or any placeholder string for an agent field. If you can't find the info, return empty string for that field.
• NEVER use a date from elsewhere in the package (counter offer date, signature date, DocuSign timestamp, property profile sale date, MLS list date) as a substitute for date_rpa_prepared.
• NEVER invent an agent name. Only return a name that appears verbatim on the page. If a "By" line is an unreadable signature with no legible printed name, return empty string for that name.
• NEVER infer buyer or seller agent details from the MLS or property profile — neither is included in this 2-page trim.
• NEVER copy values across subsections. If subsection A is unreadable, return empty for the buyer fields; if subsection B is unreadable, return empty for the seller fields. Do not silently fall back to the other subsection.

Empty strings are the correct answer when extraction is uncertain. The user can fill in missing data manually; they cannot easily detect a wrong-but-plausible-looking value that was hallucinated.`;

    const buildTargetedContent = (docs) => [...docs, { type: 'text', text: TARGETED_PROMPT }];

    // Build content for image-fallback path: each rendered page becomes its
    // own image block, followed by the targeted prompt.
    const buildImageFallbackContent = (renderedPages) => {
      const blocks = renderedPages.map((p) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: p.base64 }
      }));
      blocks.push({ type: 'text', text: TARGETED_PROMPT });
      return blocks;
    };

    // ─── ORCHESTRATION ───────────────────────────────────────────────────────
    // Detection runs FIRST (was parallel with main). For text-path success
    // this is <1s, which we trade for the ability to trim the main call's
    // input down — dropping ~10 pages of RPA boilerplate (RPA pages 5-14)
    // that the main call doesn't extract from.
    //
    // Once detection completes, both trims build in parallel, then both API
    // calls fire in parallel. Main call now runs on a trimmed package
    // (typically ~26 pages instead of ~36), reducing main call duration by
    // roughly 20-30% — enough to land consistently under the proxy timeout.
    //
    // Detection paths in order of preference:
    //   1. text_trim — PDF text layer contains markers, build 2-page trim
    //   2. vision_trim_sonnet — Sonnet reads PDF and finds page numbers, trim
    //   3. image_fallback_sonnet — render pages server-side, send to Sonnet
    //   4. failed_all_paths — every method exhausted, targeted fields blank
    //
    // The _extraction_status field is added to the final response so Megan
    // can monitor in Process Street/Airtable which path each contract took.
    let extractionStatus = 'not_attempted';

    // Set if a trim fails with a structurally-damaged-PDF signature. Surfaced
    // in the fallback result so the frontend can give a specific message.
    let pdfStructureError = null;

    let detection = null;
    try {
      detection = await locateRpaPagesWithFallback(documents, process.env.ANTHROPIC_API_KEY);
    } catch (detectErr) {
      console.warn('detection errored (' + detectErr.message + '), falling through to image fallback');
    }
    const located = detection ? detection.located : null;
    const haveDetection = located && located.dpDoc !== -1 && located.brokersDoc !== -1;

    let mainCallPromise;
    let targetedCallPromise = null;

    if (haveDetection) {
      // ── HAPPY PATH: build both trims in parallel, then fire both calls ────
      // Targeted trim is required (the 2-page trim is the whole point of the
      // targeted call). Main trim is optional — if it fails for any reason
      // we fall back to the full original content for the main call.
      let trimmedTargetedB64 = null;
      let trimmedMainB64 = null;
      // Detects a structurally-damaged PDF: pdf-lib throws errors like
      // "Expected instance of PDFDict, but got instance of undefined" when a
      // PDF's internal object table is broken (dangling object refs). This is
      // distinct from encryption (handled by ignoreEncryption) — a corrupt
      // PDF cannot be trimmed AND usually cannot be extracted from. We capture
      // it so the frontend can tell the user specifically to re-save the file.
      const isPdfStructureError = (msg) =>
        /PDFDict|invalid object|object ref|got instance of undefined/i.test(msg || '');
      try {
        [trimmedMainB64, trimmedTargetedB64] = await Promise.all([
          buildTrimmedMainPdf(documents, located).catch((err) => {
            console.warn('main trim failed (' + err.message + '), main call will use full content');
            if (isPdfStructureError(err.message)) pdfStructureError = err.message;
            return null;
          }),
          buildTrimmedPdf(documents, located)
        ]);
      } catch (trimErr) {
        console.warn('targeted trim failed (' + trimErr.message + '), no targeted call this run');
        if (isPdfStructureError(trimErr.message)) pdfStructureError = trimErr.message;
      }

      // Build main content — swap in the trimmed RPA document if we got one.
      let mainContentToSend = mainContent;
      if (trimmedMainB64) {
        const newContent = content.map((block, idx) => {
          if (idx === located.dpDoc) {
            return {
              ...block,
              source: { ...block.source, data: trimmedMainB64 },
              title: (block.title || 'document') + ' (RPA boilerplate trimmed)'
            };
          }
          return block;
        });
        mainContentToSend = [...newContent, { type: 'text', text: mainContent[mainContent.length - 1].text }];
        console.log(
          'main call: trimmed RPA document at doc' + located.dpDoc +
          ' (kept everything before RPA + RPA pages 1-4 + RPA pages 15-17 + everything after)'
        );
      } else {
        console.log('main call: using full content (trim unavailable or unsafe)');
      }

      // Fire main call.
      mainCallPromise = callApi(mainContentToSend, extractionTool);

      // Fire targeted call on the 2-page trim, in parallel with main.
      if (trimmedTargetedB64) {
        const targetedDocs = [{
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: trimmedTargetedB64 },
          title: 'RPA page 1 and brokers section (trimmed)'
        }];
        targetedCallPromise = callApi(buildTargetedContent(targetedDocs), targetedTool);
        extractionStatus = detection.method === 'text' ? 'text_trim' : 'vision_trim_sonnet';
        console.log(
          'targeted call: started in parallel with main, trimmed to 2 pages via ' + detection.method + ' ' +
          '(date_prepared=doc' + located.dpDoc + '/page' + (located.dpPage + 1) +
          ', brokers_section=doc' + located.brokersDoc + '/page' + (located.brokersPage + 1) + ')'
        );
      }
    } else {
      // ── FALLBACK: detection failed entirely. Main call gets full content;
      //    targeted call uses image fallback (render server-side, send images).
      console.warn('detection failed, main call on full content, starting image fallback for targeted in parallel');
      mainCallPromise = callApi(mainContent, extractionTool);
      targetedCallPromise = (async () => {
        const renderStart = Date.now();
        const firstDocBuffer = Buffer.from(documents[0].data, 'base64');
        const renderedPages = await renderAllPagesAsImages(firstDocBuffer, MAX_FALLBACK_PAGES);
        console.log(
          'image fallback: rendered ' + renderedPages.length + ' pages in ' +
          (Date.now() - renderStart) + 'ms, firing targeted call on images'
        );
        return callApi(buildImageFallbackContent(renderedPages), targetedTool);
      })();
      extractionStatus = 'image_fallback_sonnet';
    }

    // Wait for main call. The targeted call is running in parallel and will
    // be awaited next.
    const mainData = await mainCallPromise;
    const mainTool = findToolUse(mainData);
    let mergedFields = mainTool && mainTool.input ? { ...mainTool.input } : {};

    if (targetedCallPromise) {
      try {
        const targetedData = await targetedCallPromise;
        const targetedToolBlock = findToolUse(targetedData);

        if (targetedToolBlock && targetedToolBlock.input) {
          const filled = [];
          const empty = [];
          const skippedForMls = [];
          // Seller agent priority is MLS-first (see FIELDS.seller_agent_*). The
          // targeted call reads subsection B of the RPA brokers section, which
          // should only win for the seller when there is NO MLS in the package.
          // If the main call found an MLS (mls_number non-empty), keep the main
          // call's MLS-sourced seller agent and ignore the targeted B values.
          const hasMls = !!(mergedFields.mls_number && mergedFields.mls_number.trim() !== '');
          for (const [key, value] of Object.entries(targetedToolBlock.input)) {
            // Don't let subsection B override an MLS-sourced seller agent.
            if (hasMls && key.indexOf('seller_agent_') === 0) {
              skippedForMls.push(key);
              continue;
            }
            // Targeted call wins ONLY if it produced a non-empty value.
            // Never overwrite a main-call success with a targeted-call empty.
            if (value && value.trim() !== '') {
              mergedFields[key] = value;
              filled.push(key);
            } else {
              empty.push(key);
            }
          }
          console.log(
            'targeted call results (' + extractionStatus + '): filled [' + filled.join(', ') + '], ' +
            'still empty [' + empty.join(', ') + ']'
          );
          // If targeted call ran but returned 0 filled fields, mark as failed
          // so the status field accurately reflects the outcome.
          if (filled.length === 0) {
            extractionStatus = 'failed_all_paths';
          }
        }
      } catch (targetedErr) {
        // If the targeted call (or image fallback render) fails for any reason,
        // we still have the main call's results. Better to return partial data
        // than to fail entirely. Downgrade status so it accurately reflects the
        // outcome.
        console.error('Targeted call failed, using main call results only:', targetedErr.message);
        if (extractionStatus === 'image_fallback_sonnet' ||
            extractionStatus === 'text_trim' ||
            extractionStatus === 'vision_trim_sonnet') {
          extractionStatus = 'failed_all_paths';
        }
      }
    }

    if (Object.keys(mergedFields).length > 0) {
      // If the main call alone filled all target fields and we never needed
      // the targeted call, extractionStatus is still 'not_attempted'. Promote
      // it to 'main_call_only' so the downstream signal is meaningful.
      if (extractionStatus === 'not_attempted' && !targetedCallPromise) {
        const mainHandledTargets = TARGETED_FIELD_NAMES.every(fieldName => {
          const value = mergedFields[fieldName];
          return value && value.trim() !== '';
        });
        if (mainHandledTargets) extractionStatus = 'main_call_only';
      }
      mergedFields._extraction_status = extractionStatus;
      console.log('final extraction status: ' + extractionStatus);

      // Reshape to match the caller's existing parsing: data.content[0].text
      // is the JSON string of all fields, exactly as before.
      const reshaped = {
        ...mainData,
        content: [{ type: 'text', text: JSON.stringify(mergedFields) }]
      };
      await store.setJSON(jobId, {
        ...existing,
        status: 'complete',
        result: reshaped,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt
      });
      console.log('extract-background: job ' + jobId + ' complete (RPA path)');
      await deletePayloadSafe(payloadStore, jobId);
      return { statusCode: 200 };
    }

    // Fallback: main tool call didn't produce output — write raw main response.
    // `reason` tells the frontend WHY there's no usable data: a structurally
    // damaged PDF (re-save needed) vs. a generic no-output result. It is
    // attached BOTH at the top level and inside `result` so it reaches the
    // browser regardless of whether result.js forwards top-level fields.
    const fallbackReason = pdfStructureError ? 'corrupt_pdf' : 'no_output';
    const fallbackResult = (mainData && typeof mainData === 'object')
      ? { ...mainData, reason: fallbackReason }
      : { reason: fallbackReason };
    await store.setJSON(jobId, {
      ...existing,
      status: 'complete',
      result: fallbackResult,
      reason: fallbackReason,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt
    });
    console.log('extract-background: job ' + jobId + ' complete (fallback path — main call returned no tool output' +
      (pdfStructureError ? '; corrupt PDF structure detected' : '') + ')');
    await deletePayloadSafe(payloadStore, jobId);
    return { statusCode: 200 };

  } catch (err) {
    console.error('extract-background error: ' + err.message);
    if (jobId && store) {
      try {
        await store.setJSON(jobId, {
          ...existing,
          status: 'failed',
          error: err.message,
          failed_at: new Date().toISOString()
        });
      } catch (writeErr) {
        console.error('extract-background: also failed to write failure status: ' + writeErr.message);
      }
    }
    await deletePayloadSafe(payloadStore, jobId);
    return { statusCode: 500 };
  }
};
