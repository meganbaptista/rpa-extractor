// netlify/functions/audit-background.js
//
// Background function — runs up to 15 minutes.
// Receives ONLY {jobId} in the request body. Reads PDF payload from the
// audit-payloads blob store, runs the audit, writes results to audit-results,
// deletes the payload when done.
//
// ---------------------------------------------------------------------------
// INFRASTRUCTURE NOTES (why this file looks the way it does):
//
// 1. pdf-parse 2.x needs the CanvasFactory polyfill (DOMMatrix/Path2D/etc).
//    Without it the module crashes at load time with "DOMMatrix is not
//    defined" — a 500 with zero logs. We import CanvasFactory from
//    'pdf-parse/worker' and pass it into every PDFParse constructor.
//
// 2. pdfjs-dist 5.x (bundled by pdf-parse) is ESM-only — there is no
//    legacy/build/pdf.js CommonJS file. We load the .mjs build via a lazy
//    dynamic import() the first time findAnchorPosition needs it.
//
// 3. Schemas are INLINED below, not require()'d from ./schemas/. Netlify
//    bundles each function in isolation and does not reliably include
//    sibling files — a cross-file require is a load-time crash.
//
// 4. Module-load checkpoint logs below: if the function ever fails to start,
//    the last checkpoint printed tells you exactly which import died.
// ---------------------------------------------------------------------------

console.log('[audit-background] module loading (line 1)');

const { PDFDocument } = require('pdf-lib');
console.log('[audit-background] pdf-lib loaded');

// pdf-parse 2.x: PDFParse class + CanvasFactory polyfill. CanvasFactory MUST
// be imported (and passed to every constructor) or pdf-parse crashes on load.
const { CanvasFactory } = require('pdf-parse/worker');
console.log('[audit-background] pdf-parse/worker (CanvasFactory) loaded');
const { PDFParse } = require('pdf-parse');
console.log('[audit-background] pdf-parse loaded');

const { getStore } = require('@netlify/blobs');
console.log('[audit-background] @netlify/blobs loaded');

