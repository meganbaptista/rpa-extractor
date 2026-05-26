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
          model: 'claude-sonnet-4-5',
          max_tokens: 2500,
          messages: [{ role: 'user', content }]
        })
      });

      const data = await response.json();
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // ── RPA PATH: TOOL USE (structured outputs) ───────────────────────────────
    // Each field is defined as a tool parameter with its own description.
    // The model fills each field with the field's description in active context,
    // which dramatically improves accuracy on commonly-missed fields like
    // date_rpa_prepared and buyer_agent_*.

    const FIELDS = {
      // ─── PROPERTY ─────────────────────────────────────────────────────────
      property_address: {
        type: "string",
        description: "Full property address INCLUDING street, city, state, and ZIP — combined into a single string. Priority source order: (1) Property Profile Report header (e.g. '650 Harbor St #4, Venice, CA 90291-4785, Los Angeles County' → return '650 Harbor St #4, Venice, CA 90291' or include the +4 if present); (2) MLS Listing header; (3) RPA paragraph 1B as last resort — agents sometimes mistype street type, e.g. 'Drive' vs 'Terrace'. CRITICAL: when pulling from the property profile, use the FULL address from the header — NOT just the street line. The property profile header always includes city, state, and ZIP on the same line as the street; combine them. Do NOT return only '650 Harbor Street Unit 4' when the full address '650 Harbor St #4, Venice, CA 90291' is available. If a city/state/ZIP is shown elsewhere on page 1 of the property profile (e.g. in 'Tax Billing City & State'), use those to complete the address. Empty string only if no source has the address."
      },
      apn: { type: "string", description: "Assessor's Parcel Number from RPA page 1 paragraph 1B or property profile. Empty string if not found." },
      county: { type: "string", description: "County name. Proper case." },
      city: { type: "string", description: "City name. Proper case." },
      zip_code: { type: "string", description: "5-digit ZIP code." },
      year_built: { type: "string", description: "Year structure was built, from MLS or property profile." },
      property_type: {
        type: "string",
        description: "Use PROP SUB TYPE from MLS or Type from Property Profile. NEVER derive from contract form name. Valid values: SFR, Condo, Probate, Revocable Trust, Vacant Land, Mobile Home, New Construction, Commercial, Duplex, Triplex, Quadruplex."
      },

      // ─── SQUARE FOOTAGE — return ONLY numeric values, never the field label ─
      sqft_structure: {
        type: "string",
        description: "Building square footage from the Property Profile Report ONLY. Find the 'Building Sq Ft' row in the CHARACTERISTICS section on page 2 (NOT the 'MLS Sq Ft' summary box on page 1). RETURN ONLY THE VALUE — do NOT include the field label 'Building Sq Ft:'. Example: source shows 'Building Sq Ft: 2,888' → return '2,888'. EXCEPTION: if the property profile shows BOTH a tax-recorded value AND an MLS value distinctly (e.g. 'Tax: 1,666 / MLS: 6,087'), return both with their qualifying labels: 'Tax: 1,666 MLS: 6,087'. Empty string if no property profile is provided."
      },
      sqft_lot: {
        type: "string",
        description: "Lot size from the Property Profile Report ONLY. Find the 'Lot Area' row in the CHARACTERISTICS section. RETURN ONLY THE NUMERIC VALUE — do NOT include the field label 'Lot Area:'. Example: source shows 'Lot Area: 8,712' → return '8,712'. Empty string if no property profile is provided."
      },

      // ─── DATES ────────────────────────────────────────────────────────────
      date_rpa_prepared: {
        type: "string",
        description: "ISO date (YYYY-MM-DD) of the RPA. The ONLY valid source is the literal label 'Date Prepared:' (with the colon) at the top-left of page 1 of the original purchase agreement (RPA / VLPA / RIPA / CPA). Confirm you are on page 1 by checking the footer for 'RPA REVISED 12/25 (PAGE 1 OF 17)' or similar. CRITICAL — DO NOT use any of these (every one of these is a known wrong-source error): the 'Date' field at the top of a Buyer Counter Offer (BCO), the 'Date' field at the top of a Seller Counter Offer (SCO), any signature/acceptance date, paragraph 33 acceptance date, the DocuSign envelope timestamp in the document header, or the property-address-line date that appears on pages 2-17 of the RPA. The label 'Date Prepared:' appears EXACTLY ONCE in the entire document set, on RPA page 1 only. If you cannot locate the literal label 'Date Prepared:', return empty string — do NOT substitute any other date."
      },
      date_of_acceptance: { type: "string", description: "ISO date (YYYY-MM-DD) the last party signed the FINAL accepted document — that is, the latest counter offer if any exist, otherwise the original RPA acceptance in paragraph 33." },
      emd_due_date: { type: "string", description: "Earnest money deposit due date in ISO format. Calculated from RPA paragraph 3D(1) ('within 3 business days after Acceptance' by default)." },
      emd_amount: { type: "string", description: "Initial deposit dollar amount from RPA paragraph 3D(1), e.g. '39,000' or '39000.00'." },
      close_of_escrow_date: { type: "string", description: "ISO date for COE from RPA paragraph 3B (either days-after-acceptance calculated, or specific date)." },
      loan_contingency_date: { type: "string", description: "ISO date for loan contingency removal per RPA paragraph 3L(1). Empty if 'No loan contingency' is checked." },
      appraisal_contingency_date: { type: "string", description: "ISO date for appraisal contingency removal per RPA paragraph 3L(2). Empty if 'No appraisal contingency' is checked." },
      inspection_contingency_date: { type: "string", description: "ISO date for investigation/inspection contingency per RPA paragraph 3L(3)." },
      seller_disclosures_due_date: { type: "string", description: "ISO date Seller must deliver disclosures per RPA paragraph 3N(1)." },
      sprp_date: { type: "string", description: "Seller Purchase of Replacement Property contingency date if SPRP addendum attached. Empty if not applicable." },
      cop_date: { type: "string", description: "Sale of Buyer's Property contingency date if COP addendum attached. Empty if not applicable." },

      // ─── PRICE & FINANCIAL ────────────────────────────────────────────────
      final_purchase_price: { type: "string", description: "Final agreed purchase price. Use the LATEST counter offer price (BCO or SCO) if any exist; otherwise use RPA paragraph 3A. Numeric only, e.g. '1315000' or '1,315,000'." },
      buyer_agent_commission_amount: { type: "string", description: "Buyer's broker compensation from RPA paragraph 3G(3). Either percentage (e.g. '2.5%') or fixed amount (e.g. '$15,000')." },
      seller_credit_referenced: { type: "string", description: "Yes/No. 'Yes' if any Seller credit to Buyer is referenced in paragraph 3G(1) or 3G(2); 'No' otherwise." },
      is_all_cash: { type: "string", description: "Yes/No. 'Yes' if 'All Cash' box is checked in RPA paragraph 3A; 'No' if a loan amount is specified." },

      // ─── HOME WARRANTY ────────────────────────────────────────────────────
      home_warranty: { type: "string", description: "Yes/No. 'Yes' if home warranty is included per RPA paragraph 3Q(18); 'No' if 'Buyer waives home warranty plan' is checked." },
      home_warranty_who_pays: { type: "string", description: "'Buyer', 'Seller', or 'Both' per RPA paragraph 3Q(18). Empty if waived." },
      home_warranty_amount: { type: "string", description: "Dollar cap on Seller's contribution to home warranty per paragraph 3Q(18) (e.g. '800.00'). Empty if not specified or waived." },
      home_warranty_company: { type: "string", description: "Issuer/company name from paragraph 3Q(18) 'Issued by:' field. Empty if not specified." },

      // ─── BUYER ────────────────────────────────────────────────────────────
      buyer_names: { type: "string", description: "CRITICAL ANTI-SWAP RULE: The buyer is the party listed on the 'THIS IS AN OFFER FROM ___' line on RPA paragraph 1A (page 1) — the party making the offer to purchase. The buyer is NEVER the current property owner from the Property Profile. If the name you are about to return matches the Property Profile's 'Owner Name' or 'Owner Name 2' field, STOP — that name is the seller. Re-read RPA paragraph 1A and return the OFFER FROM party instead.\n\nSOURCE: The ONLY valid source is the 'THIS IS AN OFFER FROM ___' line on page 1 of the RPA (paragraph 1A). Do NOT use property profile (that's the seller), MLS, or anywhere else. PRESERVE the exact separator used in the source document — if buyers are listed with commas (e.g. 'John Smith, Jane Smith'), return them with commas. Do not change commas to ' and ' or vice versa. Mirror the source formatting exactly." },

      // ─── SELLER ───────────────────────────────────────────────────────────
      seller_names: {
        type: "string",
        description: `CRITICAL ANTI-SWAP RULE: The seller is the current property owner shown in the Property Profile's 'Owner Name' and 'Owner Name 2' fields. The seller is NEVER the party in 'THIS IS AN OFFER FROM ___' on RPA paragraph 1A — that's the buyer. If the name you are about to return matches the OFFER FROM line on the RPA, STOP — that's the buyer. Use the Property Profile owner instead.

Seller name(s) in natural First-Last order, NEVER blank. PRIORITY 1: when a Property Profile Report is provided, the 'Owner Name' and 'Owner Name 2' fields are the authoritative source — but they are in courthouse 'Last First' order and MUST be rebuilt to natural 'First Last' order. DO NOT use the 'Mail Owner Name' field even though it appears to be in the right order — it sometimes silently omits co-owners with different last names. Always rebuild from Owner Name and Owner Name 2.

REBUILD RULES:
• Single name: 'Walters Shauna' → 'Shauna Walters'. The first word is the surname; everything after is the given name(s).
• Couple sharing surname: 'Avedissian Nick & Marina' → 'Nick & Marina Avedissian'. Surname is first word; the remainder describes one or more given names joined with '&' or ','.
• With middle initial: 'Wingard Joseph A' → 'Joseph A Wingard'.
• Two Owner Name fields with same surname (e.g. Owner Name 'Wingard Joseph A' + Owner Name 2 'Wingard Susan L'): combine as 'Joseph A & Susan L Wingard'.
• Two Owner Name fields with DIFFERENT surnames (e.g. 'Avedissian Nick & Marina' + 'Derian Michael R & Rina'): rebuild each independently and join with ' & ' between them: 'Nick & Marina Avedissian & Michael R & Rina Derian'. NEVER drop a co-owner just because the surname differs.

COURTHOUSE CODES: County records sometimes append codes in parentheses like '(Te)' for trustee, '(Tr)' for trustee, '(JT)' for joint tenants, '(TC)' for tenants in common, '(Et Al)' meaning 'and others'. PRESERVE these codes in the rebuilt name in their original position relative to the person they describe. Example: 'Grinberg Benjamin (Te) & Ellen' → 'Benjamin (Te) & Ellen Grinberg'. The code stays attached to the same given name it was attached to in the source.

EDGE CASES: For names with particles like 'de la' or 'van der', or hyphenated surnames, the surname may be more than one word. Use judgment based on capitalization and common patterns — e.g. 'De La Cruz Maria' → 'Maria De La Cruz'.

PRIORITY 2 (only if no Property Profile): use MLS owner field. PRIORITY 3 (only if no profile and no MLS): use RPA paragraph 33 acceptance signatures (the actual signed/printed names, NOT the printed label like 'Owner of Record').

ENTITY SELLERS: If seller is an entity (LLC, trust, estate, corporation), copy the full entity name into seller_names. Example: seller is 'Basad LLC' → seller_names: 'Basad LLC'. Entity names do not need rebuilding since they are not in Last-First order.

PRESERVE the exact separator used in the source document for entity-vs-entity or co-owner separation — if source uses commas, use commas; if source uses '&', use '&'. Mirror the source formatting exactly. seller_names must NEVER be blank.`
      },
      seller_entity_name: { type: "string", description: "Full legal entity name if seller is a trust, LLC, estate, or corporation. Empty string if seller is an individual." },
      seller_type: { type: "string", description: "Exactly one of: Individual, Trust, LLC, Estate, Power of Attorney. Default to Individual if unclear. SIGNAL FROM PROPERTY PROFILE: county records sometimes append courthouse codes in the Owner Name field that indicate ownership form. If you see '(Tr)' or '(Te)' or 'Trustee' next to a name → seller_type is 'Trust'. If you see '(LLC)' or the name itself ends in 'LLC' → seller_type is 'LLC'. If you see 'Estate of' or '(Et Al)' alone (without a trust indicator) → consider 'Estate'. These codes from the property profile are reliable signals. If the seller name is a clear entity (e.g. 'Basad LLC', 'Smith Family Trust'), match accordingly even without explicit codes." },
      seller_signer_1: { type: "string", description: "First actual human signer on the seller side (real person, not entity name). From paragraph 33." },
      seller_signer_2: { type: "string", description: "Second human signer. Empty if only one." },
      seller_signer_3: { type: "string", description: "Third human signer. Empty if not applicable." },
      seller_signer_4: { type: "string", description: "Fourth human signer. Empty if not applicable." },
      seller_1: {
        type: "string",
        description: `First seller, split out for downstream systems that need one seller per field. ONE HUMAN OR ONE ENTITY PER SLOT.

Splitting rule for property profile sources (rebuilt from Owner Name fields):
• Single owner like 'Walters Shauna' → seller_1: 'Shauna Walters'.
• Couple sharing surname like 'Avedissian Nick & Marina' → seller_1: 'Nick Avedissian', seller_2: 'Marina Avedissian'. The '&' between two given names means TWO DISTINCT PEOPLE who happen to share a surname — they go in separate slots, each with the full surname appended.
• Owner Name + Owner Name 2 with same surname like 'Wingard Joseph A' + 'Wingard Susan L' → seller_1: 'Joseph A Wingard', seller_2: 'Susan L Wingard'.
• Two Owner Name fields with different surnames like 'Avedissian Nick & Marina' + 'Derian Michael R & Rina' → seller_1: 'Nick Avedissian', seller_2: 'Marina Avedissian', seller_3: 'Michael R Derian', seller_4: 'Rina Derian'. Up to 4 humans across all owner fields.
• Courthouse codes stay attached: 'Grinberg Benjamin (Te) & Ellen' → seller_1: 'Benjamin Grinberg (Te)', seller_2: 'Ellen Grinberg'.

ENTITIES: an entity (LLC, trust, estate, corporation) is ONE legal seller that fills exactly ONE slot regardless of how many trustees or members it has. Examples: 'Basad LLC' → seller_1: 'Basad LLC'. 'Smith Family Trust' → seller_1: 'Smith Family Trust'. The trustees who sign on behalf of the entity are captured in seller_signer_1 through seller_signer_4, NOT here.

If no Property Profile is provided, fall back to MLS or RPA paragraph 33 signatures, applying the same one-human-per-slot rule to whatever source you're using. seller_1 must NEVER be blank — at minimum the primary seller goes here.`
      },
      seller_2: { type: "string", description: "Second seller, one human or entity per slot. See seller_1 description for splitting rules. Empty string if there is only one seller." },
      seller_3: { type: "string", description: "Third seller, one human or entity per slot. See seller_1 description for splitting rules. Empty string if there are fewer than three sellers." },
      seller_4: { type: "string", description: "Fourth seller, one human or entity per slot. See seller_1 description for splitting rules. Empty string if there are fewer than four sellers." },
      trust_full_name: { type: "string", description: "Full legal trust name if seller is a trust. Empty otherwise." },
      trust_date: { type: "string", description: "Date trust was established (ISO format if known). Empty otherwise." },

      // ─── MLS ──────────────────────────────────────────────────────────────
      mls_number: { type: "string", description: "MLS Listing ID from the MLS document (e.g. 'OC25196571'). NOT the APN. Empty if no MLS provided." },
      mls_list_price: { type: "string", description: "Current list price from MLS LIST PRICE field." },
      mls_list_date: { type: "string", description: "ISO date from MLS LIST CONTRACT DATE or ON MARKET DATE." },

      // ─── BUYER AGENT — LAST PAGE OF RPA ONLY ───────────────────────────────
      buyer_agent_name: {
        type: "string",
        description: "Buyer's primary agent name. Source: ONLY the LAST PAGE of the RPA (e.g. 'PAGE 17 OF 17'), titled 'REAL ESTATE BROKERS SECTION', subsection A 'Buyer's Brokerage Firm'. The agent name is the printed name on the FIRST 'By' line under that subsection. NEVER source from: page 1 paragraph 2 (Agency Confirmation) — that section confuses brokerage DRE with agent DRE; the MLS (MLS only has seller agents); the property profile; or the BRBC (Buyer Representation Agreement is a separate document and may name a different agent than the one who actually wrote this offer). Example: line reads 'By Jack Lopez   DRE Lic. # 02150816   Date 05/03/2026' → return 'Jack Lopez'."
      },
      buyer_agent_dre: {
        type: "string",
        description: "Buyer's primary agent INDIVIDUAL DRE license number from the FIRST 'By' line in subsection A on the LAST PAGE of the RPA. This is the individual agent's DRE, NOT the brokerage's DRE (the brokerage DRE sits on a different line, next to the firm name). CRITICAL: subsection B 'Seller's Brokerage Firm' sits directly below subsection A on the same page with an identical layout. DO NOT pull this DRE from subsection B — that is the seller's agent DRE, a completely different number. The buyer agent DRE you want is on the line directly under 'A. Buyer's Brokerage Firm'. Example: 'By Jack Lopez   DRE Lic. # 02150816' → return '02150816'."
      },
      buyer_agent_name_2: {
        type: "string",
        description: "Second buyer agent name from the SECOND 'By' line in subsection A on the LAST PAGE of the RPA. Empty string if that line is blank or unsigned. CRITICAL: if the checkbox 'More than one agent from the same firm represents Buyer' is marked (X or checked) in subsection A, then there ARE two agents and you MUST populate this field — do not leave it blank when the checkbox is marked. DO NOT pull this from subsection B (Seller's Brokerage Firm)."
      },
      buyer_agent_dre_2: { type: "string", description: "Second buyer agent's DRE on the SECOND 'By' line in subsection A. Empty if no second agent. If buyer_agent_name_2 is populated, this MUST be populated too. DO NOT pull from subsection B." },
      buyer_agent_brokerage_name: { type: "string", description: "Buyer's brokerage firm name from the 'Buyer's Brokerage Firm' line in subsection A on the LAST PAGE of the RPA. CRITICAL: subsection B 'Seller's Brokerage Firm' is directly below on the same page and has its own brokerage name (the listing brokerage) — that is NOT the buyer's brokerage. The buyer's brokerage name appears on the line that begins 'A. Buyer's Brokerage Firm'. Example: 'A. Buyer's Brokerage Firm Anvil Real Estate' → return 'Anvil Real Estate'." },
      buyer_agent_brokerage_dre: { type: "string", description: "Brokerage DRE on the SAME LINE as the buyer brokerage firm name in subsection A (NOT the agent's line). DO NOT pull from subsection B (Seller's Brokerage Firm) — that is the seller's brokerage DRE, a different number. The buyer brokerage DRE is on the same line as the firm named in subsection A. Example: 'A. Buyer's Brokerage Firm Anvil Real Estate   DRE Lic. # 02014153' → return '02014153'." },
      buyer_agent_address: { type: "string", description: "Buyer agent OFFICE STREET ADDRESS from subsection A on the LAST PAGE of the RPA. The Address line sits between the 'By' lines and the Email line. Combine the Address + City + State + Zip into one string. CRITICAL: this field is a STREET ADDRESS, never a phone number — if you find yourself returning digits like '949-707-4400', that is a phone number and is wrong. The address line begins with the label 'Address' followed by a street, then 'City', 'State', 'Zip'. DO NOT pull from subsection B — that is the seller agent's office address. Example: source shows 'Address 23046 Avenida De La Carlota, Ste 600   City Laguna Hills   State CA   Zip 92653-1537' → return '23046 Avenida De La Carlota, Ste 600, Laguna Hills, CA 92653-1537'." },
      buyer_agent_email: {
        type: "string",
        description: "Buyer agent email from subsection A on the LAST PAGE of the RPA. The email line sits BETWEEN the Address line and the checkbox lines, and SHARES the line with 'Phone #'. The line reads: 'Email name@domain.com   Phone # (xxx) xxx-xxxx'. NEVER source from CCPA pages, broker compensation forms, advisories, the document footer, or any other 'Email' label outside subsection A. CRITICAL: subsection B (Seller's Brokerage Firm) on the same page also has an Email line — DO NOT use that one, that is the seller agent's email. The buyer agent email is in the upper half of the page under 'A. Buyer's Brokerage Firm'. Example: 'Email jack@century21ontarget.com' → return 'jack@century21ontarget.com'. CRITICAL: if you successfully extracted buyer_agent_phone, the email is on the SAME line — they appear together. Never return one without the other when an agent is filled in."
      },
      buyer_agent_phone: { type: "string", description: "Buyer agent phone from subsection A, on the SAME line as buyer_agent_email, after 'Phone #'. DO NOT pull from subsection B — that is the seller agent's phone. Example: '(562) 431-2011'." },

      // ─── SELLER AGENT ──────────────────────────────────────────────────────
      seller_agent_name: { type: "string", description: "Seller agent name. Priority: (1) MLS Listing Agent (LA) — combine with CoLA as 'LA Name / CoLA Name' if both present; (2) RPA page 1 paragraph 2 'Seller's Agent' line; (3) RPA last page subsection B. NEVER use property profile for seller agent (that's historical listing data and may be from a previous sale)." },
      seller_agent_dre: { type: "string", description: "Seller agent individual DRE. Combine as 'DRE1 / DRE2' if two listing agents. Same priority as seller_agent_name." },
      seller_agent_brokerage_name: { type: "string", description: "Seller's brokerage/listing office name. Priority: (1) MLS LO (Listing Office) — if a CoLO (Co-Listing Office) is also present AND it's a DIFFERENT brokerage than LO, combine as 'LO Name / CoLO Name'. If LO and CoLO are the same brokerage, just return the single name. (2) RPA fallback. Example with two different brokerages: LO='Berkshire Hathaway' and CoLO='Compass' → return 'Berkshire Hathaway / Compass'. Example with same brokerage on both: just 'Berkshire Hathaway'." },
      seller_agent_brokerage_dre: { type: "string", description: "Seller brokerage DRE. Priority: (1) MLS LO State License — if a CoLO State License is also present AND from a DIFFERENT brokerage, combine as 'LO_DRE / CoLO_DRE' matching the order used in seller_agent_brokerage_name. If LO and CoLO are the same brokerage, just return the single DRE. (2) RPA last page subsection B same-line-as-firm-name DRE. Example: '01317331 / 01991628'. NOT the agent's individual DRE." },
      seller_agent_address: { type: "string", description: "Seller agent office address." },
      seller_agent_email: { type: "string", description: "Primary listing agent email. Use LA EMAIL from MLS if available, otherwise Offers Email." },
      seller_agent_email_2: { type: "string", description: "Co-listing agent email (CoLA EMAIL from MLS). Empty if no co-listing agent." },
      seller_agent_phone: { type: "string", description: "Seller agent phone number." },

      // ─── ESCROW / TITLE / HOA ─────────────────────────────────────────────
      escrow_company: { type: "string", description: "Escrow holder/company from RPA paragraph 3Q(7) 'Escrow Holder:' field. May be 'Seller's Choice' or 'Buyer's Choice' if not yet selected." },
      escrow_officer_name: { type: "string", description: "Named escrow officer if specified. Empty if not yet assigned." },
      title_company: { type: "string", description: "Title company from RPA paragraph 3Q(8). May be 'Seller's Choice' if same as escrow." },
      hoa_fee: { type: "string", description: "Monthly HOA fee if disclosed. Empty if not applicable or not disclosed." },
      hoa_name: { type: "string", description: "HOA name if disclosed. Empty if not applicable." }
    };

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
      'buyer_agent_phone'
      // buyer_agent_name_2 and _dre_2 intentionally NOT in the trigger list —
      // they're legitimately empty when only one agent signs, so an empty
      // value here doesn't mean the main call failed.
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
      buyer_agent_phone: FIELDS.buyer_agent_phone
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

