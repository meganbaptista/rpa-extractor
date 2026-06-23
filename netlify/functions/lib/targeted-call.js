// ─── SHARED TARGETED-CALL ORCHESTRATION ──────────────────────────────────────
// The "targeted call" is the second of the two Claude calls in the extractor: a
// narrow extraction over a 2-page RPA trim (page 1 for the prepared date +
// the page-17 "Real Estate Brokers Section" for the buyer/seller agent fields).
//
// This module is the SINGLE SOURCE OF TRUTH for that orchestration. Both
// extract-background.js (the live worker) and extract.js (the legacy /extract
// endpoint) import from here. Historically this logic was hand-copied into both
// functions and DRIFTED — the live worker carried a stale one-sided tool
// description (subsection A only) while the legacy endpoint had the corrected
// bidirectional one, among other divergences. Keeping it here makes that class
// of bug impossible. Make targeted-call changes ONCE, in this file.
//
// The field SCHEMA still lives in ./rpa-fields.js (shared the same way). This
// module composes those field descriptions into the targeted tool + prompt.

const { FIELDS } = require('./rpa-fields');

// ── TARGETED-CALL HI-RES RENDER SCALE ────────────────────────────────────────
// On a broken-text-layer (or unrenderable) packet the model can only read the
// rendered pixels of the brokers page + RPA p1. ~2.75 renders a letter page near
// 1680x2180 — sharp enough to resolve a single handwritten digit and to keep the
// Buyer/Seller (subsection A vs B) brokerage columns apart.
const TARGETED_IMAGE_SCALE = 2.75;

// Fields whose emptiness after the main call means the main call probably failed
// to read the brokers section — i.e. the fields that justify firing/merging the
// targeted call. (buyer_agent_name_2 / _dre_2 are intentionally excluded: they
// are legitimately empty when only one agent signs.)
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
  // BIDIRECTIONAL description (A → buyer_agent_*, B → seller_agent_*). This is
  // the corrected version; the live worker previously carried a stale one-sided
  // ("subsection A only") variant that undersold seller extraction.
  description: "Extract a small set of fields from a California real estate purchase agreement package. You have ONE job: locate two specific pages and extract from them. (1) Find page 1 of the original RPA/VLPA/RIPA/CPA — identifiable by the literal label 'Date Prepared:' at the top-left and the footer 'PAGE 1 OF 17' or similar — and extract the date next to that label. (2) Find the LAST PAGE of the same RPA — identifiable by the 'REAL ESTATE BROKERS SECTION' header and the footer 'PAGE 17 OF 17' or similar. From subsection A 'Buyer's Brokerage Firm' extract every buyer_agent_* field; from subsection B 'Seller's Brokerage Firm' extract every seller_agent_* field. Keep the two subsections strictly separate. Both pages exist in the package. The RPA is always present. Read each field description carefully and return values directly from those two pages.",
  input_schema: {
    type: "object",
    properties: TARGETED_FIELDS,
    required: Object.keys(TARGETED_FIELDS)
  }
};

