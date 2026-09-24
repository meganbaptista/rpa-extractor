// netlify/functions/lib/page-strips.js
//
// ============================================================================
// WHERE ONE DOCUMENT ENDS AND THE NEXT BEGINS, read off the edges of the page.
// ============================================================================
// The splitter used to hand a whole packet to one model call and ask for the
// complete split map plus a signature audit for every form. On a 65-page
// image-only delivery (1333 S Beverly Glen, 2026-09-23) that returned a
// plausible, INCOMPLETE answer: 28 forms covering 73 of 110 pages, with the
// cooperating broker's addendum and the buyer agent's AVID silently absent. No
// error, no refusal - the model just stopped accounting for pages.
//
// Megan's objection to reporting that better: "it doesn't save any time... I
// have to go through an email and then drop into the google drive to see what
// was missed." Right. So the fix is not a louder failure, it is an
// identification step that does not lose pages.
//
// THE OBSERVATION THIS IS BUILT ON. A page announces what it belongs to at its
// EDGES, and does so in print that survives having no text layer:
//
//   C.A.R. forms footer themselves - "AVID REVISED 6/24 (AVID PAGE 1 OF 3)" -
//     giving a code AND a deterministic span.
//   Brokerage forms head themselves - a logo plus the document's title on its
//     FIRST page only, so a page with the brand and no title is a
//     continuation. Verified identical on Christie's/AKG and Coldwell Banker.
//   Branded forms also carry a counter in the footer ("3 of 3", "Page 3 of 3")
//     which lands on the LAST page - so the header says where a document
//     starts, the footer says where it ends, and the two CHECK each other.
//
// Reading a label is a different task from comprehending a package, and it is
// the kind of task that does not degrade over 65 pages. The strips are also
// tiny, so a page costs a fraction of a full render.
//
// WHAT THIS MODULE DOES NOT DO: the signature audit. That genuinely needs the
// whole page, and it runs per document, on that document's own pages, once
// this has said where they are.
// ============================================================================

const { PDFParse } = require('pdf-parse');
const { CanvasFactory } = require('pdf-parse/worker');
const { loadImage, createCanvas } = require('@napi-rs/canvas');
const { callClaude } = require('./claude');
const { mapLimit } = require('./map-limit');

/**
 * Fraction of the page height taken as the header and footer strips.
 *
 * Measured, not guessed, and BOTH were wrong on the first try:
 *
 *   FOOT at 0.10 sliced through the top line of page 47 of the Beverly Glen
 *     packet - "AVID REVISED 6/24 (PAGE 1 OF 3)", the line that states the
 *     document's own length. 0.14 takes the whole C.A.R. footer block plus the
 *     brokerage office line beneath it.
 *   HEAD at 0.16 was the expensive one. Christie's sets its logo at the very
 *     top, leaves whitespace, and puts the TITLE about a fifth of the way down
 *     - measured at 21% on "Environmental Hazards Advisory" and 18% on
 *     "Receipt for Links to Booklets". Both fell below a 16% strip, so both
 *     read as untitled continuations and got absorbed into the document above
 *     them. Five documents were reported as three. That is the worst failure
 *     this module can produce: a merged document is one form filed and another
 *     that is never filed and never chased.
 *
 * So both are deliberately generous. A strip that misses its label costs a
 * whole document; a strip carrying an extra line or two of body text costs a
 * few tokens and is handled by telling the model what a title looks like.
 */
const HEAD_FRACTION = 0.30;
const FOOT_FRACTION = 0.14;

/**
 * Render scale for the strips.
 *
 * A footer is legible at 96dpi - proven by reading "AGENT VISUAL INSPECTION
 * DISCLOSURE (AVID PAGE 1 OF 3)" off page 47 of an image-only packet. 1.35x
 * the 72dpi base is ~97dpi and keeps a full-width strip well under the API's
 * 1568px long edge, so it reaches the model un-downscaled.
 */
const STRIP_SCALE = 1.35;

/**
 * Pages per model call.
 *
 * Two images per page, so ten pages is twenty images - the same working set
 * the buyer-side audit settled on (QA_MAX_BATCH_IMAGES). Small enough that
 * every strip gets real attention, which is the entire point.
 */
const STRIP_PAGES_PER_CALL = 10;