• Last page of the RPA (typically PAGE 17 OF 17) — titled "REAL ESTATE BROKERS SECTION". This page contains TWO subsections that look almost identical:

  ┌─────────────────────────────────────────────────────────┐
  │ A. Buyer's Brokerage Firm  [BUYER firm]    DRE # [...]  │  ← extract from HERE
  │    By [BUYER agent 1]                      DRE # [...]  │  ← extract from HERE
  │    By [BUYER agent 2 if any]               DRE # [...]  │  ← extract from HERE
  │    Address [BUYER office addr]  City  State  Zip        │  ← extract from HERE
  │    Email [BUYER agent email]    Phone # [BUYER phone]   │  ← extract from HERE
  │    ☐ More than one agent from the same firm...          │
  ├─────────────────────────────────────────────────────────┤
  │ B. Seller's Brokerage Firm [SELLER firm]   DRE # [...]  │  ← DO NOT use this
  │    By [SELLER agent 1]                     DRE # [...]  │  ← DO NOT use this
  │    Address [SELLER office addr] City State Zip          │  ← DO NOT use this
  │    Email [SELLER email]         Phone # [SELLER phone]  │  ← DO NOT use this
  └─────────────────────────────────────────────────────────┘

EVERY buyer_agent_* field MUST come from subsection A only. Subsection B is the seller's information and is a trap — it has the same field labels (DRE, Address, Email, Phone) but the values are completely different people. A common failure mode is correctly identifying subsection A for the agent name, then drifting into subsection B for the remaining fields. Do not do this. Re-anchor on "A. Buyer's Brokerage Firm" before each field.

