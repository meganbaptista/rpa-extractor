// ── DEPENDENCIES ────────────────────────────────────────────────────────────
// pdf-parse 2.x: PDFParse class with getText() returning per-page text.
// pdf-lib: copies selected pages into a fresh PDF for the targeted call.
const { PDFDocument } = require('pdf-lib');
// pdf-parse 2.x depends on pdfjs-dist which needs DOMMatrix/Path2D/ImageData
// polyfills. pdf-parse provides its own CanvasFactory under /worker for
// environments like Netlify Functions where @napi-rs/canvas can't be
// installed. Import it and pass into every PDFParse constructor.
const { CanvasFactory } = require('pdf-parse/worker');
const { PDFParse } = require('pdf-parse');
const { canonicalAddress } = require('./lib/address');
// Targeted-call orchestration (definitions, prompt, merge, render-retry) is
// shared with extract-background.js — single source of truth, see lib/targeted-call.js.
const {
  TARGETED_FIELD_NAMES,
  targetedTool,
  buildImageFallbackContent,
  mergeTargetedFields,
  runTargetedTrimCall,
  trimStatusFor
} = require('./lib/targeted-call');
// Scrubs model-emitted placeholder sentinels ("<UNKNOWN>", "N/A", ...) back to
// empty string so a missed field reads as honestly blank, not fake-filled.
const { scrubPlaceholders } = require('./lib/sanitize');
// Per-call token ledger -> Google Sheet. Inert without USAGE_SHEET_ID, and every
// failure is swallowed inside logUsage, so it can never fail an extraction. Rows
// from here carry note 'extract-legacy': this is the OLD direct /extract endpoint,
// NOT the frontend path, so anything landing here means an external caller.
const usageLog = require('./lib/usage-log');

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

// TARGETED_IMAGE_SCALE (the hi-res render scale for the targeted call) now lives
// in lib/targeted-call.js alongside the render-retry logic that uses it.

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
    model: 'claude-sonnet-4-6',
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
  await usageLog.logUsage({ fn: 'extract-detect', model: body.model, usage: data.usage, note: 'extract-legacy/pdf' });

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