const TARGETED_PROMPT = `Your task is narrow and specific. The attached package contains a California real estate purchase agreement (RPA / VLPA / RIPA / CPA). Find these two pages in the document set and extract from them by calling the extract_targeted_fields tool:

• Page 1 of the RPA — top-left contains the literal text "Date Prepared:" followed by a date. The footer on this page reads "RPA REVISED 12/25 (PAGE 1 OF 17)" or similar variant. Extract the date for date_rpa_prepared. Transcribe the characters that literally appear after the "Date Prepared:" label exactly as written, then convert to ISO — e.g. "June 7, 2026" → "2026-06-07". Read each digit; do NOT round, infer, or approximate the day (do not turn a 7 into a 10, etc.).

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

DIFFERENT BROKERAGES ARE THE COMMON CASE. The buyer's brokerage (subsection A) and the seller's brokerage (subsection B) are usually DIFFERENT firms — e.g. subsection A is "KW Beverly Hills" and subsection B is "Compass" — each with its own office address, email, and phone. Do NOT assume the two sides share a firm name, brokerage DRE, office address, email, or phone. Read each subsection's firm / address / email / phone from its OWN block. If the buyer agent's phone line in subsection A is blank, return empty for buyer_agent_phone — do NOT copy the seller agent's phone from subsection B.

DRE ANCHORING. Each "By" line carries the INDIVIDUAL agent's DRE on that same line, next to that agent's printed name. The BROKERAGE's DRE is a different number on the firm-name line (the "A. Buyer's Brokerage Firm" / "B. Seller's Brokerage Firm" line above the "By" lines). Put the individual agent's DRE in buyer_agent_dre / seller_agent_dre, and the brokerage's DRE in buyer_agent_brokerage_dre / seller_agent_brokerage_dre. Never read an agent's DRE off the firm line, and never put a brokerage DRE into an agent_dre field.

SECOND BUYER AGENT — only when there genuinely are two. Populate buyer_agent_name_2 and buyer_agent_dre_2 ONLY when BOTH are true: (a) the "More than one agent from the same firm represents Buyer" checkbox in subsection A is marked, AND (b) a SECOND "By" line in subsection A has a real printed name. If only one agent signed under subsection A, leave buyer_agent_name_2 and buyer_agent_dre_2 EMPTY. NEVER place the seller's agent (subsection B) into the second buyer slot — the seller's agent is never a buyer's second agent.

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

// Targeted content over a PDF document block (text-layer-intact packets get
// text + Anthropic's own page render).
const buildTargetedContent = (docs) => [...docs, { type: 'text', text: TARGETED_PROMPT }];

// Targeted content over server-side-rendered page images: each rendered page
// becomes its own image block, followed by the targeted prompt. Used for
// broken-text-layer packets and for the unrenderable-PDF render-retry below.
const buildImageFallbackContent = (renderedPages) => {
  const blocks = renderedPages.map((p) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: p.base64 }
  }));
  blocks.push({ type: 'text', text: TARGETED_PROMPT });
  return blocks;
};

// Map a page-detection method to the extractionStatus label for a 2-page trim.
function trimStatusFor(detectionMethod) {
  return detectionMethod === 'text' ? 'text_trim'
    : detectionMethod === 'image_locate' ? 'image_locate_trim'
    : 'vision_trim_sonnet';
}

// True when the targeted tool result carries no usable value (no tool_use block,
// or every field is empty/whitespace). An all-empty text_trim result is the
// signature of a page that never actually rendered for the model.
function isTargetedResultEmpty(toolBlock) {
  if (!toolBlock || !toolBlock.input) return true;
  return Object.values(toolBlock.input).every(
    (v) => !(v && String(v).trim() !== '')
  );
}

// Merge a targeted tool result into the main-call field map IN PLACE. The
// targeted (subsection-A/B) value wins ONLY when it is non-empty, and seller_agent_*
// values are skipped when an MLS is present (seller agent is MLS-first). Returns
// the field keys that filled / stayed empty / were skipped for MLS, for logging.
function mergeTargetedFields(mergedFields, targetedInput) {
  const filled = [];
  const empty = [];
  const skippedForMls = [];
  const hasMls = !!(mergedFields.mls_number && mergedFields.mls_number.trim() !== '');
  for (const [key, value] of Object.entries(targetedInput)) {
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
  return { filled, empty, skippedForMls };
}

// Run the targeted call over a 2-page RPA trim, in parallel with the main call.
// Returns { data, status } where `data` is the raw Anthropic response and
// `status` is the extractionStatus label (possibly suffixed '_render_retry').
//
// deps: { callApi, renderAllPagesAsImages, findToolUse } — injected so this
// module stays free of HTTP / pdf-render wiring (those live in the functions).
//
//   • text-layer-intact packets (text_trim) send the PDF document block.
//   • broken-text-layer packets (vision / image_locate) send a hi-res PNG render
//     of the trim instead (no text for the model to read, only pixels).
//   • NEW — RENDER-RETRY: a text_trim/PDF-block call that comes back with EVERY
//     targeted field empty usually means Anthropic's PDF renderer choked on a
//     structurally-damaged PDF (e.g. "Invalid object ref") even though our text
//     layer was intact enough to locate the pages. Our own server-side renderer
//     tolerates those broken object refs, so re-render the 2-page trim to hi-res
//     PNGs and try once more before giving up.
async function runTargetedTrimCall({ trimmedTargetedB64, detectionMethod, deps }) {
  const { callApi, renderAllPagesAsImages, findToolUse } = deps;
  const brokenTextLayer =
    detectionMethod === 'vision' || detectionMethod === 'image_locate';
  let status = trimStatusFor(detectionMethod);
  const trimBuffer = Buffer.from(trimmedTargetedB64, 'base64');

  // Render the 2-page trim to hi-res PNG content; null if nothing rendered.
  const renderHiResContent = async () => {
    const hiResPages = await renderAllPagesAsImages(trimBuffer, 2, TARGETED_IMAGE_SCALE);
    return hiResPages.length ? buildImageFallbackContent(hiResPages) : null;
  };

  let targetedContent = null;
  let usedHiRes = false;
  if (brokenTextLayer) {
    try {
      const hiResContent = await renderHiResContent();
      if (hiResContent) {
        targetedContent = hiResContent;
        usedHiRes = true;
        console.log('targeted call: rendered 2-page trim to hi-res images (scale ' +
          TARGETED_IMAGE_SCALE + ') for broken-text-layer packet (' + detectionMethod + ')');
      }
    } catch (renderErr) {
      console.warn('targeted hi-res render failed (' + renderErr.message + '), using PDF trim instead');
    }
  }
  if (!targetedContent) {
    targetedContent = buildTargetedContent([{
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: trimmedTargetedB64 },
      title: 'RPA page 1 and brokers section (trimmed)'
    }]);
  }

  let data = await callApi(targetedContent, targetedTool);

  // Render-retry: PDF-block path came back with nothing usable -> the model
  // likely never saw the pages. Re-render server-side and try once more.
  if (!usedHiRes && isTargetedResultEmpty(findToolUse(data))) {
    try {
      const retryContent = await renderHiResContent();
      if (retryContent) {
        console.log('targeted call: PDF-block result was all-empty (likely unrenderable PDF), ' +
          'retrying on hi-res server-side render');
        const retryData = await callApi(retryContent, targetedTool);
        if (!isTargetedResultEmpty(findToolUse(retryData))) {
          data = retryData;
          status = status + '_render_retry';
          console.log('targeted call: render-retry recovered targeted fields');
        } else {
          console.warn('targeted call: render-retry still empty, keeping original result');
        }
      }
    } catch (retryErr) {
      console.warn('targeted render-retry failed (' + retryErr.message + '), keeping original result');
    }
  }

  return { data, status };
}

module.exports = {
  TARGETED_IMAGE_SCALE,
  TARGETED_FIELD_NAMES,
  TARGETED_FIELDS,
  targetedTool,
  TARGETED_PROMPT,
  buildTargetedContent,
  buildImageFallbackContent,
  trimStatusFor,
  isTargetedResultEmpty,
  mergeTargetedFields,
  runTargetedTrimCall
};