/**
 * Pages rendered per parser instance.
 *
 * Lifted from the buyer-side audit's RENDER_CHUNK_PAGES, which was tuned
 * against measured memory: one call for a whole document held its canvases and
 * the Lambda died with no stack, just `Duration:`. Chunks of 4 landed ~350MB
 * under the ceiling. Strips are far smaller than full pages, but pdfjs's own
 * working set is the lever, not the output size - so keep the chunking.
 */
const RENDER_CHUNK_PAGES = 4;

const MODEL = 'claude-opus-4-8';

/**
 * How many strip batches are read at once.
 *
 * The batches are independent, so this is pure wall clock. Kept modest because
 * the rendering that feeds them is the memory-hungry part and there is no
 * reason to race the API.
 */
const STRIP_CONCURRENCY = 3;

const STRIP_PROMPT =
  'Each image below is a narrow STRIP cut from the top or the bottom of one page of a California ' +
  'real estate disclosure package. You are transcribing labels, NOT interpreting documents. For ' +
  'every page number you are shown, report exactly what is PRINTED on its strips.\n\n' +
  'Return ONLY this JSON, no prose:\n' +
  '{"pages":[{"page":1,"title":"","brand":"","car_code":"","car_name":"","page_m":0,"page_n":0,' +
  '"counter":"","footer_name":"","envelope_id":""}]}\n\n' +
  'One object per page you were shown, in page order. Every field is a transcription or empty:\n' +
  '  "title"    - the document TITLE printed in the HEADER strip, verbatim, e.g. "AFFILIATED BUSINESS ' +
  'ARRANGEMENT DISCLOSURE STATEMENT" or "MOLD DISCLOSURE AND AGREEMENT". A title is centred, bold or ' +
  'capitalised, and names the document. Use "" when the header carries no title - that is the NORMAL ' +
  'case for a continuation page and it is important information, so do NOT carry a title forward from ' +
  'an earlier page and do NOT invent one from body text.\n' +
  '  "brand"    - the brokerage named or logotyped in the HEADER strip, e.g. "Coldwell Banker Realty", ' +
  '"Christie\'s International Real Estate", "AKG | Christie\'s", "Compass". "" if none.\n' +
  '  "car_code" - the C.A.R. form code printed in the FOOTER, e.g. "AVID", "TDS", "SPQ", "SBSA". C.A.R. ' +
  'footers read like "AVID REVISED 6/24 (AVID PAGE 1 OF 3)". "" if the footer has no C.A.R. code.\n' +
  '  "car_name" - the form name printed beside it in the footer, e.g. "AGENT VISUAL INSPECTION ' +
  'DISCLOSURE". "" if absent.\n' +
  '  "page_m" / "page_n" - the numbers from a "PAGE m OF n" in the footer, as integers. 0 and 0 when ' +
  'the footer carries no such counter.\n' +
  '  "counter"  - any OTHER page counter printed in the footer, verbatim, e.g. "3 of 3", "Page 2 of 3", ' +
  '"2". Brokerage forms use these and they usually sit on the LAST page of a document. "" if none.\n' +
  '  "envelope_id" - the signing-service envelope identifier stamped along the very top edge, ' +
  'verbatim, e.g. "3BE121DE-DBE9-8813-81D5-A1DC731E92AF" from "Docusign Envelope ID: 3BE121DE-...". ' +
  'Give the identifier only, not the "Docusign Envelope ID:" label. "" if the page carries none.\n' +
  '  "footer_name" - a DOCUMENT NAME printed in the footer, with its revision if one is shown, verbatim, ' +
  'e.g. "Environmental Hazards Advisory, Acknowledgement, and Agreement  Revised 11/19" or "Rev. 6/2022" ' +
  'or "(c)2015 Coldwell Banker GLA Addendum to Real Estate Purchase Agreement rev 4/17". Many brokerage ' +
  'forms name themselves down there even when the header does not. "" if the footer names no document.\n\n' +
  'RULES THAT MATTER:\n' +
  '  A TITLE IS NOT ALWAYS AT THE VERY TOP. A brokerage form often prints its logo at the top edge, ' +
  'leaves white space, and sets the title a fifth of the way down the page - so the title may sit near ' +
  'the MIDDLE of the header strip you are shown, sometimes under a horizontal rule, with a ' +
  '"Property Address ____" line beneath it. Report it. What distinguishes a title from body text: it is ' +
  'centred or bold, it is a NOUN PHRASE naming a kind of document (advisory, disclosure, agreement, ' +
  'receipt, addendum, notice), and it is not a sentence.\n' +
  '  A SECTION HEADING IS NOT A TITLE. A single word or short phrase set above signature lines part ' +
  'way down the page - "ACKNOWLEDGMENT", "RECEIPT", "AGREEMENT", "CERTIFICATION" - is a section of a ' +
  'document that began on an earlier page, not a new document. A real title sits ABOVE the body text ' +
  'with the brand or a rule near it, not below a table or a paragraph. If a heading has body text or a ' +
  'table ABOVE it on the same strip, it is a section heading: leave "title" empty.\n' +
  '  Transcribe, never infer. If a strip is blank, every field for that page is "" or 0.\n' +
  '  Ignore the print-service line ("Produced with Lone Wolf Transactions", "zipForm", "zipLogix", a ' +
  'URL) and ignore an office address, a phone number or "Equal Housing Opportunity" - none of those is ' +
  'a title, a brand or a counter.\n' +
  '  A brokerage office line in the footer ("Coldwell Banker Res. Brokerage - Laguna Beach, 31582 S. ' +
  'Coast Highway") is NOT the brand field; brand comes from the HEADER only.\n' +
  '  Report one object for EVERY page number shown, even a completely blank one. A page you skip is a ' +
  'page that gets lost, which is the failure this exists to prevent.';

