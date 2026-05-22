// netlify/functions/handoff-mapper.js
//
// ============================================================================
// PERMANENT BOUNDARY — extraction → audit handoff
// ============================================================================
// This module is NOT validation scaffolding. It is the real integration seam
// between the extraction stage and the signature-audit stage, and it is the
// code Keeva will use in the single-upload end-state.
//
// Input:  an extraction result object (the 50-field JSON the extractor emits)
//         + the raw PDF page texts (for form classification)
// Output: { formId, buyerCount, sellerCount, sellerEntity, buyerEntity,
//           derivation }  — the parameters the audit engine needs
//
// Three jobs, each documented inline below:
//   1. Form classification  — extraction does NOT emit a formId; we derive it
//   2. Party counts         — seller count is deterministic; buyer is best-effort
//   3. Entity scenario      — map trust/entity info into the audit's shape
//
// The `derivation` field in the output records HOW each value was determined
// and a confidence flag, so the validation test page can show the operator
// what to trust and the manual override knows what to pre-fill.
//
// MIGRATION NOTE: form classification currently lives here, reusing the audit's
// footer-pattern logic. Long-term it should move into the extraction stage
// (extraction already reads the PDF; it should report what form it is). The
// interface here is kept clean so that move is a lift-and-shift later.
// ============================================================================

// Footer-pattern → formId map. Mirrors the `detection.footer_patterns` in each
// audit schema. When a new form schema is added to the audit, add its footer
// patterns here too. (In the Keeva end-state this table and the schema
// detection block become one shared source of truth.)
const FORM_DETECTION = [
  {
    formId: 'CAR-RPA-1225',
    // Strong, revision-specific markers first; generic markers are weaker.
    footerPatterns: ['rpa revised 12/25'],
    weakPatterns: [
      'california residential purchase agreement',
      'joint escrow instructions',
    ],
  },
  {
    formId: 'AD-BUYER-1224',
    footerPatterns: ['ad revised 12/24'],
    weakPatterns: [
      'disclosure regarding real estate agency relationship',
    ],
  },
];