// pdfjs-dist is ESM-only in the version pdf-parse bundles. We can't require()
// it from CommonJS; we load it lazily via dynamic import() and cache it.
// Only findAnchorPosition uses it (it needs per-text-item coordinates, which
// pdf-parse's getText() does not expose).
let _pdfjsLib = null;
async function getPdfjs() {
  if (!_pdfjsLib) {
    _pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return _pdfjsLib;
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

// --- Signature schemas (inlined — see infrastructure note 3 above) ----------
const SCHEMAS = {
  'CAR-RPA-1225': JSON.parse(`{
  "form_id": "CAR-RPA-1225",
  "form_name": "California Residential Purchase Agreement",
  "car_revision": "12/25",
  "active": true,
  "detection": {
    "footer_patterns": [
      "RPA REVISED 12/25",
      "RPA Revised 12/25",
      "32. OFFER",
      "PROPERTY ADDENDA AND ADVISORIES",
      "EXPIRATION OF OFFER",
      "Property Address:"
    ]
  },
  "typical_page_count": 17,
  "notes": "Page count varies by paragraphs and addenda included. All signature locations identified by text anchor, not page number, so the schema is resilient to CAR revisions, page reordering, brokerage page injection, and counter-offer appendages.",
  "audit_conventions": {
    "page_resolution": "Each signature_location specifies a page_anchor — text patterns that identify the target page(s). The runtime extracts text from each PDF page and matches anchors against extracted text. Anchors of type {any_of: [...]} match a page if any pattern appears on that page. Anchors of type {scope: 'all_form_pages', exclude_anchor: {...}} resolve to every page belonging to this form (via footer_patterns) minus pages matching the exclude_anchor.",
    "filter_by_present_parties": "Runtime only checks signatures for parties whose names exist in the extracted offer data. If only one buyer was extracted, all Buyer 2 lines are skipped (not flagged as missing). Same for Seller 2, Listing Agent on buyer-side-only files, etc.",
    "graceful_missing_line": "If the runtime cannot find the expected signature/initial/field line on a page (e.g., form variant), it returns 'not_applicable' rather than 'missing'.",
    "phase_filtering": "Runtime detects contract state by examining the seller signature block on the page anchored by 'Printed name of SELLER:': empty = 'offer_only' (audit only phase=buyer_offer); filled = 'fully_executed' (audit all phases); 'Seller Counter Offer' checkbox checked = 'counter_pending' (audit buyer side and check the attached SCO form for seller signatures).",
    "scenario_filtering": "Runtime detects entity scenarios during the same upfront detection call: (a) seller_is_entity if the Section 33B 'ENTITY SELLERS:' checkbox is checked OR the extracted seller name contains entity markers (LLC, Inc, Corp, Trust, etc.); (b) buyer_is_entity, same logic for Section 32B and buyer name. When entity scenario is active, signer names and entity name are extracted for downstream identity_match checks. Locations with scenario=null run regardless. Locations with scenario=seller_is_entity only run if seller is an entity.",
    "crop_box": "Optional per-location field. When present, the runtime renders only the specified sub-region of the page before sending to Claude vision, instead of the full page. Coordinates are normalized 0-1 against the page media box, with y measured from the TOP (y_pct_start=0 means top edge, y_pct_end=1 means bottom edge). Used to narrow vision attention to small targets like footer initial slots where full-page rendering loses the signal.",
    "mark_types": {
      "signature": "Handwritten signature glyph or DocuSign-style image stamp. A typed/printed name in the line area without an actual signature mark counts as absent.",
      "initial": "Handwritten initials or DocuSign initial stamp in the specified box.",
      "date": "Date value present in the date field.",
      "checkbox": "Checkbox marked with X, checkmark, or filled.",
      "filled_text": "Text field labeled per description contains any content (not blank). Content is not validated for correctness.",
      "identity_match": "For entity signatures: compare the visible signature mark against the extracted entity name and signer names. Returns matches_signer (correct), matches_entity (incorrect — flag), matches_other, or unclear."
    }
  },
  "signature_locations": [
    {
      "id": "footer_initials_buyer_side",
      "active": true,
      "description": "Buyer footer initial boxes (bottom-left of page footer) on every body page of the form",
      "page_anchor": {
        "scope": "all_form_pages",
        "exclude_anchor": { "any_of": ["Printed name of BUYER:"] }
      },
      "parties": ["Buyer 1", "Buyer 2"],
      "mark_type": "initial",
      "requirement": "always",
      "phase": "buyer_offer",
      "scenario": null,
      "condition": null,
     "crop_box": { "x_pct_start": 0.32, "x_pct_end": 0.63, "y_pct_start": 0.89, "y_pct_end": 0.96 },
      "notes": "Excludes the signature page (which has no footer initial line). Most common missing-sig source. Cropped region targets just the buyer footer initial slots to give vision a high-signal target instead of the full page."
    },
    {
      "id": "footer_initials_seller_side",
      "active": true,
      "description": "Seller footer initial boxes (bottom-right of page footer) on every body page of the form",
      "page_anchor": {
        "scope": "all_form_pages",
        "exclude_anchor": { "any_of": ["Printed name of BUYER:"] }
      },
      "parties": ["Seller 1", "Seller 2"],
      "mark_type": "initial",
      "requirement": "always",
      "phase": "seller_acceptance",
      "scenario": null,
      "condition": null,
      "crop_box": { "x_pct_start": 0.62, "x_pct_end": 0.92, "y_pct_start": 0.89, "y_pct_end": 0.96 },
      "notes": "Only audited once seller has signed OR Seller Counter Offer box is checked. Cropped region targets just the seller footer initial slots."
    },
    {
      "id": "buyer_signature_block",
      "description": "Buyer signature block in Section 32, labeled '(Signature) By,'",
      "page_anchor": { "any_of": ["Printed name of BUYER:"] },
      "parties": ["Buyer 1", "Buyer 2"],
      "mark_type": "signature",
      "requirement": "always",
      "phase": "buyer_offer",
      "scenario": null,
      "condition": null,
      "notes": ""
    },
    {
      "id": "buyer_signature_date",
      "description": "Date field next to each buyer signature in Section 32",
      "page_anchor": { "any_of": ["Printed name of BUYER:"] },
      "parties": ["Buyer 1", "Buyer 2"],
      "mark_type": "date",
      "requirement": "always",
      "phase": "buyer_offer",
      "scenario": null,
      "condition": null,
      "notes": ""
    },
    {
      "id": "seller_signature_block",
      "description": "Seller signature block in Section 33, labeled '(Signature) By,'",
      "page_anchor": { "any_of": ["Printed name of SELLER:"] },
      "parties": ["Seller 1", "Seller 2"],
      "mark_type": "signature",
      "requirement": "always",
      "phase": "seller_acceptance",
      "scenario": null,
      "condition": null,
      "notes": "If Seller Counter Offer box is checked on this page, seller may sign via the attached SCO form instead — runtime checks the SCO if present."
    },
    {
      "id": "seller_signature_date",
      "description": "Date field next to each seller signature in Section 33",
      "page_anchor": { "any_of": ["Printed name of SELLER:"] },
      "parties": ["Seller 1", "Seller 2"],
      "mark_type": "date",
      "requirement": "always",
      "phase": "seller_acceptance",
      "scenario": null,
      "condition": null,
      "notes": ""
    },
    {
      "id": "buyer_agent_signature_brokers_section",
      "description": "Buyer's Agent signature line in the 'Real Estate Brokers Section'",
      "page_anchor": { "any_of": ["REAL ESTATE BROKERS SECTION"] },
      "parties": ["Buyer Agent"],
      "mark_type": "signature",
      "requirement": "always",
      "phase": "buyer_offer",
      "scenario": null,
      "condition": null,
      "notes": "Often missed because the brokers section is separate from buyer/seller signature blocks."
    },
    {
      "id": "listing_agent_signature_brokers_section",
      "description": "Listing Agent signature line in the 'Real Estate Brokers Section'",
      "page_anchor": { "any_of": ["REAL ESTATE BROKERS SECTION"] },
      "parties": ["Listing Agent"],
      "mark_type": "signature",
      "requirement": "always",
      "phase": "seller_acceptance",
      "scenario": null,
      "condition": null,
      "notes": "On buyer-side-only files (no listing agent name extracted), this is skipped via filter_by_present_parties."
    },
    {
      "id": "final_page_initials_buyer_side",
      "description": "Buyer initials between the Real Estate Brokers Section and the Escrow Acknowledgment",
      "page_anchor": { "any_of": ["REAL ESTATE BROKERS SECTION", "ESCROW HOLDER ACKNOWLEDGMENT"] },
      "parties": ["Buyer 1", "Buyer 2"],
      "mark_type": "initial",
      "requirement": "always",
      "phase": "buyer_offer",
      "scenario": null,
      "condition": null,
      "notes": "Sandwiched between sections rather than at the page footer — easy to miss."
    },
    {
      "id": "final_page_initials_seller_side",
      "description": "Seller initials between the Real Estate Brokers Section and the Escrow Acknowledgment",
      "page_anchor": { "any_of": ["REAL ESTATE BROKERS SECTION", "ESCROW HOLDER ACKNOWLEDGMENT"] },
      "parties": ["Seller 1", "Seller 2"],
      "mark_type": "initial",
      "requirement": "always",
      "phase": "seller_acceptance",
      "scenario": null,
      "condition": null,
      "notes": ""
    },
    {
      "id": "liquidated_damages_initials_buyer",
      "description": "Buyer initials in Section 29 (Liquidated Damages)",
      "page_anchor": { "any_of": ["LIQUIDATED DAMAGES (By initialing"] },
      "parties": ["Buyer 1", "Buyer 2"],
      "mark_type": "initial",
      "requirement": "conditional",
      "phase": "buyer_offer",
      "scenario": null,
      "condition": "If buyer initials this clause, the parties have elected liquidated damages and seller initials become required.",
      "notes": "Commonly missed — initials are near the section header, not at the page footer."
    },
    {
      "id": "liquidated_damages_initials_seller",
      "description": "Seller initials in Section 29 (Liquidated Damages)",
      "page_anchor": { "any_of": ["LIQUIDATED DAMAGES (By initialing"] },
      "parties": ["Seller 1", "Seller 2"],
      "mark_type": "initial",
      "requirement": "conditional",
      "phase": "seller_acceptance",
      "scenario": null,
      "condition": "Required if buyer initialed liquidated_damages_initials_buyer.",
      "notes": ""
    },
    {
      "id": "arbitration_of_disputes_initials_buyer",
      "description": "Buyer initials in Section 31 (Arbitration of Disputes)",
      "page_anchor": { "any_of": ["ARBITRATION OF DISPUTES: A. The Parties"] },
      "parties": ["Buyer 1", "Buyer 2"],
      "mark_type": "initial",
      "requirement": "conditional",
      "phase": "buyer_offer",
      "scenario": null,
      "condition": "If buyer initials this clause, seller initials become required.",
      "notes": ""
    },
    {
      "id": "arbitration_of_disputes_initials_seller",
      "description": "Seller initials in Section 31 (Arbitration of Disputes)",
      "page_anchor": { "any_of": ["ARBITRATION OF DISPUTES: A. The Parties"] },
      "parties": ["Seller 1", "Seller 2"],
      "mark_type": "initial",
      "requirement": "conditional",
      "phase": "seller_acceptance",
      "scenario": null,
      "condition": "Required if buyer initialed arbitration_of_disputes_initials_buyer.",
      "notes": ""
    },
    {
      "id": "entity_buyer_checkbox",
      "description": "Section 32B 'ENTITY BUYERS:' checkbox",
      "page_anchor": { "any_of": ["ENTITY BUYERS:"] },
      "parties": ["Buyer 1"],
      "mark_type": "checkbox",
      "requirement": "conditional",
      "phase": "buyer_offer",
      "scenario": "buyer_is_entity",
      "condition": "Required when buyer is a non-individual entity (trust, corporation, LLC, partnership, etc.).",
      "notes": ""
    },
    {
      "id": "entity_buyer_full_name",
      "description": "Section 32B(2) 'Full entity name:' text field — must contain the entity's full legal name",
      "page_anchor": { "any_of": ["ENTITY BUYERS:"] },
      "parties": ["Buyer 1"],
      "mark_type": "filled_text",
      "requirement": "conditional",
      "phase": "buyer_offer",
      "scenario": "buyer_is_entity",
      "condition": "Required when buyer is an entity.",
      "notes": ""
    },
    {
      "id": "entity_buyer_signer_names",
      "description": "Section 32B(4)(B) 'The name(s) of the Legally Authorized Signer(s) is/are' text field(s)",
      "page_anchor": { "any_of": ["ENTITY BUYERS:"] },
      "parties": ["Buyer 1"],
      "mark_type": "filled_text",
      "requirement": "conditional",
      "phase": "buyer_offer",
      "scenario": "buyer_is_entity",
      "condition": "Required when buyer is an entity.",
      "notes": ""
    },
    {
      "id": "entity_buyer_legally_authorized_checkbox",
      "description": "Section 32D 'Printed Name of Legally Authorized Signer:' checkbox next to each buyer signature",
      "page_anchor": { "any_of": ["Printed name of BUYER:"] },
      "parties": ["Buyer 1", "Buyer 2"],
      "mark_type": "checkbox",
      "requirement": "conditional",
      "phase": "buyer_offer",
      "scenario": "buyer_is_entity",
      "condition": "Required when buyer is an entity — signals that the printed name is the legally authorized signer.",
      "notes": ""
    },
    {
      "id": "entity_buyer_title",
      "description": "Section 32D 'Title, if applicable' text field next to each buyer signature (e.g., 'Trustee', 'Managing Member', 'President')",
      "page_anchor": { "any_of": ["Printed name of BUYER:"] },
      "parties": ["Buyer 1", "Buyer 2"],
      "mark_type": "filled_text",
      "requirement": "conditional",
      "phase": "buyer_offer",
      "scenario": "buyer_is_entity",
      "condition": "Required when buyer is an entity.",
      "notes": ""
    },
    {
      "id": "entity_buyer_signature_identity",
      "description": "Verify the buyer signature glyph shows the human signer's name (e.g., 'Maria Fong'), not the entity name (e.g., 'Newkirk Family Trust')",
      "page_anchor": { "any_of": ["Printed name of BUYER:"] },
      "parties": ["Buyer 1", "Buyer 2"],
      "mark_type": "identity_match",
      "requirement": "conditional",
      "phase": "buyer_offer",
      "scenario": "buyer_is_entity",
      "condition": "Required when buyer is an entity — signature glyph must depict an authorized signer, not the entity itself.",
      "notes": "Runtime supplies entity_name and signer_names from scenario detection for comparison."
    },
    {
      "id": "entity_seller_checkbox",
      "description": "Section 33B 'ENTITY SELLERS:' checkbox",
      "page_anchor": { "any_of": ["ENTITY SELLERS:"] },
      "parties": ["Seller 1"],
      "mark_type": "checkbox",
      "requirement": "conditional",
      "phase": "seller_acceptance",
      "scenario": "seller_is_entity",
      "condition": "Required when seller is a non-individual entity (trust, corporation, LLC, partnership, etc.).",
      "notes": ""
    },
    {
      "id": "entity_seller_full_name",
      "description": "Section 33B(2) 'Full entity name:' text field — must contain the entity's full legal name",
      "page_anchor": { "any_of": ["ENTITY SELLERS:"] },
      "parties": ["Seller 1"],
      "mark_type": "filled_text",
      "requirement": "conditional",
      "phase": "seller_acceptance",
      "scenario": "seller_is_entity",
      "condition": "Required when seller is an entity.",
      "notes": ""
    },
    {
      "id": "entity_seller_signer_names",
      "description": "Section 33B(4)(B) 'The name(s) of the Legally Authorized Signer(s) is/are' text field(s)",
      "page_anchor": { "any_of": ["ENTITY SELLERS:"] },
      "parties": ["Seller 1"],
      "mark_type": "filled_text",
      "requirement": "conditional",
      "phase": "seller_acceptance",
      "scenario": "seller_is_entity",
      "condition": "Required when seller is an entity.",
      "notes": ""
    },
    {
      "id": "entity_seller_legally_authorized_checkbox",
      "description": "Section 33D 'Printed Name of Legally Authorized Signer:' checkbox next to each seller signature",
      "page_anchor": { "any_of": ["Printed name of SELLER:"] },
      "parties": ["Seller 1", "Seller 2"],
      "mark_type": "checkbox",
      "requirement": "conditional",
      "phase": "seller_acceptance",
      "scenario": "seller_is_entity",
      "condition": "Required when seller is an entity — signals that the printed name is the legally authorized signer.",
      "notes": ""
    },
    {
      "id": "entity_seller_title",
      "description": "Section 33D 'Title, if applicable' text field next to each seller signature (e.g., 'Trustee', 'Managing Member', 'President')",
      "page_anchor": { "any_of": ["Printed name of SELLER:"] },
      "parties": ["Seller 1", "Seller 2"],
      "mark_type": "filled_text",
      "requirement": "conditional",
      "phase": "seller_acceptance",
      "scenario": "seller_is_entity",
      "condition": "Required when seller is an entity.",
      "notes": ""
    },
    {
      "id": "entity_seller_signature_identity",
      "description": "Verify the seller signature glyph shows the human signer's name (e.g., 'Maria Fong'), not the entity name (e.g., 'Newkirk Family Trust')",
      "page_anchor": { "any_of": ["Printed name of SELLER:"] },
      "parties": ["Seller 1", "Seller 2"],
      "mark_type": "identity_match",
      "requirement": "conditional",
      "phase": "seller_acceptance",
      "scenario": "seller_is_entity",
      "condition": "Required when seller is an entity — signature glyph must depict an authorized signer, not the entity itself.",
      "notes": "Runtime supplies entity_name and signer_names from scenario detection for comparison."
    }
  ]
}
`),
  'AD-BUYER-1224': JSON.parse(`{
  "form_id": "AD-BUYER-1224",
  "form_name": "Disclosure Regarding Real Estate Agency Relationship (Buyer Side)",
  "car_revision": "12/24",
  "active": true,
  "detection": {
    "footer_patterns": ["AD REVISED 12/24"]
  },
  "typical_page_count": 2,
  "notes": "Buyer-side schema. Seller-side AD is handled by a separate schema (AD-SELLER-1224 — not yet built). All signatures are on the first page; page 2 contains only Civil Code text and the form has no entity-related fields.",
  "audit_conventions": {
    "page_resolution": "Each signature_location specifies a page_anchor — text patterns that identify the target page(s). The runtime extracts text from each PDF page and matches anchors against extracted text.",
    "filter_by_present_parties": "Runtime only checks signatures for parties whose names exist in the extracted offer data.",
    "graceful_missing_line": "If the runtime cannot find the expected line/field on a page, it returns 'not_applicable' rather than 'missing'.",
    "phase_filtering": "Not state-dependent on this form. Buyer and agent both sign at the same moment when the agent presents the form to the buyer, so all locations use phase=buyer_offer.",
    "scenario_filtering": "The AD form has no entity-specific fields, so no scenario filtering applies."
  },
  "signature_locations": [
    {
      "id": "buyer_signature_block",
      "description": "Buyer signature block on the acknowledgment page, in the section with the 'Buyer/Tenant' checkbox",
      "page_anchor": { "any_of": ["I/WE ACKNOWLEDGE RECEIPT OF A COPY OF THIS DISCLOSURE"] },
      "parties": ["Buyer 1", "Buyer 2"],
      "mark_type": "signature",
      "requirement": "always",
      "phase": "buyer_offer",
      "scenario": null,
      "condition": null,
      "notes": ""
    },
    {
      "id": "buyer_signature_date",
      "description": "Date field next to each buyer signature on the acknowledgment page",
      "page_anchor": { "any_of": ["I/WE ACKNOWLEDGE RECEIPT OF A COPY OF THIS DISCLOSURE"] },
      "parties": ["Buyer 1", "Buyer 2"],
      "mark_type": "date",
      "requirement": "always",
      "phase": "buyer_offer",
      "scenario": null,
      "condition": null,
      "notes": ""
    },
    {
      "id": "agent_signature_block",
      "description": "Agent signature on the acknowledgment page, above the line labeled 'Salesperson or Broker-Associate, if any'",
      "page_anchor": { "any_of": ["Salesperson or Broker-Associate, if any"] },
      "parties": ["Buyer Agent"],
      "mark_type": "signature",
      "requirement": "always",
      "phase": "buyer_offer",
      "scenario": null,
      "condition": null,
      "notes": "Watch for typed name vs actual signature glyph — a printed name in the line area without a signature mark should be flagged for review, not auto-cleared."
    },
    {
      "id": "agent_signature_date",
      "description": "Date field next to the buyer agent signature on the acknowledgment page",
      "page_anchor": { "any_of": ["Salesperson or Broker-Associate, if any"] },
      "parties": ["Buyer Agent"],
      "mark_type": "date",
      "requirement": "always",
      "phase": "buyer_offer",
      "scenario": null,
      "condition": null,
      "notes": ""
    }
  ]
}
`),
};
console.log('[audit-background] schemas inlined and parsed');
console.log('[audit-background] module fully loaded, handler ready');


function blobsConfig(name) {
  return {
    name,
    siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runWithConcurrencyLimit(items, fn, limit) {
  const results = new Array(items.length);
  const executing = new Set();

  for (let i = 0; i < items.length; i++) {
    const idx = i;
    const promise = fn(items[idx])
      .then((value) => ({ status: 'fulfilled', value }))
      .catch((reason) => ({ status: 'rejected', reason }))
      .finally(() => executing.delete(promise));

    executing.add(promise);
    results[idx] = promise;

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// ===== Handler =====

exports.handler = async function (event) {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    console.error('[audit-background] invalid JSON body');
    return { statusCode: 400 };
  }

  const { jobId } = body;
  if (!jobId) {
    console.error('[audit-background] missing jobId');
    return { statusCode: 400 };
  }

  // ===== PERMANENT BOUNDARY — shared payload store =====
  // The audit reads the PDF from `extraction-payloads`, the SAME blob store
  // the extractor's submit.js writes to, keyed by the SAME jobId. This is the
  // Keeva end-state pattern: one upload stores the PDF once; every analysis
  // stage (extraction, audit, compliance) reads it back by jobId. Do not
  // change this to a private store — the shared store IS the integration.
  //
  // Results are written to `audit-results` — a per-stage result store. Each
  // analysis stage keeps its own result record under the jobId; Keeva reads
  // each stage's results separately and composes the unified report.
  const payloadStore = getStore(blobsConfig('extraction-payloads'));
  const resultsStore = getStore(blobsConfig('audit-results'));

  // ===== PERMANENT BOUNDARY — audit input contract =====
  // Invocation body carries the audit PARAMETERS (small): the handoff mapper
  // computed these from the extraction result. The PDF itself is NOT in the
  // body — it's read from the shared extraction-payloads store by jobId.
  //   body: { jobId, formId, buyerCount, sellerCount, sellerEntity?, buyerEntity? }
  // This is the contract Keeva will call: store PDF once, then invoke the
  // audit with the jobId + the mapper's parameters.
  const {
    formId: bodyFormId,
    buyerCount: bodyBuyerCount,
    sellerCount: bodySellerCount,
    sellerEntity: bodySellerEntity,
    buyerEntity: bodyBuyerEntity,
  } = body;

  let payload;
  try {
    payload = await payloadStore.get(jobId, { type: 'json' });
  } catch (err) {
    console.error(`[audit-background] jobId=${jobId} failed to read payload:`, err.message);
    await resultsStore.setJSON(jobId, {
      status: 'error',
      completedAt: Date.now(),
      error: `Failed to read payload: ${err.message}`,
    });
    return { statusCode: 500 };
  }

  if (!payload) {
    console.error(`[audit-background] jobId=${jobId} payload not found in extraction-payloads store`);
    await resultsStore.setJSON(jobId, {
      status: 'error',
      completedAt: Date.now(),
      error: 'Payload not found in extraction-payloads store. Was the PDF uploaded via submit?',
    });
    return { statusCode: 404 };
  }

  // The shared payload stores the PDF as documents[] (extraction's submit.js
  // shape: { documents: [{ data, label }], prompt_override }). The audited
  // contract is the first document — same convention extraction uses.
  const pdfBase64 = payload.documents && payload.documents[0] && payload.documents[0].data;
  const formId = bodyFormId;
  const buyerCount = bodyBuyerCount || 1;
  const sellerCount = bodySellerCount || 1;

  await resultsStore.setJSON(jobId, {
    status: 'pending',
    startedAt: Date.now(),
    formId,
  });

  console.log(`[audit-background] jobId=${jobId} started for formId=${formId} buyers=${buyerCount} sellers=${sellerCount}`);

  try {
    if (!pdfBase64 || !formId) throw new Error('Payload missing pdfBase64 or formId');

    const schema = SCHEMAS[formId];
    if (!schema) throw new Error(`Schema not found: ${formId}`);

    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const totalPages = pdfDoc.getPageCount();
    console.log(`[audit-background] jobId=${jobId} pdf loaded: ${totalPages} pages`);

    const pageTexts = await extractAllPageTexts(pdfDoc);
    const formPages = detectFormPages(schema, pageTexts);

    if (formPages.length === 0) {
      await resultsStore.setJSON(jobId, {
        status: 'error',
        completedAt: Date.now(),
        error: 'No pages matched this form\'s footer_patterns.',
        totalPages,
        formPages: [],
      });
      console.log(`[audit-background] jobId=${jobId} no form pages matched`);
      await cleanupPayload(payloadStore, jobId);
      return { statusCode: 200 };
    }

    const detection = await detectStateAndScenarios(schema, pdfDoc, pageTexts, formPages);
    console.log(`[audit-background] jobId=${jobId} detection:`, detection);

    const checks = expandChecks(schema, pageTexts, formPages, detection, buyerCount, sellerCount);
    console.log(`[audit-background] jobId=${jobId} expanded to ${checks.length} checks`);

    const settled = await runWithConcurrencyLimit(
  checks,
  (c) => runCheck(pdfDoc, pdfBytes, c, detection),
  5 // max 5 Claude calls in-flight at once — tune up/down based on rate-limit headroom
);
    const results = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return { ...checks[i], status: 'error', error: r.reason?.message || String(r.reason) };
    });

    const output = {
      formId: schema.form_id,
      formName: schema.form_name,
      totalPages,
      formPages,
      partyCount: { buyers: buyerCount, sellers: sellerCount },
      detection,
      checksRun: checks.length,
      results,
      summary: summarize(results),
    };

    await resultsStore.setJSON(jobId, {
      status: 'complete',
      completedAt: Date.now(),
      result: output,
    });

    await cleanupPayload(payloadStore, jobId);
    console.log(`[audit-background] jobId=${jobId} complete, payload deleted`);
    return { statusCode: 200 };
  } catch (err) {
    console.error(`[audit-background] jobId=${jobId} ERROR:`, err.message);
    console.error(err.stack);
    await resultsStore.setJSON(jobId, {
      status: 'error',
      completedAt: Date.now(),
      error: err.message,
      stack: err.stack,
    });
    await cleanupPayload(payloadStore, jobId);
    return { statusCode: 500 };
  }
};

// ===== PERMANENT BOUNDARY — payload lifecycle =====
// No-op by design. The PDF payload lives in the SHARED extraction-payloads
// store, which extraction owns. Extraction's own submit/background flow plus
// the store's TTL handle deletion. The audit is a READER of that shared
// payload — it must never delete a blob it doesn't own, or it could destroy
// the PDF before another stage (compliance, or a re-run) needs it.
// Kept as a function (not removed) so existing call sites need no changes.
async function cleanupPayload(payloadStore, jobId) {
  // intentionally does nothing — see comment above
  return;
}

// ===== Text utilities =====

function normalize(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ===== Text extraction (with vision fallback) =====

async function extractAllPageTexts(pdfDoc) {
  const totalPages = pdfDoc.getPageCount();
  const promises = [];
  for (let i = 0; i < totalPages; i++) {
    promises.push(extractPageText(pdfDoc, i));
  }
  return Promise.all(promises);
}

async function extractPageText(pdfDoc, pageIndex) {
  let text = '';
  try {
    const singleDoc = await PDFDocument.create();
    const [copied] = await singleDoc.copyPages(pdfDoc, [pageIndex]);
    singleDoc.addPage(copied);
    const bytes = await singleDoc.save();
    // pdf-parse 2.x: construct PDFParse with the data + CanvasFactory polyfill,
    // then call getText(). The old 1.x `pdfParse(buffer)` function-call form
    // does not exist in 2.x.
    const parser = new PDFParse({ data: new Uint8Array(bytes), CanvasFactory });
    const result = await parser.getText();
    await parser.destroy();
    text = result.text || '';
  } catch (err) {
    console.error(`[extractPageText] page ${pageIndex + 1} pdf-parse FAILED:`, err.message);
  }

  if (text.trim().length < 50) {
    console.log(`[extractPageText] page ${pageIndex + 1}: pdf-parse blank, falling back to vision`);
    try {
      const pageBase64 = await singlePagePdfBase64(pdfDoc, pageIndex);
      const prompt = `Extract all visible text from this page of a real estate document. Return only the raw extracted text — preserve section headings, labels, field names, footer text, and any visible text content. Do not summarize, interpret, or add commentary. Do not describe images or signatures, just transcribe text.`;
      const visionText = await callClaude(prompt, pageBase64);
      console.log(`[extractPageText] page ${pageIndex + 1}: vision returned ${visionText.length} chars`);
      return visionText;
    } catch (err) {
      console.error(`[extractPageText] page ${pageIndex + 1} vision FAILED:`, err.message);
      return text;
    }
  }

  console.log(`[extractPageText] page ${pageIndex + 1}: pdf-parse ${text.length} chars`);
  return text;
}

// ===== Form-page detection =====

function detectFormPages(schema, pageTexts) {
  const patterns = (schema.detection && schema.detection.footer_patterns) || [];
  const normalizedPatterns = patterns.map(normalize);
  const formPages = [];

  pageTexts.forEach((text, i) => {
    const norm = normalize(text);
    if (normalizedPatterns.some((p) => norm.includes(p))) {
      formPages.push(i + 1);
    }
  });

  console.log(`[detectFormPages] strict match: ${formPages.length}/${pageTexts.length} pages`);

  const MIN_PAGES_THRESHOLD = 3;
  if (formPages.length < MIN_PAGES_THRESHOLD && pageTexts.length > MIN_PAGES_THRESHOLD) {
    console.log(`[detectFormPages] FALLBACK: treating all ${pageTexts.length} pages as form pages (text extraction likely unreliable)`);
    const allPages = [];
    for (let i = 0; i < pageTexts.length; i++) allPages.push(i + 1);
    return allPages;
  }

  console.log(`[detectFormPages] matched pages: ${JSON.stringify(formPages)}`);
  return formPages;
}

// ===== Anchor resolution =====

function resolveAnchor(anchor, pageTexts, formPages) {
  if (!anchor) return [];

  if (anchor.scope === 'all_form_pages') {
    let pages = [...formPages];
    if (anchor.exclude_anchor) {
      const excluded = resolveAnchor(anchor.exclude_anchor, pageTexts, formPages);
      pages = pages.filter((p) => !excluded.includes(p));
    }
    return pages;
  }

  if (anchor.any_of && Array.isArray(anchor.any_of)) {
    const normalizedPatterns = anchor.any_of.map(normalize);
    const matches = [];
    pageTexts.forEach((text, i) => {
      const page = i + 1;
      const norm = normalize(text);
      if (formPages.includes(page) && normalizedPatterns.some((p) => norm.includes(p))) {
        matches.push(page);
      }
    });
    return matches;
  }

  return [];
}

// ===== State + entity scenario detection =====

async function detectStateAndScenarios(schema, pdfDoc, pageTexts, formPages) {
  const hasSellerPhase = schema.signature_locations.some((loc) => loc.phase === 'seller_acceptance');
  const hasEntityScenarios = schema.signature_locations.some(
    (loc) => loc.scenario === 'buyer_is_entity' || loc.scenario === 'seller_is_entity'
  );

  if (!hasSellerPhase && !hasEntityScenarios) {
    return {
      state: 'all',
      buyer_is_entity: false,
      seller_is_entity: false,
      buyer_entity_name: null,
      buyer_signer_names: null,
      seller_entity_name: null,
      seller_signer_names: null,
    };
  }

  const sellerSigPages = resolveAnchor({ any_of: ['Printed name of SELLER:'] }, pageTexts, formPages);
  if (sellerSigPages.length === 0) {
    return {
      state: 'offer_only',
      buyer_is_entity: false,
      seller_is_entity: false,
      buyer_entity_name: null,
      buyer_signer_names: null,
      seller_entity_name: null,
      seller_signer_names: null,
    };
  }

  const sigPageIndex = sellerSigPages[0] - 1;
  const pageBase64 = await singlePagePdfBase64(pdfDoc, sigPageIndex);

  const prompt = `You are examining the signature page of a California Residential Purchase Agreement.

Determine ALL of the following from this single page and return as one JSON object:

1. CONTRACT STATE — examine the Seller signature block in Section 33:
   - seller_signed: Are seller signature lines filled with actual signatures (handwritten or DocuSign image stamps)? Boolean.
   - counter_offer_checked: Is the "Seller Counter Offer (C.A.R. Form SCO or SMCO)" checkbox in Section 33A checked? Boolean.

2. ENTITY DETECTION:
   - buyer_is_entity: Is the "ENTITY BUYERS:" checkbox in Section 32B checked? Boolean.
   - seller_is_entity: Is the "ENTITY SELLERS:" checkbox in Section 33B checked? Boolean.

3. ENTITY NAMES — only if respective entity flag is true; otherwise null:
   - buyer_entity_name: Text from Section 32B(2) "Full entity name:" field.
   - buyer_signer_names: Array of names from Section 32B(4)(B) "name(s) of the Legally Authorized Signer(s)".
   - seller_entity_name: Text from Section 33B(2) "Full entity name:" field.
   - seller_signer_names: Array of names from Section 33B(4)(B) "name(s) of the Legally Authorized Signer(s)".

Return ONLY this JSON object (no markdown fences, no other text):
{
  "seller_signed": true|false,
  "counter_offer_checked": true|false,
  "buyer_is_entity": true|false,
  "seller_is_entity": true|false,
  "buyer_entity_name": "..." or null,
  "buyer_signer_names": ["...", "..."] or null,
  "seller_entity_name": "..." or null,
  "seller_signer_names": ["...", "..."] or null
}`;

  try {
    const response = await callClaude(prompt, pageBase64);
    const parsed = parseJsonResponse(response);

    let state;
    if (parsed.seller_signed) state = 'fully_executed';
    else if (parsed.counter_offer_checked) state = 'counter_pending';
    else state = 'offer_only';

    return {
      state,
      buyer_is_entity: !!parsed.buyer_is_entity,
      seller_is_entity: !!parsed.seller_is_entity,
      buyer_entity_name: parsed.buyer_entity_name || null,
      buyer_signer_names: parsed.buyer_signer_names || null,
      seller_entity_name: parsed.seller_entity_name || null,
      seller_signer_names: parsed.seller_signer_names || null,
    };
  } catch (err) {
    console.error('Detection error:', err.message);
    return {
      state: 'offer_only',
      buyer_is_entity: false,
      seller_is_entity: false,
      buyer_entity_name: null,
      buyer_signer_names: null,
      seller_entity_name: null,
      seller_signer_names: null,
    };
  }
}

// ===== Check expansion =====

function expandChecks(schema, pageTexts, formPages, detection, buyerCount, sellerCount) {
  const checks = [];

 for (const loc of schema.signature_locations) {
    if (loc.active === false) continue;
    // Phase filtering removed — audits run post-acceptance, so all phases apply
    if (loc.scenario === 'buyer_is_entity' && !detection.buyer_is_entity) continue;
    if (loc.scenario === 'seller_is_entity' && !detection.seller_is_entity) continue;

    const pages = resolveAnchor(loc.page_anchor, pageTexts, formPages);
    if (pages.length === 0) continue;

    const presentParties = filterParties(loc.parties, buyerCount, sellerCount);

    for (const page of pages) {
      for (const party of presentParties) {
        checks.push({
          locationId: loc.id,
          locationDescription: loc.description,
          page,
          party,
          markType: loc.mark_type,
          requirement: loc.requirement,
          phase: loc.phase,
          scenario: loc.scenario,
          condition: loc.condition,
          cropBox: loc.crop_box || null,
          cropAnchor: loc.crop_anchor || null,
        });
      }
    }
  }

  return checks;
}

function filterParties(parties, buyerCount, sellerCount) {
  return parties.filter((p) => {
    const bm = p.match(/^Buyer (\d+)$/);
    if (bm) return parseInt(bm[1], 10) <= buyerCount;
    const sm = p.match(/^Seller (\d+)$/);
    if (sm) return parseInt(sm[1], 10) <= sellerCount;
    return true;
  });
}

// ===== Per-check execution =====

async function runCheck(pdfDoc, pdfBytes, check, detection) {
  let pageBase64;

  if (check.cropAnchor) {
    pageBase64 = await croppedPagePdfBase64ByAnchor(pdfDoc, pdfBytes, check.page - 1, check.cropAnchor);
    if (!pageBase64) {
      console.log(`[runCheck] ${check.locationId} page ${check.page} ${check.party}: anchor "${check.cropAnchor.text}" not found, returning not_applicable`);
      return {
        ...check,
        status: 'not_applicable',
        confidence: 'high',
        reasoning: `crop anchor text '${check.cropAnchor.text}' not found on page ${check.page}`,
      };
    }
    console.log(`[runCheck] ${check.locationId} page ${check.page} ${check.party}: using anchor crop "${check.cropAnchor.text}"`);
  } else if (check.cropBox) {
    pageBase64 = await croppedPagePdfBase64(pdfDoc, check.page - 1, check.cropBox);
    console.log(`[runCheck] ${check.locationId} page ${check.page} ${check.party}: using cropped region`);
  } else {
    pageBase64 = await singlePagePdfBase64(pdfDoc, check.page - 1);
  }

  const prompt = buildPrompt(check, detection);

    // TEMPORARY DEBUG — remove once footer cropping is validated
    const __debugLogClaude = check.locationId.startsWith('footer_initials_');
  try {
    const response = await callClaude(prompt, pageBase64);
    const parsed = parseJsonResponse(response);
    let status = parsed.status;
    let reasoning = parsed.reasoning;

    // Safety net: footer initials should not auto-fail as "absent" — vision
    // detection is unreliable on DocuSign-flattened PDFs where initials are
    // tiny, faint, or grayed out. Downgrade absent → unclear so a human
    // confirms rather than treating it as a real missing-sig flag.
    if (check.locationId.startsWith('footer_initials_') && status === 'absent') {
      status = 'unclear';
      reasoning = `[downgraded from absent — footer initial detection is unreliable on flattened PDFs] ${reasoning || ''}`;
    }

    if (__debugLogClaude) {
      console.log(`[FOOTER DEBUG] ${check.locationId} page ${check.page} ${check.party}: status=${status} confidence=${parsed.confidence} reasoning=${(reasoning || '').substring(0, 200)}`);
    }

    return {
      ...check,
      status,
      confidence: parsed.confidence,
      reasoning,
    };
  } catch (err) {
    return { ...check, status: 'error', error: err.message };
  }
}

function buildPrompt(check, detection) {
  const header = `You are auditing a single page of a California real estate contract.

LOCATION TO CHECK: ${check.locationDescription}
PARTY: ${check.party}
MARK TYPE: ${check.markType}
`;

  let body = '';
  let returnSchema = `{
  "status": "present" | "absent" | "unclear" | "not_applicable",
  "confidence": "high" | "medium" | "low",
  "reasoning": "one-sentence explanation of what you observed"
}`;

  switch (check.markType) {
    case 'signature':
      body = `Determine whether ${check.party}'s signature is present at the location described above.

GUIDANCE:
- Look for an actual handwritten signature OR a DocuSign-style image stamp.
- A typed/printed name in the signature line area WITHOUT an actual signature glyph is NOT a signature — that is "absent".
- If the expected line is NOT VISIBLE on this page, return "not_applicable".
- Bias toward flagging. If unsure, return "unclear" — never default to "present" when uncertain.`;
      break;

    case 'initial': {
  const isFooterInitial = check.locationId.startsWith('footer_initials_');
  if (isFooterInitial) {
    body = `Examine this page for ${check.party}'s footer initial content.

ABOUT THE FOOTER INITIAL AREA:
- Located at the bottom of the page, near the form revision date.
- "Buyer's Initials" typically shows two side-by-side slots: ___ / ___. First slot is Buyer 1, second slot is Buyer 2.
- "Seller's Initials" follows the same layout: first slot Seller 1, second slot Seller 2.
- DocuSigned initials may appear small, faint, lightly rendered, or in light gray — but they are visible inside the slot as actual letters or a stamp image.

YOUR TASK: Determine whether the SPECIFIC SLOT FOR ${check.party} contains initial content. Evaluate only ${check.party}'s slot — do NOT base your answer on the other party's slot.

STATUS DEFINITIONS:
- "present" — ${check.party}'s slot clearly contains initial content (handwritten letters, typed initials, or a DocuSign-style stamp). Faint or lightly rendered content still counts as present.
- "absent" — ${check.party}'s slot is empty. The slot outline and any underline are visible, but no initial content has been placed inside. An empty slot is absent regardless of whether OTHER parties have initialed.
- "unclear" — you can locate ${check.party}'s slot but cannot determine whether content is present versus rendering artifacts.
- "not_applicable" — no footer initial area is visible on this page.

Be precise about which slot you are evaluating. The position matters. An initial in Buyer 1's slot does not mean Buyer 2's slot is also initialed.`;
  } else {
    body = `Determine whether ${check.party}'s initials are present at the location described above.

GUIDANCE:
- Look for handwritten initials OR a DocuSign initial stamp in the specified box.
- If the expected box is NOT VISIBLE on this page, return "not_applicable".
- Bias toward flagging. If unsure, return "unclear".`;
  }
  break;
}

    case 'date':
      body = `Determine whether a date value is present at the date field for ${check.party}'s signature/initial.

GUIDANCE:
- Look for any date format (MM/DD/YYYY, M/D/YY, written date, etc.).
- The date should be next to or associated with ${check.party}'s signature or initial.
- If the date field is NOT VISIBLE on this page, return "not_applicable".`;
      break;

    case 'checkbox':
      body = `Determine whether the specific checkbox described above is marked.

GUIDANCE:
- A marked checkbox has an X, checkmark, filled box, or similar marking.
- An empty/blank checkbox is "absent".
- If the checkbox is NOT VISIBLE on this page, return "not_applicable".`;
      break;

    case 'filled_text':
      body = `Determine whether the specific text field described above contains any content.

GUIDANCE:
- Any non-blank content in the field counts as "present" — we are not validating correctness.
- An empty/blank field is "absent".
- If the field is NOT VISIBLE on this page, return "not_applicable".
- Include the extracted content in your reasoning if present.`;
      break;

    case 'identity_match': {
      const isBuyerScenario = check.scenario === 'buyer_is_entity';
      const entityName = isBuyerScenario ? detection.buyer_entity_name : detection.seller_entity_name;
      const signerNames = isBuyerScenario ? detection.buyer_signer_names : detection.seller_signer_names;
      const signerList = signerNames && signerNames.length ? signerNames.map((n) => `"${n}"`).join(', ') : 'unknown';

      body = `The signing party is an ENTITY. The signature glyph must show a HUMAN signer's name, NOT the entity name itself. Common error: agents sign the entity name as the signature glyph instead of the authorized signer's name.

CONTEXT FROM THIS CONTRACT:
- Entity name: "${entityName || 'unknown'}"
- Authorized signer name(s): ${signerList}

Examine the visible signature for ${check.party} at the described location. Compare what the signature glyph appears to depict against the entity name and the authorized signer names listed above.

POSSIBLE STATUS VALUES:
- "matches_signer" — signature glyph shows one of the authorized signer names (CORRECT)
- "matches_entity" — signature glyph shows the entity name itself (INCORRECT — must be flagged)
- "matches_other" — signature shows a name not in the authorized signer list
- "unclear" — signature is unreadable, ambiguous, or absent
- "not_applicable" — no signature visible at this location`;
      returnSchema = `{
  "status": "matches_signer" | "matches_entity" | "matches_other" | "unclear" | "not_applicable",
  "confidence": "high" | "medium" | "low",
  "reasoning": "one-sentence explanation, including what name the signature appears to depict"
}`;
      break;
    }

    default:
      body = `Determine whether ${check.party}'s mark is present at the location described above. If uncertain, return "unclear".`;
  }

  return `${header}
${body}

Return ONLY a JSON object with this exact structure (no markdown code fences, no other text):
${returnSchema}`;
}

// ===== PDF helpers =====

async function singlePagePdfBase64(sourceDoc, pageIndex) {
  const newDoc = await PDFDocument.create();
  const [copied] = await newDoc.copyPages(sourceDoc, [pageIndex]);
  newDoc.addPage(copied);
  const bytes = await newDoc.save();
  return Buffer.from(bytes).toString('base64');
}

// Find the position of a text anchor on a specific page using pdfjs-dist.
// Returns { x, y, width, height, pageWidth, pageHeight } in PDF points
// (origin bottom-left, y increases upward), or null if anchor not found.
// Handles cases where anchor text is split across multiple PDF text items
// on the same line; respects line breaks (won't combine across lines).
async function findAnchorPosition(pdfBytes, pageIndex, anchorText, matchIndex = 0) {
  const normalize = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const target = normalize(anchorText);
  if (!target) return null;

  let pdfDoc;
  try {
    // pdfjs-dist 5.x is ESM-only; loaded lazily via dynamic import and cached.
    const pdfjsLib = await getPdfjs();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBytes),
      disableWorker: true,
      isEvalSupported: false,
      verbosity: 0,
    });
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    console.error(`[findAnchorPosition] page ${pageIndex + 1} pdfjs load failed:`, err.message);
    return null;
  }

  try {
    const page = await pdfDoc.getPage(pageIndex + 1);
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });
    const items = textContent.items || [];

    const matches = [];

    for (let start = 0; start < items.length; start++) {
      const startItem = items[start];
      if (!startItem || !startItem.str) continue;

      let combined = startItem.str;
      let lastItem = startItem;

      if (normalize(combined).includes(target)) {
        matches.push(buildBox(startItem, lastItem));
      } else {
        for (let end = start + 1; end < items.length; end++) {
          if (items[end - 1].hasEOL) break;
          combined += ' ' + (items[end].str || '');
          lastItem = items[end];
          const norm = normalize(combined);
          if (norm.includes(target)) {
            matches.push(buildBox(startItem, lastItem));
            break;
          }
          if (norm.length > target.length + 20) break;
        }
      }
    }

    function buildBox(firstItem, lastItem) {
      const x = firstItem.transform[4];
      const y = firstItem.transform[5];
      const height = firstItem.height || Math.abs(firstItem.transform[3]) || 10;
      const endX = lastItem.transform[4] + (lastItem.width || 0);
      const width = Math.max(endX - x, firstItem.width || 0);
      return { x, y, width, height };
    }

    const match = matches[matchIndex];
    if (!match) {
      console.log(`[findAnchorPosition] page ${pageIndex + 1} "${anchorText}" NOT FOUND (${matches.length} match candidates)`);
      return null;
    }

    console.log(`[findAnchorPosition] page ${pageIndex + 1} "${anchorText}" found at x=${match.x.toFixed(1)} y=${match.y.toFixed(1)} w=${match.width.toFixed(1)} h=${match.height.toFixed(1)}`);
    return {
      ...match,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
    };
  } catch (err) {
    console.error(`[findAnchorPosition] page ${pageIndex + 1} extraction failed:`, err.message);
    return null;
  } finally {
    try { await pdfDoc.cleanup(); } catch (_) {}
    try { await pdfDoc.destroy(); } catch (_) {}
  }
}