// ── HELPER: IMAGE-RENDER page detection (for garbled/broken text-layer PDFs) ──
// Some zipForm/DocuSign exports encode the CAR template font without a usable
// ToUnicode map, so the text layer extracts as control-character garbage and
// locateRpaPagesViaText can never match the markers — even though the PRINTED
// page still looks correct (only the extracted text is broken). The PDF-native
// vision pass (locateRpaPagesViaVision) can also miss on these. This locator
// renders the pages server-side at a legible scale and asks Sonnet to read the
// two page numbers off the rendered images; the visual labels ("Date Prepared:",
// "REAL ESTATE BROKERS SECTION") are intact even when the text layer is not.
//
// On success the caller still builds the reliable 2-page trim + targeted call —
// this is strictly a better-located input than the blind whole-package image
// fallback (which renders everything and asks the model to find AND extract in
// one overloaded call). Single-document assumption (renders document 0),
// matching locateRpaPagesViaVision.
async function locateRpaPagesViaImages(documents, apiKey) {
  const result = { dpDoc: -1, dpPage: -1, brokersDoc: -1, brokersPage: -1 };
  if (!documents.length) return result;
  const docIdx = 0;

  const buffer = Buffer.from(documents[docIdx].data, 'base64');
  // Scale 1.0 (vs the 0.5 used for blind extraction) renders letter pages at
  // ~612x792 — the page HEADINGS we locate by ("Date Prepared:", "REAL ESTATE
  // BROKERS SECTION") are clearly legible, while ~30 pages stay comfortably
  // under the request size limit (~10MB). We are locating pages here, not
  // reading fine print, so we don't need a higher scale.
  const renderedPages = await renderAllPagesAsImages(buffer, MAX_FALLBACK_PAGES, 1.0);
  if (!renderedPages.length) {
    console.warn('image-locate page-detection: no pages rendered');
    return result;
  }

  const locateTool = {
    name: 'locate_pages',
    description: 'Report the 1-indexed page numbers where two markers appear in the rendered document images.',
    input_schema: {
      type: 'object',
      properties: {
        date_prepared_page: {
          type: 'integer',
          description: 'The 1-indexed page number (image 1 = page 1) of the FIRST PAGE OF THE RPA: top-left shows the printed label "Date Prepared:" followed by a date, header "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS", footer "PAGE 1 OF 17". CRITICAL: this is NOT necessarily the first physical page of the package — executed packages routinely stack Buyer/Seller Counter Offers (BCO/SCO) and addenda IN FRONT of the RPA. Those pages also show a date at the top, but they say a plain "Date" (not "Date Prepared:") under a "COUNTER OFFER" or addendum heading — do NOT return a counter-offer or addendum page. Return 0 if you cannot find the RPA page 1 bearing the "Date Prepared:" label.'
        },
        brokers_section_page: {
          type: 'integer',
          description: 'The 1-indexed page number (matching the order of the images provided) whose heading reads "REAL ESTATE BROKERS SECTION", with subsections "A. Buyer\'s Brokerage Firm" and "B. Seller\'s Brokerage Firm". This is the LAST page of the RPA; footer reads "PAGE 17 OF 17" or similar. Return 0 if not found.'
        }
      },
      required: ['date_prepared_page', 'brokers_section_page']
    }
  };

  const imageBlocks = renderedPages.map((p) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: p.base64 }
  }));

  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    tools: [locateTool],
    tool_choice: { type: 'tool', name: 'locate_pages' },
    messages: [{
      role: 'user',
      content: [
        ...imageBlocks,
        { type: 'text', text: 'The images above are the pages of a California real estate purchase agreement package, in order (image 1 = page 1, image 2 = page 2, and so on). Identify two pages and return their 1-indexed numbers via the locate_pages tool:\n\n• Page A is page 1 of the RPA: top-left printed label "Date Prepared:" followed by a date; header "CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS"; paragraph 1 "OFFER"; footer "RPA REVISED 12/25 (PAGE 1 OF 17)" or similar. IMPORTANT: page 1 of the RPA is often NOT the first physical page of the package — Buyer/Seller Counter Offers and addenda are frequently stacked in front of it. Counter offers show a plain "Date" (NOT "Date Prepared:") under a "COUNTER OFFER" heading; do not mistake a counter offer or addendum for RPA page 1.\n\n• Page B is the LAST page of the RPA: heading "REAL ESTATE BROKERS SECTION"; two subsections "A. Buyer\'s Brokerage Firm" and "B. Seller\'s Brokerage Firm"; footer "RPA REVISED 12/25 (PAGE 17 OF 17)" or similar.\n\nBoth pages are present. Return 0 for a page you cannot find — do not guess.' }
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
  await usageLog.logUsage({ fn: 'extract-detect', model: body.model, usage: data.usage, note: 'extract-legacy/images' });

  if (!Array.isArray(data.content)) {
    console.warn('image-locate page-detection: unexpected response shape, no content array');
    return result;
  }
  const toolUse = data.content.find((b) => b.type === 'tool_use');
  if (!toolUse || !toolUse.input) {
    console.warn('image-locate page-detection: no tool_use block in response');
    return result;
  }

  const dp = toolUse.input.date_prepared_page;
  const br = toolUse.input.brokers_section_page;
  // Rendered images are document-0 pages 1..N in order, so the 1-indexed image
  // position maps directly onto the document page. The counter-offer geometric
  // guard is applied centrally in the handler (right after detection) so it
  // covers EVERY detector path (text/vision/image), not just this one.
  if (typeof dp === 'number' && dp > 0) { result.dpDoc = docIdx; result.dpPage = dp - 1; }
  if (typeof br === 'number' && br > 0) { result.brokersDoc = docIdx; result.brokersPage = br - 1; }
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

  let visionResult = null;
  try {
    visionResult = await locateRpaPagesViaVision(documents, apiKey);
    if (visionResult.dpDoc !== -1 && visionResult.brokersDoc !== -1) {
      console.log('page detection: vision fallback succeeded ' +
        '(date_prepared=page' + (visionResult.dpPage + 1) +
        ', brokers_section=page' + (visionResult.brokersPage + 1) + ')');
      return { located: visionResult, method: 'vision' };
    }
    console.warn(
      'page detection: vision fallback also missed ' +
      '(date_prepared_found=' + (visionResult.dpDoc !== -1) +
      ', brokers_section_found=' + (visionResult.brokersDoc !== -1) + '), ' +
      'trying image-render locator'
    );
  } catch (visionErr) {
    console.warn('page detection: vision fallback errored (' + visionErr.message + '), trying image-render locator');
  }

  // Final locator: render pages server-side and read the page numbers off the
  // images. Handles PDFs whose text layer is garbled (zipForm/DocuSign font
  // encoding) AND that the PDF-native vision pass missed. If this finds both
  // pages we still get the reliable 2-page trim + targeted call, NOT the blind
  // whole-package image fallback.
  try {
    const imageResult = await locateRpaPagesViaImages(documents, apiKey);
    if (imageResult.dpDoc !== -1 && imageResult.brokersDoc !== -1) {
      console.log('page detection: image-render locator succeeded ' +
        '(date_prepared=page' + (imageResult.dpPage + 1) +
        ', brokers_section=page' + (imageResult.brokersPage + 1) + ')');
      return { located: imageResult, method: 'image_locate' };
    }
    console.warn(
      'page detection: image-render locator also missed ' +
      '(date_prepared_found=' + (imageResult.dpDoc !== -1) +
      ', brokers_section_found=' + (imageResult.brokersDoc !== -1) + ')'
    );
    return { located: imageResult, method: 'image_locate-failed' };
  } catch (imageErr) {
    console.warn('page detection: image-render locator errored: ' + imageErr.message);
    return { located: (visionResult || textResult), method: 'image_locate-errored' };
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
async function renderAllPagesAsImages(buffer, maxPages, scale) {
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
    // Default scale 0.5 keeps the blind extraction fallback cheap; callers that
    // need legible page images (the image-render page LOCATOR below) pass a
    // higher scale so headings/footers are readable.
    const options = { scale: (typeof scale === 'number' && scale > 0) ? scale : 0.5 };
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
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: { message: 'Method Not Allowed' } }) };
  }

  try {
    const body = JSON.parse(event.body);
    const AT_TOKEN = process.env.AIRTABLE_TOKEN;
    const AT_BASE  = process.env.AIRTABLE_BASE_ID || 'appZ9ucNHFtNRNQMg';

    // ── AIRTABLE SEARCH ───────────────────────────────────────────────────────
    if (body.airtable_search) {
      if (!AT_TOKEN) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'AIRTABLE_TOKEN not set' } }) };
      }
      const { table, field, value } = body.airtable_search;
      const formula = encodeURIComponent('LOWER({' + field + '})=LOWER("' + value.replace(/"/g, '') + '")');
      const searchResp = await fetch(
        'https://api.airtable.com/v0/' + AT_BASE + '/' + encodeURIComponent(table) + '?filterByFormula=' + formula + '&maxRecords=1',
        { headers: { 'Authorization': 'Bearer ' + AT_TOKEN } }
      );
      const searchData = await searchResp.json();
      return { statusCode: 200, headers, body: JSON.stringify(searchData) };
    }

    // ── AIRTABLE CREATE ───────────────────────────────────────────────────────
    if (body.airtable_table) {
      if (!AT_TOKEN) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'AIRTABLE_TOKEN not set' } }) };
      }
      const atResp = await fetch(
        'https://api.airtable.com/v0/' + AT_BASE + '/' + encodeURIComponent(body.airtable_table),
        {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + AT_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: body.fields })
        }
      );
      const atData = await atResp.json();
      return { statusCode: 200, headers, body: JSON.stringify(atData) };
    }

    // ── CLAUDE EXTRACTION ─────────────────────────────────────────────────────
    if (!process.env.ANTHROPIC_API_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY not set' } }) };
    }

    const documents = body.documents || [];
    const content = [];

    documents.forEach(doc => {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: doc.data },
        title: doc.label
      });
    });

    // ── RLA / CUSTOM PROMPT PATH (unchanged JSON-text behavior) ───────────────
    if (body.prompt_override) {
      content.push({ type: 'text', text: body.prompt_override });

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2500,
          messages: [{ role: 'user', content }]
        })
      });

      const data = await response.json();
      await usageLog.logUsage({ fn: 'extract-rla', model: 'claude-sonnet-4-6', usage: data.usage, note: 'extract-legacy' });
      return { statusCode: 200, headers, body: JSON.stringify(data) };
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

    // Every extraction call funnels through callApi — the main call, the targeted
    // trim + its render-retry (lib/targeted-call.js gets this via `deps`), the
    // image fallback, and the Opus escalation. Logging HERE covers all of them at
    // one edit point; the tool name is what separates main from targeted, so the
    // ledger splits them with no plumbing through the call sites.
    const callApi = (msgContent, tool, model) => {
      const modelUsed = model || 'claude-sonnet-4-6';
      return fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: modelUsed,
          max_tokens: 4096,
          tools: [tool],
          tool_choice: { type: "tool", name: tool.name },
          messages: [{ role: 'user', content: msgContent }]
        })
      }).then(r => r.json()).then(async (data) => {
        await usageLog.logUsage({
          fn: tool && tool.name === 'extract_contract_fields' ? 'extract-main' : 'extract-targeted',
          model: modelUsed,
          usage: data && data.usage,
          note: 'extract-legacy'
        });
        return data;
      });
    };

    const findToolUse = (resp) => Array.isArray(resp.content)
      ? resp.content.find(b => b.type === 'tool_use')
      : null;

    // ─── TARGETED CALL DEFINITIONS ────────────────────────────────────────────
    // TARGETED_FIELD_NAMES, TARGETED_FIELDS, targetedTool, TARGETED_PROMPT,
    // buildTargetedContent, buildImageFallbackContent and the merge/render-retry
    // logic are imported from lib/targeted-call.js (shared with extract-background.js).

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

    let detection = null;
    try {
      detection = await locateRpaPagesWithFallback(documents, process.env.ANTHROPIC_API_KEY);
    } catch (detectErr) {
      console.warn('detection errored (' + detectErr.message + '), falling through to image fallback');
    }
    const located = detection ? detection.located : null;

    // ── COUNTER-OFFER GUARD (applies to whatever detector ran) ──────────────
    // The CAR RPA is a fixed 17-page form, so page 1 ("Date Prepared:") sits
    // exactly 16 pages before the brokers section ("PAGE 17 OF 17"). Executed
    // packages stack Buyer/Seller Counter Offers and addenda IN FRONT of the
    // RPA; because counters also show a date at the top, the vision/image
    // detectors can lock onto a counter-offer page as "page 1", surfacing a
    // counter date as date_rpa_prepared. The brokers section has a unique
    // heading and is located reliably, so when the date page is missing — or is
    // in the SAME document but geometrically wrong (off the 16-page offset by
    // more than a small tolerance) — derive page 1 from the brokers anchor. A
    // legitimately cross-document page 1 (RPA split across uploaded files) is
    // left untouched. If a form ever isn't exactly 17 pages the derived page
    // lands on RPA boilerplate with no "Date Prepared:" label, so the targeted
    // call returns an empty date — a safe failure, never a counter-offer date.
    if (located && located.brokersDoc !== -1 && located.brokersPage >= 0) {
      const RPA_PAGE1_TO_LAST_OFFSET = 16;
      const derivedDpPage = located.brokersPage - RPA_PAGE1_TO_LAST_OFFSET;
      if (derivedDpPage >= 0) {
        const dpFound = located.dpDoc !== -1 && located.dpPage >= 0;
        const sameDoc = located.dpDoc === located.brokersDoc;
        const offsetOk = sameDoc && dpFound &&
          Math.abs((located.brokersPage - located.dpPage) - RPA_PAGE1_TO_LAST_OFFSET) <= 2;
        if (!dpFound || (sameDoc && !offsetOk)) {
          console.warn('counter-offer guard: date page (' +
            (dpFound ? ('doc' + located.dpDoc + '/page' + (located.dpPage + 1)) : 'not found') +
            ') inconsistent with brokers page (doc' + located.brokersDoc + '/page' + (located.brokersPage + 1) +
            '); deriving RPA page 1 = page' + (derivedDpPage + 1) + ' from the brokers anchor');
          located.dpDoc = located.brokersDoc;
          located.dpPage = derivedDpPage;
        }
      }
    }

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
      try {
        [trimmedMainB64, trimmedTargetedB64] = await Promise.all([
          buildTrimmedMainPdf(documents, located).catch((err) => {
            console.warn('main trim failed (' + err.message + '), main call will use full content');
            return null;
          }),
          buildTrimmedPdf(documents, located)
        ]);
      } catch (trimErr) {
        console.warn('targeted trim failed (' + trimErr.message + '), no targeted call this run');
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
        // Set synchronously so the catch-on-reject path below can downgrade the
        // status; runTargetedTrimCall returns the final status (it may suffix
        // '_render_retry' when an all-empty PDF-block result is recovered by a
        // hi-res server-side re-render). See lib/targeted-call.js.
        extractionStatus = trimStatusFor(detection.method);
        targetedCallPromise = runTargetedTrimCall({
          trimmedTargetedB64,
          detectionMethod: detection.method,
          deps: { callApi, renderAllPagesAsImages, findToolUse }
        });
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
        const data = await callApi(buildImageFallbackContent(renderedPages), targetedTool);
        // Same { data, status } shape as runTargetedTrimCall so the await/merge
        // below is uniform across both targeted-call paths.
        return { data, status: 'image_fallback_sonnet' };
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
        const targetedResult = await targetedCallPromise;
        // Both targeted paths now resolve to { data, status }. Adopt the
        // resolved status (it may be '<status>_render_retry' when the trim call
        // recovered an all-empty PDF result via a hi-res re-render).
        extractionStatus = targetedResult.status;
        const targetedToolBlock = findToolUse(targetedResult.data);

        if (targetedToolBlock && targetedToolBlock.input) {
          // Merge subsection-A/B values over the main call (non-empty wins;
          // seller_agent_* skipped when an MLS is present). See lib/targeted-call.js.
          const { filled, empty, skippedForMls } =
            mergeTargetedFields(mergedFields, targetedToolBlock.input);
          console.log(
            'targeted call results (' + extractionStatus + '): filled [' + filled.join(', ') + '], ' +
            'still empty [' + empty.join(', ') + ']' +
            (skippedForMls.length ? ', skipped (MLS present) [' + skippedForMls.join(', ') + ']' : '')
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

    // ── OPUS ESCALATION (robustness for hard PDFs: signed / scanned / image) ──
    // Mirrors extract-background.js. When Sonnet leaves critical fields blank or the
    // server-side render fallback fails (it can't process Adobe-signed PDFs), re-run
    // the full extraction ONCE on Opus 4.8 (native PDF vision, no render dependency)
    // and fill the blanks. Only fires on weak results; clean PDFs stay on Sonnet.
    // Scrub placeholder sentinels BEFORE the missingCritical check so a field
    // the model fake-filled with "<UNKNOWN>"/"N/A"/etc. counts as missing and
    // gets a real escalation attempt (instead of silently passing as filled).
    const scrubbedPreEscalation = scrubPlaceholders(mergedFields);
    if (scrubbedPreEscalation.length) {
      console.warn('sanitize: scrubbed placeholder values before escalation check [' + scrubbedPreEscalation.join(', ') + ']');
    }
    const CRITICAL_FIELDS = ['buyer_names', 'seller_names', 'property_address', 'final_purchase_price'];
    const missingCritical = CRITICAL_FIELDS.filter((k) => !(mergedFields[k] && String(mergedFields[k]).trim() !== ''));
    const weakStatus = ['failed_all_paths', 'image_fallback_sonnet', 'vision_trim_sonnet'].includes(extractionStatus);
    if (missingCritical.length > 0 || weakStatus) {
      console.warn('extract: escalating to Opus (missingCritical=[' + missingCritical.join(', ') + '], status=' + extractionStatus + ')');
      if (extractionStatus === 'image_fallback_sonnet') {
        ['date_rpa_prepared', 'buyer_agent_name', 'buyer_agent_dre', 'buyer_agent_name_2', 'buyer_agent_dre_2',
         'buyer_agent_brokerage_name', 'buyer_agent_brokerage_dre', 'buyer_agent_address', 'buyer_agent_email', 'buyer_agent_phone']
          .forEach((f) => { mergedFields[f] = ''; });
      }
      try {
        const opusResp = await callApi(mainContent, extractionTool, 'claude-opus-4-8');
        const opusTool = findToolUse(opusResp);
        if (opusTool && opusTool.input) {
          let opusFilled = 0;
          for (const [k, v] of Object.entries(opusTool.input)) {
            if (v && String(v).trim() !== '' && !(mergedFields[k] && String(mergedFields[k]).trim() !== '')) {
              mergedFields[k] = v;
              opusFilled++;
            }
          }
          extractionStatus = 'opus_escalation';
          console.log('extract: Opus escalation filled ' + opusFilled + ' field(s)');
        } else {
          console.warn('extract: Opus escalation returned no tool_use');
        }
      } catch (opusErr) {
        console.error('extract: Opus escalation failed (keeping Sonnet result): ' + opusErr.message);
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

      // ── ANTI-FABRICATION SAFEGUARD (blind fallback path) ─────────────────
      // In the blind image_fallback path the model reads low-res whole-package
      // images and is prone to CONFABULATING a plausible-but-fake Date Prepared
      // and buyer agent (e.g. a real-format DRE that belongs to someone else —
      // exactly how "William Pinchuk / 02238896" once reached a record). A
      // confident fake is far more dangerous than a blank, so blank the fields
      // that come ONLY from the RPA pages (no MLS/profile fallback) and let
      // _extraction_status flag the contract for manual review. Seller-agent
      // fields are left alone — they can be MLS-sourced and reliable.
      if (extractionStatus === 'image_fallback_sonnet') {
        const BLIND_UNRELIABLE_FIELDS = [
          'date_rpa_prepared',
          'buyer_agent_name', 'buyer_agent_dre',
          'buyer_agent_name_2', 'buyer_agent_dre_2',
          'buyer_agent_brokerage_name', 'buyer_agent_brokerage_dre',
          'buyer_agent_address', 'buyer_agent_email', 'buyer_agent_phone'
        ];
        const blanked = [];
        for (const f of BLIND_UNRELIABLE_FIELDS) {
          if (mergedFields[f] && mergedFields[f].trim() !== '') { blanked.push(f); mergedFields[f] = ''; }
        }
        if (blanked.length) {
          console.warn('anti-fabrication: blanked blind-path values for manual review [' + blanked.join(', ') + ']');
        }
      }

      // Final placeholder scrub before the result leaves the function — catches
      // any sentinel the Opus escalation re-introduced after the pre-escalation
      // scrub. Guarantees no "<UNKNOWN>"-style value reaches the UI or Zapier.
      const scrubbedFinal = scrubPlaceholders(mergedFields);
      if (scrubbedFinal.length) {
        console.warn('sanitize: scrubbed placeholder values before store [' + scrubbedFinal.join(', ') + ']');
      }

      // Canonicalize the property address to USPS shorthand suffixes so it joins
      // cleanly with the sheet and the other functions (single source: lib/address).
      if (mergedFields.property_address) mergedFields.property_address = canonicalAddress(mergedFields.property_address);

      mergedFields._extraction_status = extractionStatus;
      console.log('final extraction status: ' + extractionStatus);

      // Reshape to match the caller's existing parsing: data.content[0].text
      // is the JSON string of all fields, exactly as before.
      const reshaped = {
        ...mainData,
        content: [{ type: 'text', text: JSON.stringify(mergedFields) }]
      };
      return { statusCode: 200, headers, body: JSON.stringify(reshaped) };
    }

    // Fallback: return raw main response if main tool call didn't produce output.
    return { statusCode: 200, headers, body: JSON.stringify(mainData) };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: { message: err.message } })
    };
  }
};