function normalize(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// --- Job 1: Form classification --------------------------------------------
// Extraction emits no formId. We classify by scanning the PDF's page texts for
// each form's footer patterns — the SAME footer-pattern approach the audit's
// own detectFormPages uses, kept consistent on purpose.
//
// Returns { formId, confidence, reason }. confidence:
//   'high'   — a revision-specific footer pattern matched
//   'low'    — only a weak/generic pattern matched (operator should verify)
//   'none'   — nothing matched; operator MUST pick the form via override
function classifyForm(pageTexts) {
  const allText = normalize((pageTexts || []).join(' '));

  for (const form of FORM_DETECTION) {
    for (const p of form.footerPatterns) {
      if (allText.includes(normalize(p))) {
        return { formId: form.formId, confidence: 'high', reason: `matched footer pattern "${p}"` };
      }
    }
  }
  // No strong match — try weak patterns, but flag low confidence.
  for (const form of FORM_DETECTION) {
    for (const p of form.weakPatterns || []) {
      if (allText.includes(normalize(p))) {
        return { formId: form.formId, confidence: 'low', reason: `matched only weak pattern "${p}" — verify` };
      }
    }
  }
  return { formId: null, confidence: 'none', reason: 'no form footer pattern matched — operator must select form' };
}

// --- Job 2a: Seller count (deterministic) ----------------------------------
// Extraction splits sellers into numbered slots seller_1..seller_4. The count
// is simply how many are non-empty. This is reliable — no parsing guesswork.
function deriveSellerCount(extraction) {
  let count = 0;
  for (let i = 1; i <= 4; i++) {
    const v = extraction['seller_' + i];
    if (v && String(v).trim()) count++;
  }
  if (count === 0) {
    // Fallback: extraction gave no numbered slots. Fall back to parsing the
    // seller_names string the same way buyers are parsed.
    const parsed = parseNameCount(extraction.seller_names);
    return { count: parsed.count || 1, confidence: 'low', reason: 'no seller_N slots; parsed from seller_names' };
  }
  return { count, confidence: 'high', reason: `counted ${count} non-empty seller_N slot(s)` };
}

// --- Job 2b: Buyer count (best-effort — the soft spot) ----------------------
// There are no numbered buyer_N slots in the extraction output, only the
// buyer_names string. We parse it, stripping known real-estate boilerplate
// that must NOT be counted as a party.
//
// This is the value most likely to be wrong — the manual override on the test
// page exists primarily to correct THIS. Confidence is never 'high'.
function deriveBuyerCount(extraction) {
  const parsed = parseNameCount(extraction.buyer_names);
  return {
    count: parsed.count || 1,
    confidence: parsed.count ? 'medium' : 'low',
    reason: parsed.reason,
  };
}

// Shared name-string → count parser. Strips boilerplate, then counts the
// parties separated by real conjunctions.
function parseNameCount(rawNames) {
  const raw = (rawNames || '').trim();
  if (!raw) return { count: 0, reason: 'name string was empty' };

  let s = ' ' + raw.toLowerCase() + ' ';

  // Strip real-estate boilerplate phrases that are NOT additional parties.
  // "and/or assignee", "et al", "or assignee", "a married man/woman", etc.
  const boilerplate = [
    /\band\/or\s+assignee[s]?\b/g,
    /\bor\s+assignee[s]?\b/g,
    /\band\/or\s+nominee[s]?\b/g,
    /\bet\s+al\.?\b/g,
    /\b,?\s*an?\s+(un)?married\s+(man|woman|person)\b/g,
    /\b,?\s*a\s+single\s+(man|woman|person)\b/g,
    /\b,?\s*trustee[s]?\b/g,
    /\(te\)/g,
  ];
  for (const re of boilerplate) s = s.replace(re, ' ');

  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return { count: 1, reason: 'only boilerplate found — assuming 1 party' };

  // Split on real conjunctions / separators between parties.
  const parts = s
    .split(/\s+and\s+|\s*&\s*|\s*;\s*|\s*,\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length > 1); // drop empty / single-char fragments

  const count = Math.max(1, parts.length);
  return {
    count,
    reason: `parsed ${count} party name(s) from "${rawNames}" after stripping boilerplate`,
  };
}

// --- Job 3: Entity scenario -------------------------------------------------
// The audit's RPA schema has seller_is_entity / buyer_is_entity scenarios that
// need the entity name and the authorized-signer names. Extraction already
// pulls these (seller_type, seller_entity_name, seller_signer_1..4). We map
// them into the shape the audit engine expects.
function deriveSellerEntity(extraction) {
  const type = normalize(extraction.seller_type);
  const entityMarkers = ['trust', 'llc', 'inc', 'corp', 'corporation', 'partnership', 'estate', 'company'];
  const isEntity =
    entityMarkers.some((m) => type.includes(m)) ||
    !!(extraction.seller_entity_name && extraction.seller_entity_name.trim());

  if (!isEntity) return { isEntity: false };

  const signers = [];
  for (let i = 1; i <= 4; i++) {
    const v = extraction['seller_signer_' + i];
    if (v && String(v).trim()) signers.push(String(v).trim());
  }
  return {
    isEntity: true,
    entityName: (extraction.seller_entity_name || extraction.trust_full_name || '').trim() || null,
    signerNames: signers.length ? signers : null,
  };
}

function deriveBuyerEntity(extraction) {
  // Extraction currently has no buyer_entity / buyer_signer fields. If a buyer
  // entity ever appears it would be in buyer_names. For now we detect only the
  // obvious marker case and otherwise report not-an-entity. The manual override
  // can force this if needed.
  const names = normalize(extraction.buyer_names);
  const entityMarkers = ['trust', 'llc', ' inc', 'corp', 'partnership'];
  const isEntity = entityMarkers.some((m) => names.includes(m));
  if (!isEntity) return { isEntity: false };
  return {
    isEntity: true,
    entityName: (extraction.buyer_names || '').trim() || null,
    signerNames: null, // not extracted today — override supplies if needed
  };
}

// --- Top-level mapper -------------------------------------------------------
// extraction: the 50-field extraction result object
// pageTexts:  array of per-page PDF text (for form classification)
function mapExtractionToAuditParams(extraction, pageTexts) {
  const form = classifyForm(pageTexts);
  const sellerC = deriveSellerCount(extraction);
  const buyerC = deriveBuyerCount(extraction);
  const sellerEntity = deriveSellerEntity(extraction);
  const buyerEntity = deriveBuyerEntity(extraction);

  return {
    formId: form.formId,
    buyerCount: buyerC.count,
    sellerCount: sellerC.count,
    sellerEntity,
    buyerEntity,
    // derivation: per-field provenance + confidence, for the test page UI and
    // for logging how often extraction-derived values needed override.
    derivation: {
      formId: form,
      buyerCount: buyerC,
      sellerCount: sellerC,
      extraction_status: extraction._extraction_status || 'unknown',
    },
  };
}

module.exports = {
  mapExtractionToAuditParams,
  classifyForm,
  deriveSellerCount,
  deriveBuyerCount,
  deriveSellerEntity,
  deriveBuyerEntity,
  parseNameCount,
};
