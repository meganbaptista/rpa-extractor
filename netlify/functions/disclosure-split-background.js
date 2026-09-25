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
//      (fully executed) or `N` + the missing parties (B, S, BA, LA) in fixed
//      order, e.g. `NB`, `NB+S`. Duplicates keep both via " (2)".
//   5. Uploads the split files into the property folder (location.propertyFolderId).
//   6. Archives the original to Incoming/_processed/ and emits `disclosure.split`.
//
// Background function: Opus is slower than the ~10s sync cap, and publish() fires
// this fire-and-forget (202). Idempotent on event.id via a "done" blob store.
//
// Signature reading here is document-level (Opus reads the PDF). A crisp-render
// pass (like disclosure-intake's stage A/B for scanned checkboxes) can be added
// later if wet-signed scans need more accuracy.
//
// SPLITTING IS VECTOR-FIRST (see buildFormPdf). Each form file is built by
// copying the REAL PDF pages, so interactive form data (checkbox states, typed
// explanations), signatures, and searchable text all survive into the split
// copy. Only pages whose content is unresolvable (the corrupt-object-ref case
// that historically made pdf-lib copyPages emit blank pages) fall back to a
// rasterized image, so nothing is ever silently blanked.
// ============================================================================

console.log('[disclosure-split] module loading');

const { getStore } = require('@netlify/blobs');
const { PDFDocument, PDFArray, PDFRef } = require('pdf-lib');
// pdfjs (via pdf-parse) tolerates corrupt object refs that make pdf-lib copyPages
// emit BLANK pages — used only as a per-page fallback for pages that can't be
// vector-copied. Same renderer the RPA extractor uses.
const { CanvasFactory } = require('pdf-parse/worker');
const { PDFParse } = require('pdf-parse');
const drive = require('./lib/drive');
const { EVENTS, makeEvent, publish } = require('./lib/events');
const { parseRequestBody } = require('./lib/parse-body');
const { alert } = require('./lib/alert');
const { readAllStrips, documentsFromStrips } = require('./lib/page-strips');
const { auditDocuments } = require('./lib/document-audit');

const MAX_DOC_BYTES = 28 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF');
const DONE_STORE = 'disclosure-split-done';

// Fixed party order for the filename status suffix.
const SIGNER_ORDER = ['B', 'S', 'BA', 'LA', 'BR'];

/**
 * How a missing party reads in a filename.
 *
 * ONE DIALECT, HERS. The splitter used to write `NB`, `NS+LA`, `NBA` while
 * Megan hand-typed `NeedSS`, `NeedLA`, `NeedBA`, `NeedSS+LA` — two spellings
 * of the same fact in one folder, and her `NeedSS+LA` maps exactly onto the
 * machine's `NS+LA`, so there was never a reason for both. Switched
 * 2026-09-23 at her word, with `NEEDB` for the buyer: "we can do that switch.
 * use NEEDB."
 *
 * The broker is words rather than an initial because their absence is a
 * different chase — not the agent forgetting, but a second person to ask.
 *
 * OLD FILENAMES KEEP THEIR OLD SUFFIXES and are still understood: the
 * compliance reconcile reads both dialects, and renaming what is already
 * filed would break nothing but would rewrite history for no gain.
 */
const NEED_WORD = { B: 'NEEDB', S: 'NeedSS', BA: 'NeedBA', LA: 'NeedLA', BR: 'NeedBroker(s)' };

// Rasterization settings for the per-page image fallback (see renderAllPages).
const RENDER_SCALE = 2.0;      // 2x = ~144dpi, legible for a signed form
const MAX_RENDER_PAGES = 120;  // safety cap on pages rendered from one packet

// A source page whose content stream(s) resolve to fewer than this many (raw,
// still-encoded) bytes has no drawable content — the corrupt-object-ref case
// that makes copyPages emit a blank page. Any real form page carries hundreds+
// of content bytes (the template lines/labels), well above this floor, so the
// check cleanly separates "corrupt/blank" from "real page" and never images a
// page that actually has form content. Those pages take the raster fallback.
const MIN_CONTENT_BYTES = 8;

console.log('[disclosure-split] module fully loaded, handler ready');


function blobsConfig(name) {
  return { name, siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN };
}