The buyer_agent_address field is a STREET ADDRESS like "23046 Avenida De La Carlota, Ste 600, Laguna Hills, CA 92653" — never a phone number. If you are about to return digits like "949-707-4400" for an address, stop and re-read the Address line in subsection A.

ANTI-HALLUCINATION RULES — read carefully:

When you CAN clearly read the value on the page (text is sharp, label is visible, value is filled in), return it. The RPA is always present and these fields are usually filled in, so the common case is non-empty.

But when you CANNOT clearly read a value — page is blurry, OCR text is garbled, label is visible but the line after it is blank or unreadable, or you genuinely cannot find the field — return an EMPTY STRING. An honest blank is always better than a guess.

Specifically, NEVER do any of the following:

• NEVER return "2025" or any year that comes from the form's copyright footer "© 2025 California Association of REALTORS®". The copyright year is NOT the Date Prepared.
• NEVER return "<UNKNOWN>", "N/A", "TBD", "see addendum", or any placeholder string for a buyer agent field. If you can't find buyer agent info, return empty string for that field.
• NEVER use a date from elsewhere in the package (counter offer date, signature date, DocuSign timestamp, property profile sale date, MLS list date) as a substitute for date_rpa_prepared.
• NEVER infer buyer agent details from the MLS or property profile — those documents only contain seller agent info.
• NEVER copy values from subsection B (Seller's Brokerage Firm) when subsection A is unreadable. If A is illegible, return empty — do not silently fall back to B.

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
          for (const [key, value] of Object.entries(targetedToolBlock.input)) {
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