/** Render header+footer strips for the given 1-indexed pages. */
async function renderStrips(buffer, pageNumbers) {
  const out = [];
  for (let i = 0; i < pageNumbers.length; i += RENDER_CHUNK_PAGES) {
    const chunk = pageNumbers.slice(i, i + RENDER_CHUNK_PAGES);
    const parser = new PDFParse({ data: new Uint8Array(buffer), CanvasFactory });
    try {
      const res = await parser.getScreenshot({ scale: STRIP_SCALE, partial: chunk });
      for (const p of res.pages || []) {
        if (!p.data) continue;
        out.push({ pageNumber: p.pageNumber, png: Buffer.from(p.data) });
      }
    } finally {
      await parser.destroy();   // free the canvases before the next chunk
    }
  }
  return out;
}

/**
 * Crop a rendered page PNG to its top and bottom strips.
 *
 * Done after a whole-page render rather than by rendering a clipped region:
 * pdf-parse's getScreenshot renders whole pages, and the render is not the
 * expensive part - the model call is. Cropping here keeps the renderer to one
 * code path.
 *
 * @napi-rs/canvas is pdf-parse's own rasteriser (its CanvasFactory is built on
 * it), so this adds no new native dependency; it is named in package.json
 * anyway rather than relied on transitively.
 */
async function cropStrips(png) {
  const img = await loadImage(png);
  const { width, height } = img;
  const head = Math.max(1, Math.round(height * HEAD_FRACTION));
  const foot = Math.max(1, Math.round(height * FOOT_FRACTION));
  const cut = (top, h) => {
    const canvas = createCanvas(width, h);
    // drawImage with a source rect: copy just that band, 1:1, no rescale.
    canvas.getContext('2d').drawImage(img, 0, top, width, h, 0, 0, width, h);
    return canvas.toBuffer('image/png');
  };
  return [cut(0, head), cut(height - foot, foot)];
}

/** Ask the model to transcribe one batch of strips. */
async function readStripBatch(rows, label) {
  const content = [];
  for (const r of rows) {
    content.push({ type: 'text', text: `Page ${r.pageNumber} HEADER:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: r.head.toString('base64') } });
    content.push({ type: 'text', text: `Page ${r.pageNumber} FOOTER:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: r.foot.toString('base64') } });
  }
  content.push({ type: 'text', text: STRIP_PROMPT });
  const raw = await callClaude({
    fn: 'disclosure-strips',
    model: MODEL,
    content,
    maxTokens: 8000,
    effort: 'low',          // transcription, not reasoning
    note: label,
  });
  const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  return Array.isArray(parsed.pages) ? parsed.pages : [];
}