// ----------------------------------------------------------------------------
// THE SINGLE CALL THAT USED TO LIVE HERE IS GONE, prompt and transport both.
//
// It sent the whole packet to one model call and asked for the complete split
// map AND a per-form signature audit in one response. That held until a packet
// got long: on the 65-page 1333 S Beverly Glen delivery it returned 28 forms
// covering 73 of 110 pages and quietly stopped accounting for the rest, losing
// the cooperating broker's disclosures and the buyer agent's AVID. The answer
// was plausible and incomplete, and coverage was an implicit property of it, so
// 37 unfiled pages looked exactly like none. Megan: "it didn't pull any of the
// coldwell banker disclosures and then the BA AVID it marked it as FX but in
// reality it didn't have any seller signatures on it."
//
// It is now two narrower questions:
//   lib/page-strips.js    where does each document start and end - read off the
//                         header and footer of every page in small batches,
//                         with the spans decided in CODE, so coverage is
//                         subtraction over a set rather than a model's claim.
//   lib/document-audit.js what is this document and who still has to sign it -
//                         asked one document at a time, each as its own small
//                         PDF, which is the part that genuinely needs reading.
//
// The audit prompt there carries this prompt's rules verbatim, minus the
// split-map half. Both are DELETED rather than left in place: a live prompt and
// a dead one that disagree is how the rules drift. Streaming, the 429/529
// retry and the usage logging all live in lib/claude.js, which now records the
// two stages separately - so the AI USAGE ledger shows where the cost went.
// ----------------------------------------------------------------------------

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

// The MLS printout and the Property Profile have no CAR signature lines — their
// only mark is an initial tag in a corner of page 1, and who initials varies by
// package (seller, buyers, or both). So they get a presence test, not an audit:
// ANY initial at all means the doc was delivered and acknowledged -> FX. This is
// decided here rather than left to the model's required/present sets, which can
// over-list required parties on a form that never required them.
const MARK_ONLY_DOCS = new Set(['mls', 'property profile']);
function isMarkOnlyDoc(form) {
  return !clean(form.code) && MARK_ONLY_DOCS.has(clean(form.name).toLowerCase());
}

/**
 * A LABEL THAT NAMES NOTHING.
 *
 * The model is asked for a code and a name, and when it cannot tell what a
 * document is it sometimes answers with a placeholder — "Misc", "Other",
 * "Disclosures", "Document". Filing 9 pages as `Misc - FX.pdf` is worse than
 * not filing them: the name asserts an identity nobody established and the FX
 * asserts a signature audit nobody performed. Those pages belong in
 * `Unsorted - review.pdf`, where they are visibly unhandled.
 */
const EMPTY_LABELS = new Set([
  'misc', 'miscellaneous', 'other', 'others', 'unknown', 'document', 'documents',
  'disclosure', 'disclosures', 'form', 'forms', 'attachment', 'attachments',
  'page', 'pages', 'various', 'n/a', 'na', 'none', 'untitled',
]);

function isUnidentified(form) {
  if (clean(form.code)) return false;              // a CAR code IS an identity
  const name = clean(form.name).toLowerCase().replace(/[^a-z/ ]/g, '').trim();
  return !name || EMPTY_LABELS.has(name);
}

// FX when every required signer is present; else N<missing, in fixed order>.
// Suffix style is Megan's own filing shorthand (NB, NS, NBA, NLA, NB+S), set
// 2026-09-04 to match how she hand-names these in the escrow folders.
function statusSuffix(form) {
  if (isMarkOnlyDoc(form)) {
    return normSigners(form.present_signers).length ? 'FX' : 'NB';
  }
  const required = normSigners(form.required_signers);
  const present = new Set(normSigners(form.present_signers));
  /**
   * NO REQUIRED SIGNERS IS NOT "EVERYONE SIGNED".
   *
   * An empty `required_signers` used to fall straight through to FX, because
   * nothing was missing from nothing. So a form the model could not reason
   * about came out stamped as fully executed - the one status a TC acts on
   * without re-reading the document. `NeedReview` says what actually happened.
   *
   * The mark-only documents (MLS printout, Property Profile) are handled
   * above: they genuinely have no CAR signature lines, and their rule is
   * "whoever marked it is who was required".
   */
  if (!required.length) return 'NeedReview';
  const missing = required.filter((t) => !present.has(t));
  if (!missing.length) return 'FX';
  /**
   * A MISSING SIGNATURE NOBODY CAN ATTRIBUTE IS A REVIEW, NOT A CHASE.
   *
   * Set when an unsigned line's own printed label does not say whose it is -
   * Sotheby's ABA prints four lines all reading "Buyer's or Seller's
   * Signature". The document is definitely incomplete, so FX is already ruled
   * out above; what cannot be honestly stated is WHICH party owes it, and
   * naming the wrong one sends a coordinator chasing the other side for a
   * signature their own client owes.
   */
  if (form.signerAmbiguity) return 'NeedReview';
  const ordered = SIGNER_ORDER.filter((t) => missing.includes(t));
  // "NEEDB", "NeedSS+LA", "NeedBroker(s)" — the first party carries the word
  // and the rest follow after a +, which is how she already writes them.
  const [first, ...rest] = ordered.map((t) => NEED_WORD[t] || t);
  return [first, ...rest.map((w) => w.replace(/^Need/i, ''))].join('+');
}

