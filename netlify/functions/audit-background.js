// netlify/functions/audit-background.js
//
// ============================================================================
// KEEVA INTAKE — Phase 1: holistic signature audit
// ============================================================================
// ONE Claude call over the WHOLE contract packet (RPA + counters + addenda).
// No cropping, no per-page fan-out, no schema. The model reads the entire
// document and reasons about it — the way a TC does, the way native Claude
// did in testing on the Stonewood 3-trustee + counter-offer packet.
//
// WHY THIS REPLACED THE OLD ENGINE: the previous audit-background.js made ~90
// anchored, cropped, single-slot vision calls and reconstructed an audit from
// fragments. It was unreliable — counting tiny initials on flattened PDFs is
// at the entropy limit. Testing showed native Claude, given the whole packet
// in one call, produces a categorically better audit (read all 3 trustees'
// initials, reasoned through the SMCO/BCO counter chain, caught QC issues).
// So the product is: automate that one holistic call, structure its output,
// make it mandatory. This file is that.
//
// ----------------------------------------------------------------------------
// TEST 2 — MODEL + THINKING ISOLATION (current change):
// The deployed pipeline confabulated on the 5.8 MB / 40-page Tigertail packet
// (false-positive "missing initials" on para 29, para 31, and RPA footers
// that were in fact initialed). Delivery was proven byte-clean (md5 match), so
// the bug is the prompt and/or the model+thinking config. The native-chat
// control that audited this packet correctly was Opus 4.7 with adaptive
// thinking; the pipeline was running claude-sonnet-4-20250514 with no
// thinking. This change matches the model side of that control ONLY — the
// prompt (buildAuditPrompt) is intentionally left exactly as-is so the
// model+thinking config is the single isolated variable under test.
// ----------------------------------------------------------------------------
//
// DESIGNED FOR THE FULL VISION (Phases 2-4):
// The output envelope below has `audit` populated now, and `extracted` +
// `reconciled` reserved (null in Phase 1). Phase 2 adds property/transaction
// extraction to the SAME call; Phase 3 adds counter-offer reconciliation
// (final acceptance date, final contingency dates, final price). The prompt
// and the envelope are structured so those slot in as ADDITIONS — no rewrite.
// ----------------------------------------------------------------------------
//
// Input contract (invocation body, from the orchestrator):
//   { jobId, buyerCount, sellerCount, sellerEntity?, buyerEntity? }
// The PDF is read from the audit-payloads blob store by jobId.
//
// Output (written to audit-results under jobId):
//   { status:'complete', result: { ...envelope } }
//
// ----------------------------------------------------------------------------
// ZAPIER FAN-OUT (added at end of success path):
// On successful audit completion, a fire-and-forget POST is sent to the
// audit Zapier catch-hook with a flat payload: property identity
// (property_address, apn) + the structured audit (overall_status, summary,
// findings_count, findings_text, prose). This feeds the 2nd Process Street
// workflow where Jill reviews signature audit findings, separate from the
// extraction workflow.
//
// property_address and apn are passed in by the orchestrator (pulled from
// the extraction result) so the audit's Zapier payload carries the SAME
// canonical strings the extractor's Zapier payload uses — that is what
// lets the two PS workflows be reconciled by property address downstream.
//
// Failure isolation: any error in the Zapier send is logged and swallowed.
// The audit result is already written to audit-results before the send —
// the webhook is a downstream notification, not the result. Failure does
// NOT mark the audit as errored. On audit FAILURE (error path) we do NOT
// send to Zapier in V1.
// ============================================================================

console.log('[audit-background] module loading (line 1)');

const { getStore } = require('@netlify/blobs');
console.log('[audit-background] @netlify/blobs loaded');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// TEST 2: swapped from 'claude-sonnet-4-20250514' to Opus 4.7 to match the
// native-chat control that audited the hard contract correctly. Opus 4.7 uses
// adaptive thinking (configured in callClaude); manual extended thinking
// ({ type:'enabled', budget_tokens }) is NOT accepted on this model and would
// return a 400.
const MODEL = 'claude-opus-4-7';

// Audit Zapier catch-hook URL. This is the 2nd Zapier webhook (separate from
// the extractor's RPA/RLA webhooks); it feeds the signature-audit Process
// Street workflow. Hardcoded to match the existing pattern for the extractor
// webhooks elsewhere in the codebase. To rotate: edit this constant and
// redeploy.
const AUDIT_ZAPIER_WEBHOOK_URL = 'https://hooks.zapier.com/hooks/catch/4252316/4bor90h/';

console.log('[audit-background] module fully loaded, handler ready');