/**
 * Read the strips of the given pages. Returns one row per page, in page order.
 *
 * Takes an explicit page list rather than a count so the same function serves
 * the full first pass and the narrow re-read of whatever came back unclaimed.
 */
async function readStripsFor(buffer, pageNumbers, name = '') {
  const pages = [...pageNumbers].sort((a, b) => a - b);
  const rendered = await renderStrips(buffer, pages);
  const cropped = [];
  for (const r of rendered) {
    const [head, foot] = await cropStrips(r.png);
    cropped.push({ pageNumber: r.pageNumber, head, foot });
  }
  cropped.sort((a, b) => a.pageNumber - b.pageNumber);

  const batches = [];
  for (let i = 0; i < cropped.length; i += STRIP_PAGES_PER_CALL) {
    batches.push(cropped.slice(i, i + STRIP_PAGES_PER_CALL));
  }
  const read = await mapLimit(batches, STRIP_CONCURRENCY, (batch) => {
    const label = `${name} pp${batch[0].pageNumber}-${batch[batch.length - 1].pageNumber}`;
    return readStripBatch(batch, label).catch((err) => {
      // A failed batch must not fail the packet, and must not look clean
      // either: its pages come back marked `unread`, so they are boundary-less
      // and land in a document whose notes say the labels were never read.
      console.warn(`[page-strips] ${label} could not be read: ${err.message}`);
      return [];
    });
  });

  const rows = [];
  batches.forEach((batch, b) => {
    const byPage = new Map(read[b].map((g) => [parseInt(g.page, 10), g]));
    for (const p of batch) {
      const g = byPage.get(p.pageNumber) || {};
      rows.push({
        page: p.pageNumber,
        title: String(g.title || '').trim(),
        brand: String(g.brand || '').trim(),
        carCode: String(g.car_code || '').trim().toUpperCase(),
        carName: String(g.car_name || '').trim(),
        m: parseInt(g.page_m, 10) || 0,
        n: parseInt(g.page_n, 10) || 0,
        counter: String(g.counter || '').trim(),
        footerName: String(g.footer_name || '').trim(),
        envelopeId: String(g.envelope_id || '').trim(),
        /** True when the batch came back without this page at all. */
        unread: !byPage.has(p.pageNumber),
      });
    }
  });
  return rows;
}

/** Read every page of the document. */
function readAllStrips(buffer, pageCount, name = '') {
  return readStripsFor(buffer, Array.from({ length: pageCount }, (_, i) => i + 1), name);
}

/** No real disclosure packet has a document this long; past it, it is not a
 *  page counter. */
const MAX_PLAUSIBLE_PAGES = 200;

/**
 * "3 of 3", "Page 2 of 3", "Page 1/3", "2" -> { m, n } as far as it is stated.
 *
 * The slash form is here because page 19 of the Beverly Glen packet prints
 * "Page 1/3" and nothing else, so without it a three-page report states its
 * own length and is not heard. But the slash form REQUIRES the word "page",
 * and every reading is sanity-checked, because "Rev. 6/2022" otherwise parses
 * as page 6 of 2022 - and a document that claims 2022 pages would swallow
 * every page after it, since a declared length claims the pages that follow.
 * The same revision-stamp trap bit parseSignedDate in the intake check; a
 * number beside a slash is not a counter just because it could be one.
 */
function parseCounter(text) {
  const t = String(text || '');
  const sane = (m, n) => (m >= 1 && n >= 1 && m <= n && n <= MAX_PLAUSIBLE_PAGES
    ? { m, n } : null);

  const of = t.match(/(\d+)\s*of\s*(\d+)/i);
  if (of) {
    const hit = sane(parseInt(of[1], 10), parseInt(of[2], 10));
    if (hit) return hit;
  }
  const slash = t.match(/\bpage\s*(\d+)\s*\/\s*(\d+)/i);
  if (slash) {
    const hit = sane(parseInt(slash[1], 10), parseInt(slash[2], 10));
    if (hit) return hit;
  }
  const one = t.match(/^\s*(?:page\s*)?(\d+)\s*$/i);
  if (one) {
    const m = parseInt(one[1], 10);
    if (m >= 1 && m <= MAX_PLAUSIBLE_PAGES) return { m, n: 0 };
  }
  return { m: 0, n: 0 };
}