// Sanitize a form code/name for a filename (Drive tolerates most chars, but keep
// it clean and slash-free).
function clean(s) {
  return String(s || '')
    // A DOUBLE quote is illegal in a filename and decorative in a form name,
    // so it is REMOVED rather than replaced with a space - swapping it left
    // 'Buyer Preliminary Title Report ( PTR ) Advisory' on a real file.
    // Apostrophes are legal and are LEFT ALONE: stripping them would quietly
    // rename "Buyer's Affidavit" for no reason.
    .replace(/["\u201c\u201d]/g, '')
    .replace(/[\\/:*?<>|]/g, ' ')
    .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

// A Text Overflow Addendum (C.A.R. Form TOA) is a continuation sheet for another
// form, not a standalone document.
function isTOA(f) {
  return /(^|\s)TOA(\s|$|\d)/i.test(f.code || '') || /text overflow addendum/i.test(f.name || '');
}

// Fold each TOA into its parent form's page range so they file as one document.
// Parent = the form whose code matches the TOA's parent_code; if that's blank or
// absent, the form whose pages end immediately before the TOA (it physically
// follows the form it continues). A TOA with no locatable parent is left as its
// own form. Returns the surviving (non-merged) forms, page ranges re-sorted.
function mergeAddenda(allForms) {
  const parents = allForms.filter((f) => !isTOA(f));
  const toas = allForms.filter((f) => isTOA(f));
  if (!toas.length || !parents.length) return allForms;

  for (const toa of toas) {
    const pc = clean(toa.parent_code).toUpperCase();
    let parent = pc ? parents.find((f) => clean(f.code).toUpperCase() === pc) : null;
    if (!parent) {
      const firstToaPage = Math.min(...toa.pages);
      parent = parents
        .filter((f) => Math.max(...f.pages) < firstToaPage)
        .sort((a, b) => Math.max(...b.pages) - Math.max(...a.pages))[0] || null;
    }
    if (parent) {
      parent.pages = [...new Set([...parent.pages, ...toa.pages])].sort((a, b) => a - b);
      toa._merged = true;
      console.log(`[disclosure-split] merged TOA (pages ${toa.pages.join(',')}) into ${parent.code || parent.name}`);
    }
  }
  return allForms.filter((f) => !f._merged);
}

// A numbered counter offer (BCO / SCO / SMCO). Standalone documents, but a
// package often holds two or three, and without the number in the filename the
// second one would silently become "SCO - Seller Counter Offer (2)" — which
// reads like a duplicate rather than Counter Offer No. 2.
const COUNTER_CODES = new Set(['BCO', 'SCO', 'SMCO']);
function isCounter(f) {
  const code = clean(f.code).toUpperCase();
  if (COUNTER_CODES.has(code)) return true;
  return /\bcounter\s*offer\b/.test(clean(f.name).toLowerCase());
}

// A non-TOA addendum: a C.A.R. Form ADM, or a custom "Addendum to <form>"
// continuation sheet. Unlike a TOA (which is merged into its parent), these are
// distinct signed documents kept as their own file — but RENAMED to lead with
// their parent's CAR code so they sort next to the parent in Drive and their
// parent is visible in the name. TOA is explicitly excluded (it's merged, not
// relabeled).
function isAddendum(f) {
  if (isTOA(f)) return false;
  const code = clean(f.code).toUpperCase();
  const name = clean(f.name).toLowerCase();
  return code === 'ADM' || /\baddendum\b/.test(name);
}

// The filename base (before the " - <STATUS>" suffix). For an addendum with a
// resolved parent, "<PARENT_CODE> - Addendum[ No. N]" so it files beside the
// parent (e.g. "TDS - Addendum No. 1", "SPQ - Addendum"). Otherwise the normal
// "<CODE> - <Name>" label. A parent-less addendum keeps its own label rather
// than guessing (no regression on the ambiguous case).
/**
 * The firm name for a filename: the brand, without its office or region tail.
 *
 * "Coldwell Banker Realty - Hancock Park" and "Christie's International Real
 * Estate Southern California" are the same firms as "Coldwell Banker Realty"
 * and "Christie's International Real Estate", and the tail only makes a
 * filename longer. Trimmed conservatively - the FIRM stays intact, because a
 * name Megan does not recognise at a glance is worse than a long one.
 */
const NOT_A_BROKERAGE = /^(california association of realtors|c\.?a\.?r\.?|snapnhd)$/i;
function brokerageName(form) {
  let b = String(form.brokerage || '').trim();
  if (!b) return '';
  // A co-branded header ("AKG | Christie's International Real Estate") names
  // the TEAM and the firm; the firm is the half worth filing under. Split
  // first, because clean() turns the pipe into a space and the two halves
  // become one unreadable name.
  const parts = b.split('|').map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) b = parts[parts.length - 1];
  b = b.split(' - ')[0].split(',')[0].trim();                 // office / address tail
  b = b.replace(/\s+(southern|northern)\s+california$/i, '')  // region tail
       .replace(/\s+so\.?\s*cal\.?$/i, '')
       .replace(/\s+(inc|llc|lp|ltd)\.?$/i, '')
       .trim();
  if (NOT_A_BROKERAGE.test(b)) return '';
  return clean(b);
}

/** Does the document's own name already say whose it is? */
function nameCarriesBrokerage(name, brokerage) {
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const n = norm(name);
  const b = norm(brokerage);
  if (!n || !b) return false;
  if (n.includes(b)) return true;
  // "Coldwell Banker Contract Addendum..." carries "Coldwell Banker" without
  // the "Realty", so the first two significant words are enough to tell.
  const lead = b.split(' ').filter((w) => w.length > 2).slice(0, 2).join(' ');
  return !!lead && n.includes(lead);
}

function formLabel(form) {
  if (isAddendum(form)) {
    const parent = clean(form.parent_code).toUpperCase();
    if (parent) {
      const no = clean(form.doc_no);
      return no ? `${parent} - Addendum No. ${no}` : `${parent} - Addendum`;
    }
  }
  /**
   * TWO BOOKLET RECEIPTS IN ONE PACKAGE IS NORMAL, so they cannot share a name.
   *
   * 1333 S Beverly Glen carried both: the standard C.A.R. receipt on page 25
   * (printed twice on one sheet, a buyer block above a seller block) and
   * Christie's own "Receipt for Links to Booklets" on page 32. Both are
   * genuinely booklet receipts, the audit correctly named them both
   * "EQ Booklet Receipt", and the second filed as "(2)" - which says nothing
   * about which is which. Megan: "maybe we change this version to say CAR EQ
   * Booklet Receipt... and then the others can reference the brokerage".
   *
   * The C.A.R. one is the one with no brokerage: it belongs to the form
   * publisher, not to a firm. A brokerage equivalent already picks up its firm
   * from the prefix below, so only this side needs saying.
   */
  if (/^eq booklet receipt$/i.test(clean(form.name)) && !brokerageName(form)) {
    form = { ...form, name: 'CAR EQ Booklet Receipt' };
  }
  let base = [form.code, form.name].filter(Boolean).join(' - ');
  /**
   * WHOSE DOCUMENT IS IT, FIRST IN THE NAME. Megan's request, 2026-09-24:
   * "I would urge for the brokerage name to be before 'Affiliate'".
   *
   * A delivery routinely carries three brokerages' affiliated business
   * disclosures, all printed from the same C.A.R.-less template and all
   * therefore filing under the same name - on 1333 S Beverly Glen that gave
   * her "Affiliated Business Arrangement Disclosure Statement - NeedReview"
   * and the same again as "(2)", with no way to tell which firm's was which
   * without opening both.
   *
   * Only for documents with NO C.A.R. code: a C.A.R. form belongs to no
   * brokerage, and prefixing a TDS with a firm would be wrong. And skipped
   * where the document's own title already names the firm, or the Coldwell
   * Banker privacy notice would file as "Coldwell Banker Realty - Privacy
   * Notice for Coldwell Banker Realty Clients".
   */
  if (!clean(form.code)) {
    const firm = brokerageName(form);
    if (firm && !nameCarriesBrokerage(form.name, firm)) base = `${firm} - ${base}`;
  }
  if (isCounter(form)) {
    const no = clean(form.doc_no);
    if (no && !/\bno\.?\s*\d/i.test(base)) return `${base} No. ${no}`;
  }
  return base;
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

// Rasterize every page of the PDF to a PNG via pdfjs (tolerant of the corrupt
// object refs that make pdf-lib copyPages emit blank pages). Used only as the
// per-page / whole-form fallback for pages that can't be vector-copied.
// Returns [{pageNumber, png}].
async function renderAllPages(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer), CanvasFactory });
  try {
    const result = await parser.getScreenshot({ scale: RENDER_SCALE, first: MAX_RENDER_PAGES });
    return (result.pages || [])
      .filter((p) => p.data)
      .map((p) => ({ pageNumber: p.pageNumber, png: Buffer.from(p.data) }));
  } finally {
    await parser.destroy();
  }
}