// Produces a single-page PDF cropped to a region defined RELATIVE to a text
// anchor's position. Offsets are in inches, measured from the anchor's
// TOP-LEFT corner (negative values extend above/left of the anchor).
// Returns base64-encoded PDF bytes, or null if the anchor wasn't found
// (caller decides fallback behavior).
async function croppedPagePdfBase64ByAnchor(sourceDoc, sourcePdfBytes, pageIndex, cropAnchor) {
  const anchorPos = await findAnchorPosition(
    sourcePdfBytes,
    pageIndex,
    cropAnchor.text,
    cropAnchor.match_index || 0
  );
  if (!anchorPos) return null;

  // Anchor in screen coords (origin top-left, y increases down)
  const anchorScreenLeft = anchorPos.x;
  const anchorScreenTop = anchorPos.pageHeight - anchorPos.y - anchorPos.height;

  const inchesToPts = (inches) => inches * 72;
  const off = cropAnchor.offset_in || {};

  const cropScreenLeft = anchorScreenLeft + inchesToPts(off.x_start || 0);
  const cropScreenRight = anchorScreenLeft + inchesToPts(off.x_end || 0);
  const cropScreenTop = anchorScreenTop + inchesToPts(off.y_start || 0);
  const cropScreenBottom = anchorScreenTop + inchesToPts(off.y_end || 0);

  // Convert back to PDF coords (origin bottom-left)
  const cropPdfX = cropScreenLeft;
  const cropPdfY = anchorPos.pageHeight - cropScreenBottom;
  const cropPdfWidth = cropScreenRight - cropScreenLeft;
  const cropPdfHeight = cropScreenBottom - cropScreenTop;

  if (cropPdfWidth <= 0 || cropPdfHeight <= 0) {
    console.error(`[croppedByAnchor] invalid crop dimensions for "${cropAnchor.text}": w=${cropPdfWidth} h=${cropPdfHeight}`);
    return null;
  }

  const newDoc = await PDFDocument.create();
  const [copied] = await newDoc.copyPages(sourceDoc, [pageIndex]);
  newDoc.addPage(copied);

  copied.setMediaBox(cropPdfX, cropPdfY, cropPdfWidth, cropPdfHeight);
  copied.setCropBox(cropPdfX, cropPdfY, cropPdfWidth, cropPdfHeight);

  const bytes = await newDoc.save();
  return Buffer.from(bytes).toString('base64');
}