/**
 * Do two footer names name different documents?
 *
 * Deliberately conservative, because this rule SPLITS, and a false split files
 * half a form. Three things get stripped before the comparison, each because a
 * real packet produced a false split without it:
 *
 *   THE PAGE COUNTER. This was the big one. A footer names the document AND
 *     its own page, so consecutive pages of one document carry different
 *     names: "FAIR HOUSING AND DISCRIMINATION ADVISORY (FHDA PAGE 1 OF 2)"
 *     against "... (FHDA PAGE 2 OF 2)", and Christie's local-area disclosure
 *     running "... (Rev. - February 2021) page 1" through "page 5". Left in,
 *     these split one 5-page disclosure into five fragments.
 *   THE REVISION. A bare revision names no document, so it can only confirm a
 *     name, never contradict one.
 *   PUBLISHER BOILERPLATE. "Official C.A.R. Publication", "California
 *     Association of Realtors". Page 25 of the Beverly Glen packet carries
 *     "Revised 09/10 Official C.A.R. Publication 09/10" and nothing else,
 *     which is not a document name and split the NHD statement in two.
 *
 * Whatever survives all that is a name or it is nothing.
 */
function footerDocName(text) {
  const out = String(text || '')
    // page counters, in every shape seen: "(FHDA PAGE 1 OF 2)", "page 3",
    // "Page 2 of 3", "1/3"
    .replace(/\(([^()]*\bpage\s+\d+\s+of\s+\d+[^()]*)\)/gi, ' ')
    .replace(/\bpage\s*\d+\s*(of|\/)\s*\d+\b/gi, ' ')
    .replace(/\bpage\s*\d+\b/gi, ' ')
    .replace(/\b\d+\s*of\s*\d+\b/gi, ' ')
    // revisions and copyright years
    .replace(/\(c\)\s*\d{4}|\u00a9\s*\d{4}/gi, ' ')
    .replace(/\b(rev|revised|revision)\b[.:]?\s*[-\s]*[a-z]*\s*[\d/\-]*/gi, ' ')
    // publisher boilerplate, which names a publisher and not a document
    .replace(/\bofficial\s+c\.?\s*a\.?\s*r\.?\s*publication\b/gi, ' ')
    .replace(/\bcalifornia\s+association\s+of\s+realtors\b/gi, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
  // If no WORD survived, this footer names no document. Page 25 of the Beverly
  // Glen packet reduces to "09 10" - the leftover date from "Revised 09/10
  // Official C.A.R. Publication 09/10" - and a pair of numbers is not a name,
  // so returning it split the NHD statement in two. Returning '' here keeps
  // the function honest about what it found rather than leaving every caller
  // to remember the check.
  return namesADocument(out) ? out : '';
}

/**
 * Is what survived the stripping actually WORDS?
 *
 * Requiring one word of three or more letters is the cheapest honest test of
 * "is this a name at all", and it is what stops a leftover date from posing
 * as a document name.
 */
function namesADocument(normalised) {
  return /[a-z]{3,}/.test(normalised);
}

/**
 * Were these two pages stamped by different signing sessions?
 *
 * Compared on the LEADING BLOCK only. The identifier is long hex and this rule
 * splits, so a single mis-transcribed character in the tail would manufacture
 * a boundary; the first block is enough to distinguish two real envelopes and
 * short enough to be read reliably off a strip. Anything that does not look
 * like an identifier at all is ignored rather than trusted.
 */
function envelopeChanged(prev, next) {
  const key = (t) => String(t || '').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8);
  const a = key(prev);
  const b = key(next);
  if (a.length < 8 || b.length < 8) return false;
  return a !== b;
}

/**
 * Does this page print evidence that it CONTINUES the current document?
 *
 * The strongest signal in the whole packet, and it outranks a header title.
 * A C.A.R. footer reading "DIA PAGE 3 OF 3" on the third page of a document
 * already identified as the DIA is not evidence of a new form; it is the form
 * numbering its own page. So is a branded footer's plain counter.
 *
 * THIS IS HERE BECAUSE 834 VICTORIA LN FILED TWO FORMS IN TWO PIECES EACH.
 * The DIA declared 3 pages; its page 3 also carries the words "EXEMPT SELLER
 * DISCLOSURE" in the top third, and that read as a title and started a new
 * document - so the DIA filed as `DIA - ... - FX.pdf` (pages 1,2) and
 * `DIA - ... - FX (2).pdf` (page 3). The SBSA did the same on "TABLE OF
 * CONTENTS", filing pages 8 and 9-22 separately and labelling the one-page
 * half NeedReview. Both halves of both forms named the same form, which is
 * what a split form looks like from the outside.
 *
 * Widening the header strip to 30% is what exposed this: it was needed to
 * catch Christie's low titles, and it necessarily also catches headings that
 * sit a fifth of the way down a continuation page. A title read off a strip is
 * inference; a page number printed beside the form's own code is a statement.
 */