// Draw one rasterized page image onto a fresh page of `out`, sized to the image.
async function addImagePage(out, img) {
  const png = await out.embedPng(img.png);
  const page = out.addPage([png.width, png.height]);
  page.drawImage(png, { x: 0, y: 0, width: png.width, height: png.height });
}

// Build an image-based PDF from the given 1-indexed page numbers, in order.
// Used as the whole-form fallback when the vector copy fails outright.
async function buildImagePdf(pageImages, pageNums) {
  const out = await PDFDocument.create();
  for (const n of pageNums) {
    const img = pageImages.find((p) => p.pageNumber === n);
    if (!img) continue;
    await addImagePage(out, img);
  }
  if (out.getPageCount() === 0) return null;
  return Buffer.from(await out.save());
}

// Total raw (still-encoded) byte length of a source page's content stream(s).
// Returns 0 if the Contents entry is missing or any ref fails to resolve — i.e.
// the page has nothing to draw. `pageIndex` is 0-indexed.
function sourceContentBytes(srcDoc, pageIndex) {
  try {
    const ctx = srcDoc.context;
    const resolve = (o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
    let contents = resolve(srcDoc.getPage(pageIndex).node.Contents());
    if (!contents) return 0;
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
    let total = 0;
    for (const s of streams) {
      const stream = resolve(s);
      if (stream && stream.contents) total += stream.contents.length;
    }
    return total;
  } catch {
    return 0;
  }
}

// ----------------------------------------------------------------------------
exports.handler = async function (event) {
  // Parsed through lib/parse-body rather than a bare JSON.parse so that (a) a
  // base64 or form-encoded body is RECOVERED instead of rejected, and (b) when
  // the body genuinely cannot be parsed the log NAMES THE CAUSE. The previous
  // one-liner here logged only "invalid JSON body", which is unactionable: it
  // discarded the length, the content type, the base64 flag and the offending
  // characters, i.e. everything that distinguishes a 6MB truncation from an
  // unescaped quote in a mapped Zapier field. See that module's header.
  const parsedBody = parseRequestBody(event);
  if (!parsedBody.ok) {
    console.error(`[disclosure-split] invalid request body - ${parsedBody.diagnostic}`);
    return { statusCode: 400 };
  }
  const envelope = parsedBody.body;
  // Only set when the body had to be recovered. Worth a line in the logs: it
  // means the caller is not posting clean JSON and should be fixed upstream.
  if (parsedBody.note) console.warn(`[disclosure-split] ${parsedBody.note}`);

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

  console.log(`[disclosure-split] received ${eventId} file="${source.fileName || fileId}" -> property ${propertyFolderId}`);
  try {
    const done = getStore(blobsConfig(DONE_STORE));
    if (await done.get(eventId, { type: 'json' }).catch(() => null)) {
      console.log(`[disclosure-split] already processed ${eventId}, skipping`);
      return { statusCode: 200 };
    }

    // 1) Download + sanity-check the PDF.
    const buffer = await drive.download(fileId);
    console.log(`[disclosure-split] downloaded ${buffer.length} bytes`);
    if (!(buffer && buffer.length >= 4 && buffer.subarray(0, 4).equals(PDF_MAGIC))) {
      throw new Error(`downloaded file is not a PDF (${source.fileName || fileId})`);
    }
    if (buffer.length > MAX_DOC_BYTES) throw new Error(`file too large (${buffer.length}B)`);

    // 2) Get page count (pdf-lib parses fine even with the corrupt refs) and
    //    flag any page whose content is unresolvable/empty — those can't be
    //    vector-copied (they'd blank), so they take the raster fallback. Page
    //    images are rendered LAZILY: a clean packet skips rasterization entirely
    //    and every form is built from the real (searchable, form-preserving) PDF
    //    pages. Only when a page needs the fallback do we rasterize.
    const srcDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pageCount = srcDoc.getPageCount();
    const blankPages = new Set();
    for (let p = 1; p <= pageCount; p++) {
      if (sourceContentBytes(srcDoc, p - 1) < MIN_CONTENT_BYTES) blankPages.add(p);
    }
    if (blankPages.size) {
      console.log(`[disclosure-split] ${blankPages.size} page(s) have unresolvable content -> raster fallback for those: ${[...blankPages].join(',')}`);
    }

    // Memoized rasterizer: renders the whole packet once, on first need.
    let _pageImages = null;
    const getImages = async () => {
      if (_pageImages) return _pageImages;
      console.log(`[disclosure-split] rasterizing ${pageCount} page(s) for fallback...`);
      _pageImages = await renderAllPages(buffer);
      console.log(`[disclosure-split] rendered ${_pageImages.length} fallback image(s)`);
      return _pageImages;
    };

    // Build one form's PDF from the given 1-indexed page numbers, in order.
    // Vector-copies every page that can be, images only the ones flagged blank.
    // On any hard failure, falls back to an all-image build so we never emit a
    // broken/empty file.
    const buildFormPdf = async (pageNums) => {
      try {
        const out = await PDFDocument.create();
        const vectorNums = pageNums.filter((n) => !blankPages.has(n));
        const needImage = pageNums.some((n) => blankPages.has(n));
        const images = needImage ? await getImages() : [];
        const copied = vectorNums.length
          ? await out.copyPages(srcDoc, vectorNums.map((n) => n - 1))
          : [];
        const copiedByN = new Map();
        vectorNums.forEach((n, i) => copiedByN.set(n, copied[i]));
        for (const n of pageNums) {
          if (copiedByN.has(n)) {
            out.addPage(copiedByN.get(n));
          } else {
            const img = images.find((p) => p.pageNumber === n);
            if (img) await addImagePage(out, img);
          }
        }
        if (out.getPageCount() === 0) return null;
        return Buffer.from(await out.save());
      } catch (err) {
        console.warn(`[disclosure-split] vector split failed (${err.message}); using image fallback`);
        return buildImagePdf(await getImages(), pageNums);
      }
    };
    const extract = (pages) => buildFormPdf(pages);

    // 3) IDENTIFY, in two stages: where each document is, then what it is.
    //
    // THIS USED TO BE ONE CALL. The whole packet went to the model with a
    // prompt asking for the complete split map AND a per-form signature audit
    // in one response. On the 65-page 1333 S Beverly Glen delivery that
    // returned 28 forms covering 73 of 110 pages, with the cooperating
    // broker's disclosures and the buyer agent's AVID simply missing - a
    // plausible, incomplete answer, and nothing in it said so. Coverage was an
    // implicit property of that answer, so 37 unfiled pages looked exactly
    // like none. Megan, on the email that followed: "it didn't pull any of the
    // coldwell banker disclosures and then the BA AVID it marked it as FX but
    // in reality it didn't have any seller signatures on it."
    //
    // Stage one reads the header and footer STRIPS of every page in small
    // batches and works out the page spans IN CODE (lib/page-strips.js), so
    // coverage becomes subtraction over a set rather than something a model
    // asserts. Stage two hands each document to the model as its own small PDF
    // and asks only what it is and who still has to sign it
    // (lib/document-audit.js) - the part that genuinely needs reading, and the
    // part that does not degrade when the question is one to five pages long.
    //
    // The `forms` shape that comes out is unchanged, so everything below here
    // - mergeAddenda, statusSuffix, formLabel, the Unsorted guard, coverage -
    // is untouched.
    console.log(`[disclosure-split] reading page strips across ${pageCount} page(s)...`);
    const strips = await readAllStrips(buffer, pageCount, source.fileName || '');
    const documents = documentsFromStrips(strips);
    const unlabelled = strips.filter((r) => r.unread).length;
    console.log(`[disclosure-split] ${documents.length} document(s) identified from strips` +
      (unlabelled ? `, ${unlabelled} page(s) had no label read` : ''));
    for (const d of documents) {
      if (d.notes.length) {
        console.warn(`[disclosure-split] pages ${d.pages.join(',')} (${d.title || d.carCode || 'unnamed'}): ${d.notes.join('; ')}`);
      }
    }

    console.log(`[disclosure-split] auditing ${documents.length} document(s) with Opus...`);
    const mappedForms = (await auditDocuments(documents, extract, source.fileName || ''))
      .map((f) => ({
        code: clean(f.code),
        name: clean(f.name),
        revision: String(f.revision || '').trim(),
        pages: f.pages,
        parent_code: clean(f.parent_code),
        // doc_no is the number on any NUMBERED document (Addendum No. N,
        // Counter Offer No. N).
        doc_no: String(f.doc_no || '').trim(),
        brokerage: String(f.brokerage || '').trim(),
        // Set when this document's pages were gathered from non-adjacent parts
        // of the delivery. Reported, never smoothed over - see below.
        outOfSequence: f.outOfSequence || null,
        required_signers: f.required_signers,
        present_signers: f.present_signers,
        // The printed signature lines the audit transcribed. Carried through
        // to be LOGGED on a form stamped FX - see below.
        signature_lines: f.signature_lines,
        // How many unsigned lines carry a label that does not say whose they
        // are. Turns a named chase into a review; see statusSuffix.
        signerAmbiguity: f.signerAmbiguity,
        // Why this document needs a human: a disputed boundary, an audit call
        // that failed, or a span the strips could not corroborate. Carried
        // through to the Unsorted reason so the alert names the cause.
        review: f.review || null,
      }))
      .filter((f) => f.pages.length);

    // Reattach Text Overflow Addenda to their parent form. A TOA is a
    // continuation sheet whose body names its parent's CAR code in brackets
    // (e.g. "[SPQ]"); the model returns that as parent_code. Append the TOA's
    // pages to that parent so they file as ONE document (the merged file keeps
    // the parent's name + signature status). A TOA whose parent isn't in the
    // packet stays standalone. Fallback when parent_code is blank: the form
    // whose pages end immediately before the TOA (a TOA physically follows the
    // form it continues).
    const forms = mergeAddenda(mappedForms);

    if (!forms.length) {
      throw new Error('no documents identified — leaving original in place for manual handling');
    }

    // Name-collision set = existing files already in the property folder.
    const existing = await drive.listChildren(propertyFolderId, { excludeFolders: true }).catch(() => []);
    const taken = new Set(existing.map((f) => String(f.name || '').toLowerCase()));

    // 4) Split + name + upload each form.
    const results = [];
    const coveredPages = new Set();
    const failedForms = [];
    for (const form of forms) {
      const status = statusSuffix(form);
      const label = formLabel(form);
      const base = `${label} - ${status}`;
      const filename = uniqueName(base, taken);
      /**
       * UNIDENTIFIED GOES TO UNSORTED, not to a file named after a guess. Its
       * pages stay uncovered, so the guard below sweeps them into
       * `Unsorted - review.pdf` and the alert names them.
       */
      if (isUnidentified(form)) {
        // WHY it could not be named is the useful half. `review` carries it:
        // a disputed boundary ("more than one document may be here: ..."), an
        // audit call that failed, or a span the strips could not corroborate.
        // Without it the alert says "not identified" about every one of them,
        // which tells a TC to go and look at all of them.
        const reason = form.review || 'not identified';
        console.warn(`[disclosure-split] unidentified document (pages ${form.pages.join(',')}) -> Unsorted: ${reason}`);
        failedForms.push({ label: label || 'unidentified', pages: form.pages, reason });
        continue;
      }
      const bytes = await extract(form.pages);
      if (!bytes) {
        console.warn(`[disclosure-split] ${label}: no valid pages, skipped`);
        failedForms.push({ label, pages: form.pages, reason: 'could not be built' });
        continue;
      }
      const uploaded = await drive.uploadMultipart({ name: filename, parents: [propertyFolderId], mimeType: 'application/pdf', bytes });
      /**
       * PAGES COUNT AS COVERED ONLY ONCE A FILE EXISTS.
       *
       * THE SILENT LOSS THIS FIXES. These four lines used to run FIRST, before
       * the build — so a form whose PDF failed to build had already been
       * marked covered, produced no file, and its pages never reached the
       * Unsorted guard below. The page left no file and no warning anybody
       * would see: a console line in a background function.
       *
       * Megan hit it on 700 S Abel St, 2026-09-23: "the AI run missed the
       * Earthquake Booklet Receipt FX which was in this PDF, but didn't get
       * placed in the Google Drive so I had to go back and manually grab it."
       * There was no Unsorted file either, which is how we know the page was
       * claimed and then dropped rather than never recognised.
       *
       * Coverage is now a statement about FILES ON DISK, which is the only
       * version of it worth anything: the compliance writer downstream reads
       * the folder, so a page with no file must show up as still needed.
       */
      form.pages.forEach((p) => coveredPages.add(p));
      results.push({ code: form.code, name: form.name, status, filename, fileId: uploaded.id, pages: form.pages, review: form.review || undefined, outOfSequence: form.outOfSequence || undefined });
      console.log(`[disclosure-split] wrote "${filename}" (pages ${form.pages.join(',')})`);
      // A form that WAS named can still have a caveat on its page span. It
      // files under its own name, because it has an identity, but the caveat
      // rides along on the event and into the alert below rather than being
      // dropped on the floor.
      if (form.review) console.warn(`[disclosure-split] "${filename}": ${form.review}`);
      /**
       * SHOW THE WORKING BEHIND AN FX.
       *
       * FX is the only status a coordinator acts on without opening the file,
       * so it is the one that has to be checkable after the fact. Two
       * affiliated business disclosures on 1333 S Beverly Glen filed as FX
       * with the sellers' lines blank, and nothing in the log said which lines
       * had been seen - so the diagnosis needed the original PDF and a page
       * render. One line per FX form fixes that, and only for FX: printing it
       * for every document would bury it.
       */
      if (form.signerAmbiguity) {
        console.warn(`[disclosure-split] "${filename}": ${form.signerAmbiguity} unsigned line(s) do not say which party owes them, so it is a review rather than a named chase`);
      }
      if (status === 'FX' && Array.isArray(form.signature_lines) && form.signature_lines.length) {
        const seen = form.signature_lines
          .map((l) => `${String((l && l.label) || '?')}${l && l.signed ? '' : ' [BLANK]'}`)
          .join(' | ');
        console.log(`[disclosure-split] "${filename}" FX from lines: ${seen}`);
      }
    }
    if (failedForms.length) {
      console.warn(`[disclosure-split] ${failedForms.length} form(s) failed to build and fall through to Unsorted: ` +
        failedForms.map((f) => `${f.label} (pages ${f.pages.join(',')})`).join('; '));
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
    /**
     * THE SPLIT SAYS WHETHER IT WAS COMPLETE, and every consumer needs that.
     *
     * `complete` is false when any page of the source produced no file -
     * because a form failed to build, or because nothing claimed those pages.
     * The compliance writer downstream DELETES lines off a Google Doc when it
     * sees a file, so it has to know when the folder it is reading is not the
     * whole package: an incomplete split can only ever leave a line saying
     * "still needed" that should have gone, which is the safe direction, but a
     * TC deserves to be told rather than left to notice.
     */
    /**
     * `flagged` is a THIRD state, and it is deliberately not part of
     * `complete`. These forms are named and filed, so nothing is missing and a
     * TC does not need to do anything - but the span carries a caveat worth
     * reading (a document that printed a longer length than the pages
     * delivered, a page whose labels could not be read). Folding them into
     * `complete: false` would cry wolf on a delivery where every form landed;
     * dropping them would hide the one case where a form filed under a
     * slightly wrong page range.
     */
    const flagged = results.filter((r) => r.review)
      .map((r) => ({ filename: r.filename, pages: r.pages, note: r.review }));
    /**
     * A DELIVERY THAT ARRIVED OUT OF SEQUENCE IS A CONVERSATION WITH WHOEVER
     * SENT IT, not a tidy folder.
     *
     * Megan expects this never to happen - "nobody would send documents out of
     * sequence" - and the 1333 S Beverly Glen package did it twice anyway. The
     * pages are joined so the file is right, but the condition is surfaced on
     * its own rather than folded in with the span caveats, because the action
     * it calls for is different: the other notes are for her, this one is for
     * the sender.
     */
    const outOfSequence = results.filter((r) => r.outOfSequence)
      .map((r) => ({ filename: r.filename, detail: r.outOfSequence }));
    const coverage = {
      pageCount,
      filed: results.length,
      unsortedPages,
      failedForms,
      flagged,
      outOfSequence,
      complete: unsortedPages.length === 0 && failedForms.length === 0,
    };
    await done.setJSON(eventId, {
      at: new Date().toISOString(),
      files: results.map((r) => r.filename),
      coverage,
    });
    /**
     * AN INCOMPLETE SPLIT HAS TO REACH A PERSON.
     *
     * Megan, 2026-09-23: "we need to notify somehow that there was an error."
     * The Earthquake Booklet Receipt was lost silently on 700 S Abel St and
     * the only trace was a console line in a background function - which is
     * the same as no trace. A page that produced no file is a form nobody has,
     * and downstream the compliance Doc will simply go on saying it is still
     * needed, which is correct but says nothing about WHY.
     *
     * THROTTLED PER DEAL, not globally: the key carries the property folder so
     * one troubled package cannot mask a different deal's problem, and a
     * re-drop of the same package does not ping twice within the window.
     */
    /**
     * REPORTED EVEN WHEN THE SPLIT IS COMPLETE, and deliberately not part of
     * `complete`: nothing is missing, every page landed, and she does not have
     * to do anything in the folder. What she may want to do is tell the sender.
     */
    if (outOfSequence.length) {
      const where = location.propertyFolderName || propertyFolderId;
      await alert(
        `split-out-of-sequence:${where}`,
        `${source.fileName} in ${where} had ${outOfSequence.length} document(s) delivered OUT OF ` +
        'SEQUENCE - their pages were spread across the package rather than running together. The ' +
        'pages have been gathered into one file each, so the folder is right:\n' +
        outOfSequence.map((o) => `  - ${o.filename}: ${o.detail}`).join('\n') +
        '\n\nThe original package is archived in Incoming/_processed/ exactly as it arrived. Worth ' +
        'mentioning to whoever sent it, since a form split across a package is easy to miss by hand.',
        { force: true, source: 'disclosure-pipeline', label: 'Disclosure Pipeline' },
      );
    }

    if (!coverage.complete) {
      const where = location.propertyFolderName || propertyFolderId;
      const parts = [];
      if (failedForms.length) {
        parts.push(
          `${failedForms.length} document(s) could not be filed: ` +
          failedForms.map((f) => `${f.label} (page ${f.pages.join(', ')}) - ${f.reason}`).join('; '),
        );
      }
      if (unsortedPages.length) {
        parts.push(`page(s) ${unsortedPages.join(', ')} matched no form`);
      }
      await alert(
        `split-incomplete:${where}`,
        `${source.fileName} in ${where}: ${parts.join(' — ')}. ` +
        (unsorted
          ? `Those pages are in "${unsorted.filename}" — name and file them by hand.`
          : 'Those pages produced NO file at all — re-drop the package.') +
        ` The compliance list will keep asking for anything that did not land.`,
        { source: 'disclosure-pipeline', label: 'Disclosure Pipeline' },
      );
    }

    const splitEvent = makeEvent(EVENTS.DISCLOSURE_SPLIT, {
      id: eventId,
      source,
      location,
      split: results,
      unsorted,
      coverage,
    });
    await publish(splitEvent);

    console.log(
      `[disclosure-split] ${coverage.complete ? 'complete' : 'INCOMPLETE'} — ${results.length} form(s) filed to ` +
      `${location.propertyFolderName || propertyFolderId}` +
      (unsortedPages.length ? `, ${unsortedPages.length} page(s) unsorted` : '') +
      (failedForms.length ? `, ${failedForms.length} document(s) not filed` : '') +
      (flagged.length ? `, ${flagged.length} filed with a note on its page span` : '') +
      (outOfSequence.length ? `, ${outOfSequence.length} delivered OUT OF SEQUENCE and gathered` : ''),
    );
    return { statusCode: 200 };
  } catch (err) {
    console.error('[disclosure-split] ERROR:', err.message);
    // Do NOT mark done and do NOT archive on error, so a re-drop reprocesses.
    return { statusCode: 500 };
  }
};

// Exposed for checks/disclosure-split-naming.js, following lib/skip-gate.js's
// _internal convention. The filename a document lands under is what Megan
// actually sees, so it is worth asserting without a Drive upload.
module.exports._internal = { statusSuffix, formLabel, isUnidentified, mergeAddenda, clean, normSigners, brokerageName, nameCarriesBrokerage };