// Produces a single-page PDF cropped to a sub-region of the source page.
// cropBox uses normalized 0-1 coordinates with y measured from the TOP of the
// page (y_pct_start=0 = top edge, y_pct_end=1 = bottom edge). pdf-lib's
// internal coordinate system has its origin at the bottom-left, so we flip
// the y axis when computing the box.
//
// We set BOTH the media box and the crop box to the target region. Setting
// the media box physically shrinks the page so content outside the region
// has nowhere to render; setting the crop box explicitly directs renderers
// to display only this region. Either alone would likely suffice for
// Claude's vision rasterization, but using both removes the guesswork.
async function croppedPagePdfBase64(sourceDoc, pageIndex, cropBox) {
  const newDoc = await PDFDocument.create();
  const [copied] = await newDoc.copyPages(sourceDoc, [pageIndex]);
  newDoc.addPage(copied);

  const { width, height } = copied.getSize();
  const cropX = cropBox.x_pct_start * width;
  const cropY = (1 - cropBox.y_pct_end) * height;
  const cropWidth = (cropBox.x_pct_end - cropBox.x_pct_start) * width;
  const cropHeight = (cropBox.y_pct_end - cropBox.y_pct_start) * height;

  copied.setMediaBox(cropX, cropY, cropWidth, cropHeight);
  copied.setCropBox(cropX, cropY, cropWidth, cropHeight);

  const bytes = await newDoc.save();
  return Buffer.from(bytes).toString('base64');
}