function continuesDocument(current, r) {
  if (!current) return false;
  const expected = current.pages.length + 1;
  // Its own C.A.R. code, numbered as the next page of this document.
  if (r.carCode && current.carCode && r.carCode === current.carCode) {
    const ctr = parseCounter(r.counter);
    const m = r.m || ctr.m;
    if (m === expected) return true;
  }
  // A branded form's counter doing the same, where neither prints a code.
  if (!r.carCode && !current.carCode) {
    const ctr = parseCounter(r.counter);
    if (ctr.m === expected && ctr.m > 1) return true;
  }
  return false;
}

/**
 * Do two footer names positively agree that this is the SAME document?
 *
 * Distinct from `!footerNameChanged(...)`, which is merely "nothing
 * contradicts" and is true whenever either footer names nothing at all. This
 * asks for positive agreement, because it is used to OVERRULE a header title,
 * and overruling on the strength of two blank footers would merge documents.
 */
function footerNamesAgree(prev, next) {
  const a = footerDocName(prev);
  const b = footerDocName(next);
  return namesADocument(a) && namesADocument(b) && !footerNameChanged(prev, next);
}

function footerNameChanged(prev, next) {
  const a = footerDocName(prev);
  const b = footerDocName(next);
  if (!namesADocument(a) || !namesADocument(b)) return false;  // nothing to contradict
  if (a === b) return false;
  // One containing the other is the same document named at two lengths.
  return !a.includes(b) && !b.includes(a);
}

/**
 * Turn per-page strip readings into documents with page spans.
 *
 * THE BOUNDARY RULES, in order of authority:
 *   1. ANY footer counter reading page 1 OF n starts a document n pages long.
 *      That is the strongest signal available: printed, explicit, and it
 *      states its own length. It is not restricted to C.A.R. forms - a
 *      property report printing "Page 1/3" is making the same statement, and
 *      requiring a C.A.R. code alongside it cost the boundary at page 19 of
 *      the Beverly Glen packet, where a vendor report with no title and no
 *      code got absorbed into the disclosure above it.
 *   2. A NEW header title starts a document. Its brand carries forward onto
 *      the following untitled pages, which is how a branded packet marks its
 *      own continuations.
 *   3. A change of the DOCUMENT NAME PRINTED IN THE FOOTER starts a document,
 *      when BOTH the current document and the new page name one and the names
 *      differ. Many brokerage forms name themselves in the footer even where
 *      the header carries only a logo, so this is a boundary signal that does
 *      not depend on the header - and the header is the half that failed on
 *      Christie's. It deliberately does NOT fire when the current document has
 *      no footer name yet: Coldwell Banker prints its name on the LAST page of
 *      a span, so "a name appeared where there was none" is the normal middle
 *      of a document, not a boundary. In that case the name is adopted.
 *   4. A CHANGE OF SIGNING ENVELOPE starts a document. Two pages stamped with
 *      different envelope IDs were signed in different sessions, so they
 *      cannot be one document. The reverse does not hold - one envelope
 *      routinely covers a whole packet - so this rule can only SPLIT, never
 *      merge. It came from the audit pass disputing the page 24-25 span on the
 *      Beverly Glen packet: "Page 1 (envelope BF4376FE) is the SNAPNHD
 *      Natural Hazard Disclosure Statement ... Page 2 (different envelope
 *      3BE121DE) is a separate booklet receipt". It was right, the strips had
 *      merged them, and the banner saying so was being deliberately ignored.
 *   5. A change of C.A.R. code starts a document even without a PAGE 1.
 *
 * A DECLARED LENGTH OUTRANKS THE ABSENCE OF AGREEMENT, NOT POSITIVE
 * DISAGREEMENT. When a document has printed "PAGE 1 OF n" it has told us it
 * owns the next n-1 pages, so a bare code change or an unnamed page inside
 * that span does not break it - Beverly Glen page 12, "FHDA PAGE 2 OF 2",
 * started a second one-page FHDA for exactly that reason. But a declaration
 * describes the FORM, not the DELIVERY, and the two differ constantly: page 19
 * of that same packet is page 1 of a 3-page property report whose other two
 * pages were never sent. So a page that positively names a DIFFERENT document
 * in its footer, or carries its own title, does break the span - both halves
 * then get a note saying the signals disagreed. Only silence is overruled.
 *
 * SPANS ARE CHECKED, NOT TRUSTED. A footer counter landing on what the header
 * said was the last page agrees; a disagreement is recorded on the document
 * rather than silently resolved, because a wrong span files half a form.
 */