function blobsConfig(name) {
  return {
    name,
    siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============================================================================
// THE PROMPT — this is the heart of the product. It replaces the entire old
// engine. It is the standardized, hardened version of the plain-English
// prompt that worked in native-chat testing.
//
// Design principle: REASONING FIRST, STRUCTURE SECOND. The model audits the
// document and writes its full analysis as prose (this is what makes it good
// -- free reasoning). THEN it emits a structured JSON block derived from its
// own reasoning. We never force rigid JSON in a way that chokes the analysis.
//
// NOTE: Test 2 (the model + adaptive-thinking swap) is confirmed across three
// runs -- the holistic audit reads the document reliably. The party-context
// construction below was then changed (see its inline comment): the seller
// authorized-signer roster is no longer fed to the audit, because an
// extraction-derived roster is a low-confidence guess that caused false
// "unaccounted-for signer" flags.
//
// TEST 3 -- PER-PAGE PASS + QC DE-SCOPE (current change, prompt only):
// The Westshire run produced a false hedge: seller per-page footer initials
// flagged "do not clearly appear" on RPA pages 4-14, when the "SL" DocuSign
// initials are in fact crisp on every footer. Root cause: in a single
// holistic read of a ~30-page packet the model never resolved the footer band
// hard enough, so it fell back on the hedge clause. The cropped/zoomed footer
// engine is NOT a fallback -- it was tried and never produced one clean
// contract; the holistic call is the only approach that works.
//
// Fix (prompt only -- no architecture change):
//  (a) The per-page-initials task is now an explicit page-by-page pass: the
//      model must walk every RPA page in order and state, per page, what is in
//      the buyer initial box and the seller initial box. Enumeration forces
//      the model to actually resolve each footer rather than glance past it.
//      Nothing is assumed -- a DocuSign envelope ID does NOT mean every initial
//      tab was completed; every page is checked on its own.
//  (b) The hedge clause is kept but re-scoped: hedging is permitted only AFTER
//      a genuine page-by-page pass and only on the SPECIFIC page that will not
//      resolve. A page-range hedge ("pages 4-14 unclear") is disallowed.
//  (c) QC ("note anything that looks off") is REMOVED from this prompt. Call A
//      is the perception pipeline -- signatures and initials, full stop. QC was
//      never perception: structural QC (blank fields) is the extractor's job;
//      interpretive QC (deal oddities) is Call B's job, where it already
//      happens. severity "qc_flag" is removed from the PART 2 enum accordingly.
//
// TEST 4 -- SIGNATURE PARITY + RPA 33A/33B BOX-STATE CHECKS (current change,
// prompt only):
// Two real-contract misses on real production audits drove this change:
//   (1) Canyon Lake Dr: RPA Section 33D Seller Signature was completely
//       blank. The audit said "fine because the counter offers were signed."
//       This was wrong. The RPA seller signature is ALWAYS required regardless
//       of counter offers; counters are additional documents, not substitutes.
//       The audit rationalized away a missing signature by mis-applying
//       counter-chain reasoning to signatures.
//   (2) Same packet: RPA Section 33A "Counter Offer attached" box was
//       unchecked even though an SCO was physically in the packet. The audit
//       missed this entirely -- it was treating the box-state question as out
//       of scope (per the Test 3 QC de-scope).
// Root cause for both: the previous prompt carried a "counter offer chain
// matters: the LAST accepted document governs ... a blank signature line on
// an earlier document may be CORRECT if the form instructs parties to sign
// the attached counter instead" clause. That clause is wrong as applied to
// SIGNATURES. The "last document governs" idea belongs in Phase 3
// (reconciliation of final price/dates) -- it does NOT belong in signature
// auditing. Signatures and initials are required per-document, per-party,
// per-page regardless of counter chains.
//
// Fix (prompt only -- no architecture change):
//  (a) The "counter chain governs signatures" clause is REMOVED in full.
//  (b) Replaced with the explicit SIGNATURE PARITY rule: wherever one party
//      signed/initialed on a document, every other required party must also
//      sign/initial that document. A counter is itself an additional document
//      requiring both parties' signatures, not a substitute for any
//      signature elsewhere. The RPA Section 32D Buyer Signature and Section
//      33D Seller Signature are ALWAYS required.
//  (c) Known one-sided advisories (AD with the side facing only its party,
//      BIA, BHIA, CCPA) are listed explicitly so the parity rule does not
//      cause false flags on intentionally one-sided forms.
// TEST 5 -- NAMED FORM-COMPLETENESS CHECKS + PACKET ORDERING CONVENTION
// (current change, prompt only):
// Production audits surfaced a category of misses the audit was not catching
// because completeness QC was deliberately out of scope after Test 3. The
// real-world misses included: RPA p1 with blank County/City/APN; counter
// offer headers with blank Date or "dated" fields; intermediate counters in
// a chain missing the "subject to attached counter offer #__" checkmark;
// entity-seller cases where 33B(2) entity name was filled but 33B(4)
// authorized-signer line was blank; and RPA Section 2B agency confirmation
// blocks with missing license numbers, agent names, or "is the broker of"
// checkboxes.
//
// These are not arbitrary QC. They are specific, recurring defects on real
// CA TC packets that the TC must run down before COE. The Test 3 decision
// to keep QC out of the audit ("structural QC is the extractor's job") was
// right in principle, but in practice the extractor only reads field values
// -- it does not flag MISSING field values, and it has no view of counter
// offers at all (counter completeness is structurally impossible for the
// extractor by design). So these checks were falling through the cracks.
//
// Fix (prompt only -- no architecture change):
//  (a) Five named completeness checks added to the in-scope list (N1-N5),
//      each tightly scoped to a specific named field or block. The model
//      flags each blank field as its own finding, severity "missing" by
//      default. License numbers are checked for PRESENCE only, not
//      correctness -- DRE-number validation is done elsewhere.
//  (b) PACKET ORDERING CONVENTION encoded in the prompt: packets are
//      assembled final-accepted-counter-on-top, descending the chain. The
//      first counter encountered in the packet is the operative/final one.
//      This is a guarantee from the team's packet-assembly workflow, not an
//      inference -- so the model can use packet order directly instead of
//      inferring chain order from counter numbers and dates (which can be
//      unreliable in cluttered packets).
//  (c) The scope-guardrail sentence at the end of the form-state-checks
//      block is widened to acknowledge the N1-N5 list and is even sharper
//      about what remains OUT of scope: "blank data fields elsewhere in the
//      packet (financing terms, contingency dates, dollar amounts, contact
//      details, etc.) are NOT in scope for this audit -- they are the
//      extractor's territory." This prevents N1-N5 from being a slippery
//      slope back into generalized QC.
//
// TEST 6 -- N2 ENUMERATED TRANSCRIPTION + DATE DISAMBIGUATION (current
// change, prompt only):
// The Santa Monica run (SCO #1 dated 5/31, property 1020 19th St #6) missed
// a blank top-right Date field on SCO #1. The audit prose read "Header is
// complete: Counter No. 1, dated 05/31/2026, property/buyer/seller lines
// all filled" -- the model demonstrably ran the N2 check but got the
// perception wrong by conflating two distinct date fields that share the
// word "date" in their labels.
//
// The two fields on a counter offer header that both look like "date":
//   (a) Top-right Date field on the form's first page -- when THIS counter
//       offer was issued. A separate labeled line in the top-right corner.
//   (b) The "dated [date]" reference inside the body sentence "This is a
//       counter offer to [the Offer], dated _______" -- when the document
//       being countered was dated.
// Conflating these two is exactly the Test 3 problem at smaller scale:
// open-ended checks ("verify the header is complete") get glance-summarized,
// the model says "looks complete" and moves on. The fix is the same trick
// that worked for the per-page initials pass: force ENUMERATED
// TRANSCRIPTION -- the model must write what it literally sees in each
// field, or write BLANK. A summary judgment is not allowed.
//
// Fix (prompt only -- no architecture change):
//  (a) N2 rewritten to require per-counter enumerated transcription. Each
//      field is named, the model transcribes its literal contents or writes
//      BLANK. Glance-summary ("header is complete") is explicitly
//      forbidden.
//  (b) The two date fields are disambiguated by their semantic role, not
//      just their physical location: the top-right Date captures when this
//      counter was issued; the in-sentence "dated" captures when the
//      countered document was dated. Both are required; one does NOT
//      satisfy the other.
// Scope of this change: N2 only. N1 (RPA p1) and N5 (Section 2B) have
// similar long named-field-list shapes but have not produced a miss yet --
// if and when they do, the same enumerated-transcription treatment can be
// applied to them in a future test iteration.
// ============================================================================
function buildAuditPrompt(params) {
  const { buyerCount, sellerCount, sellerEntity, buyerEntity } = params;

  // Party context -- the equivalent of "one buyer, one seller, one agent" that
  // made the native-chat prompt work.
  //
  // We feed only RELIABLE categorical facts: party counts per side, and whether
  // each side is an entity (+ its name). We deliberately do NOT feed a seller
  // authorized-signer roster, even though the handoff mapper still derives
  // sellerEntity.signerNames from extraction. That roster is a low-confidence
  // guess -- CAR seller printed-name slots are typically blank, so extraction
  // reads names off cursive DocuSign signatures. Feeding it as an authoritative
  // roster made the audit flag legitimate signers as "unaccounted for" whenever
  // extraction undercounted. The holistic audit reads signers straight from the
  // document -- that is the source of truth. The buyer side already works this
  // way (buyerEntity carries no signer roster).
  // V2-READY: when party context comes from the Brick 7 wizard as human-
  // confirmed input, a roster CAN be passed and treated as authoritative --
  // gate any future signer-roster clause on a "confirmed" flag, never on raw
  // extraction output.
  let partyContext = `This transaction has ${buyerCount} buyer(s) and ${sellerCount} seller(s), plus a buyer's agent and a listing agent.`;
  if (sellerEntity && sellerEntity.isEntity) {
    partyContext += ` The seller side is an entity${sellerEntity.entityName ? ` ("${sellerEntity.entityName}")` : ''}.`;
  }
  if (buyerEntity && buyerEntity.isEntity) {
    partyContext += ` The buyer side is an entity${buyerEntity.entityName ? ` ("${buyerEntity.entityName}")` : ''}.`;
  }

  return `You are an expert California real estate transaction coordinator performing a signature and initials audit on a contract packet at file-open.

${partyContext}

The packet may contain a Residential Purchase Agreement (RPA) plus counter offers (SCO, SMCO, BCO) and addenda. Read the ENTIRE packet and reason about it as a whole.

This is a signature and initials audit ONLY. Audit whether every required signature and initial is present. Do not report blank data fields, form-choice issues, or other quality-control observations -- those are out of scope for this audit.

YOUR TASK -- audit every required signature and initial across the WHOLE packet.

The core rule of this audit: SIGNATURE PARITY. On every document in the packet, wherever one party has signed, every other required party must also sign that document. Wherever one party has initialed, every other required party must also initial. The buyer side and the seller side mirror each other. A counter offer is an ADDITIONAL document in its own right and is itself subject to the same parity rule (both parties sign it) -- a signed counter does NOT replace or excuse any signature elsewhere in the packet.

Concretely:
- Per-page footer initials on the RPA. Do this as an explicit PAGE-BY-PAGE pass: go through every page of the RPA in order, and for EACH page state what you see in the Buyer's Initials box and what you see in the Seller's Initials box. Name the page, then the buyer box, then the seller box -- one line per page. Do not summarize a range of pages in a single statement; each page is inspected and reported on its own. If buyer initialed and seller did not (or the reverse), that is a missing initial -- flag it.
- The Liquidated Damages (paragraph 29) and Arbitration of Disputes (paragraph 31) initials -- both parties.
- The RPA Section 32D Buyer Signature block AND the RPA Section 33D Seller Signature block. The RPA seller signature on Section 33D is ALWAYS required regardless of counter offers, addenda, or anything else in the packet; counter offers are additional documents, not substitutes. Same for the buyer side on Section 32D.
- Buyer's Agent and Listing Agent signatures in the Real Estate Brokers Section (each agent signs their own block; agents do not mirror each other or the parties).
- Every signature and initial on every counter offer in the packet -- both parties sign every counter.
- Every signature and initial on every advisory and addendum in the packet -- by default both parties sign, with the limited exceptions listed below.
- For entity/trust sellers or buyers, confirm the authorized signer(s) signed.

KNOWN ONE-SIDED ADVISORIES (the parity rule does NOT apply to these; they are intentionally one-sided by form design):
- Agency Disclosure (AD) -- the buyer-side AD is signed by the buyer and the buyer's agent only; the seller line on a buyer-side AD is correctly unused. The seller-side AD is the mirror.
- Buyer's Investigation Advisory (BIA) -- buyer-only.
- Buyer Homeowners' Insurance Advisory (BHIA) -- buyer-only.
- California Consumer Privacy Act Advisory (CCPA) -- buyer-only (seller line is not used).
For these forms, do not flag the absent opposite-party signature.

ALSO AUDIT THESE FORM-STATE CHECKS ON THE RPA (not signatures themselves, but defects that change what is legally operative):
- RPA Section 33A acceptance state. If a Counter Offer (SCO/SMCO) or Back-Up Offer (BUO) is physically present in the packet, the corresponding box in 33A must be checked. If a counter is present but neither 33A box is checked, flag it (severity "missing") -- without the box checked the counter does not legally apply to the RPA, and the RPA on its face shows direct acceptance. Likewise, if a 33A box IS checked but no counter of that type is in the packet, flag it (severity "missing") -- the packet is incomplete.
- RPA Section 33B entity-seller box state. If an entity name is filled in on the entity-seller line (the "Full entity name" field in 33B) but the entity-seller box itself is unchecked, flag it (severity "missing"). Same parallel check for Section 32B on the buyer side.

ALSO AUDIT THESE FORM-COMPLETENESS CHECKS (named blank-field checks; flag every blank as a separate finding, severity "missing" unless noted):

PACKET ORDERING CONVENTION (use this for chain reasoning below): packets are assembled with the FINAL ACCEPTED counter on top, descending through the chain. For example, a packet ordered [BCO-1, SCO-1, RPA, advisories] means BCO-1 was the final accepted counter, written in response to SCO-1, which was written in response to the original RPA. The FIRST counter you encounter in the packet is the operative/final one; counters below it are earlier links in the chain. Use this packet order rather than counter numbers or dates to determine chain order.

(N1) RPA page 1 property identification fields. The top of RPA p1 must have ALL of:
  - Date Prepared
  - "THIS IS AN OFFER FROM" buyer name
  - Buyer entity-type checkbox (exactly one of: Individual(s), Corporation, Partnership, LLC, Other -- one MUST be checked; none checked is always wrong, even for individual buyers)
  - Property street address
  - City
  - County
  - ZIP
  - Assessor's Parcel Number (APN)
Flag each individual blank field as its own finding so the TC sees exactly which fields need filling.

(N2) Counter offer header completeness (every SCO, SMCO, BCO in the packet). Every counter offer in the packet has a header section that must be filled out completely. CRITICAL: do this as an explicit ENUMERATED TRANSCRIPTION PASS, one counter at a time, the same way you do the per-page initials pass. For each counter in the packet, write a labeled list and transcribe LITERALLY what you see in each field, OR write the word BLANK if the field is empty. Do not write "header is complete" or any other glance-summary in place of the enumeration. The act of transcribing each field's contents is what the check requires; a summary judgment is not a substitute.

For each counter offer in the packet, transcribe these fields:
  - Counter Offer No.: the number identifying which counter this is (top of page, after "COUNTER OFFER No.")
  - Date (top right corner of the first page): the date THIS counter offer itself was issued. This is a separate field in its own right, located at the top right of the page on its own line labeled "Date". Transcribe what you literally see in this top-right Date field, or write BLANK.
  - "This is a counter offer to..." reference checkbox: state which of the three checkboxes is checked, if any. The three options are: Purchase Agreement (the default, indicated by neither alternative box being checked) / Buyer Counter Offer No. (if checked, also transcribe the number filled into the field next to it) / Other (if checked, also transcribe what was written in the field next to it). Write which option applies.
  - "dated [date]" reference field: the date INSIDE the body sentence "This is a counter offer to the [Offer], dated _______". This date refers to WHEN THE DOCUMENT BEING COUNTERED WAS DATED -- it is NOT the same field as the top-right Date above. Transcribe what you literally see in this in-sentence "dated" field, or write BLANK.
  - Property: the property address line in the body
  - Buyer: the buyer name line in the body
  - Seller: the seller name line in the body

IMPORTANT -- the two dates are distinct: the top-right "Date" field captures when THIS counter offer was issued; the in-sentence "dated [date]" field captures the date of the document this counter is responding to. They are two separate required fields with similar labels. A filled "dated" reference does NOT satisfy the top-right Date, and vice versa. Both must be present. If the top-right Date is blank, that is a missing field even when the "dated" reference is filled (and vice versa).

After transcribing the fields for a counter, flag every field whose transcription was BLANK as a finding (severity "missing"), naming the specific counter and the specific field (e.g. "SCO #1 header: top-right Date field is blank").

(N3) Counter-of-counters chain integrity (Section 5 ACCEPTANCE box on earlier counters). Using the packet ordering convention above, identify the chain order. For every counter EXCEPT the final accepted one (the one on top of the packet), the "SUBJECT TO THE ATTACHED [Buyer/Seller] COUNTER OFFER No. ___" box in its Section 5 ACCEPTANCE must be checked, with the counter offer number filled in. If a counter in the chain has subsequent counters above it in packet order but its Section 5 subject-to-attached box is unchecked OR the number is blank, flag it (severity "missing"). The final accepted counter on top of the packet should NOT have this box checked -- that one is the terminal link.

(N4) Entity-party detail completeness when entity box is in play. If RPA Section 33B entity-seller box is checked OR an entity name appears on the 33B(2) full-entity-name line OR an authorized-signer name appears on the 33B(4) line (any one of these signals an entity seller is intended), then ALL of the following must be filled:
  - 33B box itself: checked
  - 33B(2) Full entity name
  - 33B(4) Legally Authorized Signer name(s)
Flag each blank as its own finding. Same parallel check on the buyer side for Section 32B / 32B(2) / 32B(4).

(N5) RPA Section 2B Agency Confirmation completeness. The Section 2B block must have ALL of:
  - Seller's Brokerage Firm name
  - Seller's Brokerage License Number
  - "Is the broker of" checkbox marked (one of: the Seller / both the Buyer and Seller)
  - Seller's Agent name
  - Seller's Agent License Number
  - Seller's Agent "Is (check one)" checkbox marked (one of: the Seller's Agent / both the Buyer's and Seller's Agent)
  - Buyer's Brokerage Firm name
  - Buyer's Brokerage License Number
  - "Is the broker of" checkbox marked (one of: the Buyer / both the Buyer and Seller)
  - Buyer's Agent name
  - Buyer's Agent License Number
  - Buyer's Agent "Is (check one)" checkbox marked (one of: the Buyer's Agent / both the Buyer's and Seller's Agent)
Flag each individual blank as its own finding. License numbers only need to be PRESENT, not validated for correctness -- numbers are verified separately against the DRE database, so do not attempt to judge whether a license number is real or correct, only whether the field is filled in.

The form-state checks above (33A box state, 32B/33B box states, and N1-N5) ARE in scope for this audit even though they are not signatures, because they directly determine what is legally operative or correctly assembled. Do not extend this license to other form-state checks beyond this explicit list. Blank data fields elsewhere in the packet (financing terms, contingency dates, dollar amounts, contact details, etc.) are NOT in scope for this audit -- they are the extractor's territory.

IMPORTANT REASONING GUIDANCE:
- The Escrow Holder Acknowledgment is normally blank at file-open -- that is expected, not a missing signature.
- Distinguish a genuine MISSING required signature/initial from something that is blank by design (known one-sided advisories above, unused second-signer lines when only one buyer or seller exists, Escrow Holder block at file-open).
- Do NOT use counter-offer existence to excuse any missing signature anywhere in the packet. Counter offers do not replace signatures on the RPA or on any other document; they are themselves additional documents that must be signed. If the RPA seller signature on Section 33D is blank, that is a missing signature -- period -- regardless of whether a signed counter is in the packet.
- Do NOT assume. An electronic-signature envelope ID stamped on the pages (e.g. a DocuSign Envelope ID) only proves the packet went through an e-sign platform -- it does NOT prove every initial tab or signature was completed. Check every page and every signature block on its own merits regardless of any envelope ID.
- You are reading rendered scanned pages; CAR forms scan messily. Hedging is a last resort, permitted ONLY after you have genuinely completed the page-by-page pass and signature-by-signature inspection, and ONLY for the specific individual page or signature line where a mark truly will not resolve. If you find yourself wanting to hedge a range of pages or a whole document, that means you have not done the inspection -- go back and inspect each one. Never flag a range of pages or a document as collectively unclear.

OUTPUT FORMAT -- two parts, in this order:

PART 1 -- Your full audit as prose. Write it the way you would explain it to the transaction coordinator: bottom line first, then a walk through each document in the packet. Include the explicit page-by-page initials pass. Be thorough and specific (cite paragraphs and pages).

PART 2 -- After the prose, on a new line, output exactly this marker:
===STRUCTURED===
followed by a single JSON object (no markdown fences) with this shape:
{
  "overall_status": "complete" | "issues_found" | "needs_review",
  "summary": "one-sentence plain-English bottom line",
  "findings": [
    {
      "location": "where, e.g. 'RPA p17 Real Estate Brokers Section' or 'BCO #1 para 4'",
      "issue": "what is missing or wrong",
      "severity": "missing" | "review",
      "detail": "one sentence of specifics"
    }
  ]
}
Rules for PART 2:
- "overall_status": "complete" if every required signature/initial is present and only normal-at-this-stage blanks remain; "issues_found" if a required signature/initial is genuinely missing; "needs_review" if you could not clearly determine something and a human must check.
- "findings": include every genuine missing signature/initial (severity "missing") and every spot you genuinely could not read after a real page-by-page inspection (severity "review"). If there are none, use an empty array.
- Each finding is ONE tight sentence in "detail". Do not write a paragraph.
- Per-page initials appear in "findings" ONLY as a specific named page that is genuinely missing or unreadable -- never as a page range, and never at all if the page-by-page pass found them present.
- This audit does not produce QC findings. Do not add findings for blank data fields, form-choice issues, or other non-signature observations.
- The JSON must be valid and parseable. PART 1 prose is the audit; PART 2 JSON is the machine-readable summary of it -- they must agree.`;
}

// ============================================================================
// THE OUTPUT ENVELOPE -- designed for the full vision.
// Phase 1 populates `audit`. `extracted` and `reconciled` are reserved (null)
// and get populated when Phases 2-3 widen the prompt. Keeping them in the
// envelope now means downstream consumers (the test page, later Keeva) have a
// stable shape to read against.
// ============================================================================
function buildEnvelope(auditPart) {
  return {
    phase: 1,
    audit: auditPart,        // { prose, structured } -- populated in Phase 1
    extracted: null,         // Phase 2: property/transaction fields
    reconciled: null,        // Phase 3: counter-offer final values
  };
}

// ----------------------------------------------------------------------------
// Flatten the structured audit + prose into the flat key/value payload the
// audit Zapier catch-hook receives. Each top-level key becomes its own Zap
// variable, mappable to PS form fields individually or concatenated into one
// text box at the Zap step.
//
// Property identity (property_address, apn) is placed at the TOP of the
// payload because PS uses these to join the audit row to the same
// transaction's extraction row. Empty strings are sent (not undefined) when
// the orchestrator did not have a value — keeps the payload shape stable.
//
// Defensive on structured=null (the model may not have emitted the
// ===STRUCTURED=== marker, or the JSON may not have parsed). In that case
// the prose is still sent -- the audit is never lost -- with overall_status
// downgraded to "needs_review" so Jill knows to lean on the prose.
// ----------------------------------------------------------------------------
function buildZapierPayload(jobId, auditPart, completedAtMs, propertyAddress, apn) {
  const prose = (auditPart && auditPart.prose) || '';
  const structured = auditPart && auditPart.structured;

  // Normal path: structured parsed cleanly.
  if (structured && typeof structured === 'object') {
    const findings = Array.isArray(structured.findings) ? structured.findings : [];
    const findingsText = findings
      .map((f) => {
        const sev = f && f.severity ? `[${f.severity}]` : '[review]';
        const loc = (f && f.location) || 'unspecified location';
        const iss = (f && f.issue) || 'unspecified issue';
        const det = f && f.detail ? ` ${f.detail}` : '';
        return `• ${sev} ${loc} — ${iss}.${det}`;
      })
      .join('\n');

    return {
      jobId: jobId,
      completedAt: new Date(completedAtMs).toISOString(),
      property_address: propertyAddress || '',
      apn: apn || '',
      overall_status: structured.overall_status || 'needs_review',
      summary: structured.summary || '',
      findings_count: findings.length,
      findings_text: findingsText,
      prose: prose,
    };
  }

  // Degraded path: structured missing/unparseable. Send prose + a clear
  // needs-review status so Jill works from the prose.
  return {
    jobId: jobId,
    completedAt: new Date(completedAtMs).toISOString(),
    property_address: propertyAddress || '',
    apn: apn || '',
    overall_status: 'needs_review',
    summary: 'Audit completed but structured summary could not be parsed -- see prose.',
    findings_count: 0,
    findings_text: '',
    prose: prose,
  };
}

// ----------------------------------------------------------------------------
// Fire-and-forget POST to the audit Zapier catch-hook. Awaits the dispatch
// so we know the request left, but never throws -- failure is logged and
// swallowed so a Zapier hiccup cannot corrupt or fail-mark a completed audit.
// The audit result is already written to audit-results before this runs.
// ----------------------------------------------------------------------------
async function sendToAuditZapier(jobId, payload) {
  try {
    const response = await fetch(AUDIT_ZAPIER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.warn(`[audit-background] jobId=${jobId} Zapier send returned status ${response.status} (non-fatal)`);
    } else {
      console.log(`[audit-background] jobId=${jobId} Zapier send dispatched (status ${response.status})`);
    }
  } catch (err) {
    console.error(`[audit-background] jobId=${jobId} Zapier send failed (non-fatal): ${err.message}`);
  }
}

exports.handler = async function (event) {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    console.error('[audit-background] invalid JSON body');
    return { statusCode: 400 };
  }

  const { jobId, buyerCount = 1, sellerCount = 1, sellerEntity, buyerEntity,
          propertyAddress = '', apn = '' } = body;
  if (!jobId) {
    console.error('[audit-background] missing jobId');
    return { statusCode: 400 };
  }

  // The PDF lives in audit-payloads (the orchestrator copied it there before
  // extraction ran -- the extractor deletes extraction-payloads on completion).
  const payloadStore = getStore(blobsConfig('audit-payloads'));
  const resultsStore = getStore(blobsConfig('audit-results'));

  let payload;
  try {
    payload = await payloadStore.get(jobId, { type: 'json' });
  } catch (err) {
    console.error(`[audit-background] jobId=${jobId} failed to read payload:`, err.message);
    await resultsStore.setJSON(jobId, {
      status: 'error', completedAt: Date.now(),
      error: `Failed to read payload: ${err.message}`,
    });
    return { statusCode: 500 };
  }
  if (!payload) {
    console.error(`[audit-background] jobId=${jobId} payload not found in audit-payloads`);
    await resultsStore.setJSON(jobId, {
      status: 'error', completedAt: Date.now(),
      error: 'Payload not found in audit-payloads store.',
    });
    return { statusCode: 404 };
  }

  const pdfBase64 = payload.documents && payload.documents[0] && payload.documents[0].data;
  if (!pdfBase64) {
    await resultsStore.setJSON(jobId, {
      status: 'error', completedAt: Date.now(),
      error: 'Payload had no PDF document.',
    });
    return { statusCode: 400 };
  }

  await resultsStore.setJSON(jobId, {
    status: 'pending', stage: 'audit', startedAt: Date.now(),
  });
  console.log(`[audit-background] jobId=${jobId} starting holistic audit (buyers=${buyerCount} sellers=${sellerCount})`);

  try {
    const prompt = buildAuditPrompt({ buyerCount, sellerCount, sellerEntity, buyerEntity });

    // ONE call. Whole PDF + the standardized prompt.
    const raw = await callClaude(prompt, pdfBase64);

    // Split PART 1 prose from the PART 2 structured JSON.
    const auditPart = parseAuditResponse(raw);

    const envelope = buildEnvelope(auditPart);

    const completedAt = Date.now();
    await resultsStore.setJSON(jobId, {
      status: 'complete',
      completedAt: completedAt,
      result: envelope,
    });
    console.log(`[audit-background] jobId=${jobId} complete -- overall_status=${auditPart.structured && auditPart.structured.overall_status}`);

    // ----- ZAPIER FAN-OUT (success path only; fully isolated) ---------------
    // Audit result is already persisted above. This is downstream notification.
    // sendToAuditZapier swallows all errors -- a webhook hiccup cannot fail
    // a completed audit.
    const zapierPayload = buildZapierPayload(jobId, auditPart, completedAt, propertyAddress, apn);
    await sendToAuditZapier(jobId, zapierPayload);

    return { statusCode: 200 };
  } catch (err) {
    console.error(`[audit-background] jobId=${jobId} ERROR:`, err.message);
    await resultsStore.setJSON(jobId, {
      status: 'error', completedAt: Date.now(),
      error: err.message,
    });
    // V1: no Zapier send on audit failure. The audit-results record carries
    // the error for the test page / future Keeva consumers.
    return { statusCode: 500 };
  }
};

// ----------------------------------------------------------------------------
// Split the model's response into { prose, structured }.
// PART 1 is everything before the ===STRUCTURED=== marker; PART 2 is the JSON
// after it. If the marker or JSON is missing/unparseable, we still return the
// prose (the audit is never lost) and flag structured as null so the UI can
// fall back to showing prose only.
// ----------------------------------------------------------------------------
function parseAuditResponse(raw) {
  const text = raw || '';
  const marker = '===STRUCTURED===';
  const idx = text.indexOf(marker);

  if (idx === -1) {
    console.warn('[audit-background] no ===STRUCTURED=== marker in response');
    return { prose: text.trim(), structured: null };
  }

  const prose = text.slice(0, idx).trim();
  let jsonPart = text.slice(idx + marker.length).trim();
  jsonPart = jsonPart.replace(/```json|```/g, '').trim();

  let structured = null;
  try {
    const m = jsonPart.match(/\{[\s\S]*\}/);
    structured = m ? JSON.parse(m[0]) : JSON.parse(jsonPart);
  } catch (e) {
    console.warn('[audit-background] structured JSON parse failed:', e.message);
    structured = null;
  }

  return { prose, structured };
}

// ----------------------------------------------------------------------------
// Anthropic call. Whole PDF as a document block + the prompt.
//
// Opus 4.7 with ADAPTIVE THINKING (Test 2): the model decides how much to
// reason before answering. effort='high' (the Opus 4.7 default and documented
// sweet spot) lives in output_config, NOT inside `thinking`. 'max' is avoided
// on purpose -- the docs warn it can cause overthinking on structured-output
// tasks, and this audit emits a JSON block.
//
// max_tokens is generous (32000) because adaptive thinking tokens are billed
// as output and count toward max_tokens -- the ceiling must cover thinking
// PLUS the substantial audit prose + JSON. You are billed only for tokens
// actually generated, so a high ceiling costs nothing extra; it only prevents
// truncation. The stop_reason guard below turns any remaining truncation into
// a loud failure instead of a silently partial audit.
//
// Retries on 429/529.
// ----------------------------------------------------------------------------
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
      // Raised from 8000 for Test 2: see header note above. Well within Opus
      // 4.7's 128k output limit; only billed for tokens actually generated.
      max_tokens: 32000,
      // Opus 4.7 requires adaptive thinking. display:'omitted' skips streaming
      // the thinking text (this is a server-to-server pipeline that never
      // surfaces it); the text-block filter below is unaffected by this.
      thinking: { type: 'adaptive', display: 'omitted' },
      // effort is a top-level output_config field (NOT nested in `thinking`).
      output_config: { effort: 'high' },
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

  if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter
      ? Math.min(parseFloat(retryAfter) * 1000, 30000)
      : Math.min(1000 * Math.pow(2, attempt), 30000);
    console.log(`[callClaude] ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
    return callClaude(prompt, pdfBase64, attempt + 1);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();

  // Truncation guard: with adaptive thinking, thinking tokens consume the same
  // budget as the response. If max_tokens were too small the audit would be
  // cut off mid-sentence and parseAuditResponse would still "succeed" on a
  // partial answer -- a silent bad audit. Fail loudly instead.
  if (data.stop_reason === 'max_tokens') {
    throw new Error(
      'Audit response hit max_tokens -- output was truncated before completion. ' +
      'Raise max_tokens in callClaude and re-run this job.'
    );
  }

  // Adaptive thinking returns thinking blocks before text blocks. We keep only
  // the text blocks (the prose audit + the ===STRUCTURED=== JSON); this filter
  // already ignores thinking blocks correctly.
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