// ===== Claude API =====

async function callClaude(prompt, pdfBase64, attempt = 0) {
  const MAX_RETRIES = 4;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var not set');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  });

  // Retryable: 429 (rate limited) and 529 (overloaded)
  if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter
      ? Math.min(parseFloat(retryAfter) * 1000, 30000)
      : Math.min(1000 * Math.pow(2, attempt), 30000); // 1s → 2s → 4s → 8s, capped at 30s
    console.log(`[callClaude] ${response.status} received, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
    return callClaude(prompt, pdfBase64, attempt + 1);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}
function parseJsonResponse(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// ===== Summary =====

function summarize(results) {
  const summary = {
    present: 0,
    absent: 0,
    unclear: 0,
    not_applicable: 0,
    error: 0,
    matches_signer: 0,
    matches_entity: 0,
    matches_other: 0,
    missingItems: [],
    flaggedItems: [],
  };

  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;

    if (r.status === 'absent' || r.status === 'unclear') {
      summary.missingItems.push({
        page: r.page,
        party: r.party,
        markType: r.markType,
        locationId: r.locationId,
        status: r.status,
        confidence: r.confidence,
        reasoning: r.reasoning,
      });
    }

    if (r.status === 'matches_entity' || r.status === 'matches_other') {
      summary.flaggedItems.push({
        page: r.page,
        party: r.party,
        markType: r.markType,
        locationId: r.locationId,
        status: r.status,
        confidence: r.confidence,
        reasoning: r.reasoning,
      });
    }
  }

  return summary;
}