function documentsFromStrips(rows) {
  const docs = [];
  const ordered = [...rows].sort((a, b) => a.page - b.page);
  const byPage = new Map(ordered.map((r) => [r.page, r]));
  let current = null;

  const start = (r, why) => {
    current = {
      title: r.title || r.carName || '',
      brand: r.brand || '',
      carCode: r.carCode || '',
      footerName: r.footerName || '',
      envelopeId: r.envelopeId || '',
      pages: [r.page],
      declaredLength: r.n || 0,
      startedBy: why,
      notes: [],
    };
    docs.push(current);
  };

  /** Is the current document still inside a length it printed for itself? */
  const insideDeclaredSpan = () =>
    !!current && current.declaredLength > 0 && current.pages.length < current.declaredLength;

  for (const r of ordered) {
    const p = r.page;
    // "page 1 of n" from either source: the C.A.R. footer's own m/n, or a
    // branded form's trailing counter.
    const ctr = parseCounter(r.counter);
    const firstOf = (r.m === 1 && r.n > 1) ? r.n : ((ctr.m === 1 && ctr.n > 1) ? ctr.n : 0);
    if (firstOf && !insideDeclaredSpan() && !continuesDocument(current, r)) {
      start({ ...r, n: firstOf }, r.carCode ? 'car-page-1' : 'counter-page-1');
      continue;
    }
    // A single-page C.A.R. form states "PAGE 1 OF 1", which declares no span
    // but is still unambiguously a start.
    if (r.carCode && r.m === 1 && !insideDeclaredSpan()) { start(r, 'car-page-1'); continue; }
    // A SECTION HEADING IS NOT A DOCUMENT TITLE. Page 43 of the Beverly Glen
    // packet sets "ACKNOWLEDGMENT" a quarter of the way down, above the
    // signature lines, continuing the affiliated-business disclosure that
    // began on page 42 - and both pages print the same document name in the
    // footer. The footer is explicit about identity where a bare heading is
    // not, so positive footer agreement overrules the title. (This case only
    // appeared once the header strip was widened to 30% to catch Christie's
    // low titles: the wider strip sees more real titles AND more headings.)
    // A page that numbers itself as this document's next page continues it,
    // whatever the header strip picked up. See continuesDocument().
    if (r.title && continuesDocument(current, r)) {
      current.pages.push(p);
      if (!current.footerName && r.footerName) current.footerName = r.footerName;
      continue;
    }
    if (r.title && current && footerNamesAgree(current.footerName, r.footerName)) {
      current.pages.push(p);
      continue;
    }
    if (r.title) {
      const disputed = insideDeclaredSpan() ? current : null;
      start(r, 'header-title');
      if (disputed) {
        const who = disputed.carCode || disputed.title || 'the document above';
        // Worded from each document's own point of view. One note for both
        // halves read as if the SECOND document were the short one, which on
        // 834 Victoria Ln put "DIA declared 3 pages and only got 1" on the
        // ESD that followed it.
        disputed.notes.push(`a titled page starts at page ${p}, but this document declared `
          + `${disputed.declaredLength} pages and only got ${disputed.pages.length}`);
        current.notes.push(`starts inside ${who}'s declared span of ${disputed.declaredLength} page(s)`);
      }
      continue;
    }
    // Not gated on insideDeclaredSpan: footerNameChanged already requires BOTH
    // sides to name a document, so reaching here is positive disagreement.
    if (r.footerName && current && footerNameChanged(current.footerName, r.footerName)) {
      const disputed = insideDeclaredSpan() ? current : null;
      start(r, 'footer-name-change');
      if (disputed) {
        const note = `its footer names a different document, but ${disputed.carCode || 'the document above'} `
          + `declared ${disputed.declaredLength} pages and only got ${disputed.pages.length}`;
        disputed.notes.push(note);
        current.notes.push(note);
      }
      continue;
    }
    if (r.envelopeId && current && current.envelopeId && !insideDeclaredSpan()
        && envelopeChanged(current.envelopeId, r.envelopeId)) {
      start(r, 'envelope-change'); continue;
    }
    if (r.carCode && current && !insideDeclaredSpan() && r.carCode !== current.carCode) {
      start(r, 'car-code-change'); continue;
    }
    if (!current) { start(r, 'first-page'); continue; }

    current.pages.push(p);
    // Fill in a code or brand learned from a later page of the same document.
    if (!current.carCode && r.carCode) current.carCode = r.carCode;
    if (!current.brand && r.brand) current.brand = r.brand;
    if (!current.footerName && r.footerName) current.footerName = r.footerName;
    if (!current.envelopeId && r.envelopeId) current.envelopeId = r.envelopeId;
    if (!current.declaredLength && r.n) current.declaredLength = r.n;
  }

  /**
   * Reconcile each span against whatever counter the document printed.
   *
   * Two independent checks, because branded and C.A.R. forms state their
   * length differently and both shapes show up in one packet:
   *   LENGTH - "PAGE 1 OF 3" or a trailing "3 of 3" gives n, which must equal
   *     the span. Verified on the Coldwell Banker packet: "3 of 3" on page 3
   *     confirms the 1-3 span the header boundary proposed.
   *   POSITION - the last page's own m must equal the span length. This is
   *     the check that catches a MISSED boundary, where n never appears: a
   *     bare "2" on the final page of a span of five says three pages in
   *     between belong to something else.
   */
  for (const d of docs) {
    const last = byPage.get(d.pages[d.pages.length - 1]) || {};
    const counter = parseCounter(last.counter);
    const declared = d.declaredLength || counter.n || 0;
    if (declared && declared !== d.pages.length) {
      d.notes.push(`span is ${d.pages.length} page(s) but the document says ${declared}`);
    }
    const lastM = last.m || counter.m || 0;
    if (lastM && lastM !== d.pages.length) {
      d.notes.push(`span is ${d.pages.length} page(s) but its last page is numbered ${lastM}`);
    }
    if (!d.title && !d.carCode) d.notes.push('no title and no C.A.R. code printed on its pages');
    // A page whose strips were never read has no labels, so it silently joined
    // whatever document preceded it. That is a guess, and it says so.
    d.unread = d.pages.filter((p) => (byPage.get(p) || {}).unread).length;
    if (d.unread) {
      d.notes.push(`${d.unread} of its ${d.pages.length} page(s) had no label read, so the span is a guess`);
    }
  }

  return docs;
}

/**
 * Pages no document claimed - arithmetic, not a model call.
 *
 * This is the whole coverage guarantee. The old splitter's page accounting was
 * an implicit property of one big model answer, so 37 unfiled pages looked
 * exactly like 0. Here it is subtraction over a set, and it cannot be
 * plausible-but-wrong.
 */
function unclaimedPages(docs, pageCount) {
  const seen = new Set();
  for (const d of docs) for (const p of d.pages) seen.add(p);
  const out = [];
  for (let p = 1; p <= pageCount; p++) if (!seen.has(p)) out.push(p);
  return out;
}

module.exports = {
  readAllStrips, readStripsFor, documentsFromStrips, unclaimedPages, parseCounter,
  renderStrips, cropStrips,
  HEAD_FRACTION, FOOT_FRACTION, STRIP_SCALE, STRIP_PAGES_PER_CALL, STRIP_CONCURRENCY,
};

// Exposed for checks/page-strips.js, following lib/skip-gate.js's _internal
// convention. The boundary rules are the part worth pinning: every one of them
// is there because a real packet broke without it.
module.exports._internal = { footerDocName, footerNameChanged, footerNamesAgree, namesADocument, envelopeChanged };
