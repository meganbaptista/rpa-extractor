// netlify/functions/audit-orchestrator-background.js
//
// ============================================================================
// VALIDATION SCAFFOLDING — long-running chain orchestrator
// ============================================================================
// The `-background` filename suffix gives this function Netlify's 15-minute
// execution ceiling (vs the ~26s proxy limit on synchronous functions). This
// is where the long work lives.
//
// Invoked fire-and-forget by audit-submit.js with { jobId, overrides }.
// The PDF is already in the shared extraction-payloads store under jobId.
//
// The chain:
//   1. Invoke extract-background (existing extractor) to run extraction
//   2. Poll extraction-jobs until the extraction result is ready
//   3. Run the handoff mapper (PERMANENT BOUNDARY) on the extraction result
//   4. Apply manual overrides (SCAFFOLDING) over the mapper output
//   5. Invoke audit-background with the audit parameters
//
// Throughout, it writes stage progress into the audit-results store so
// audit-status (polled by the test page) can show extraction -> mapper ->
// audit progress. The FINAL audit result is written by audit-background
// itself, also into audit-results under the same jobId.
// ----------------------------------------------------------------------------
// PERMANENT within this file : the handoff-mapper call (step 3); the audit
//                              invocation contract (step 5)
// SCAFFOLDING                : this orchestrator existing; override handling;
//                              the inline extraction poll
// ----------------------------------------------------------------------------

const { getStore } = require('@netlify/blobs');
console.log('[audit-orchestrator] @netlify/blobs loaded');
// ============================================================================
// INLINED HANDOFF MAPPER (permanent boundary logic)
// ----------------------------------------------------------------------------
// This is a copy of handoff-mapper.js, inlined here on purpose. Netlify bundles
// each function in isolation and does NOT reliably include sibling files, so a
// require('./handoff-mapper.js') crashes this function at module load with zero
// logs. handoff-mapper.js still exists as the standalone module Keeva will use;
// this inlined copy keeps the orchestrator self-contained. If you change the
// mapper logic, change it in BOTH places until the Keeva migration unifies them.
// ============================================================================
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
// ============================================================================
// END INLINED HANDOFF MAPPER
// ============================================================================

console.log('[audit-orchestrator] module loading (line 1)');

function blobsConfig(name) {
  if (!process.env.NETLIFY_BLOBS_TOKEN) {
    throw new Error('NETLIFY_BLOBS_TOKEN env var is not set.');
  }
  return {
    name,
    siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============================================================================
// SWAP POINT — extraction result read
// ----------------------------------------------------------------------------
// The ONE piece isolated so the extraction-result read path can change without
// touching the audit engine or the handoff mapper. Assumptions:
//   - the extractor's background function is named `extract-background`
//   - extraction results land in the `extraction-jobs` blob store, keyed by
//     jobId, with the shape the extractor's result.js returns
//   - that shape wraps the field JSON as result.content[0].text (a string)
//
// If any assumption is wrong, FIX ONLY THIS FUNCTION. It must return the plain
// 50-field extraction object the handoff mapper expects.
// ============================================================================
async function readExtractionResult(jobsStore, jobId) {
  const rec = await jobsStore.get(jobId, { type: 'json' });
  if (!rec) return { ready: false };
  if (rec.status === 'failed' || rec.status === 'error') {
    return { ready: true, failed: true, error: rec.error || 'extraction failed' };
  }
  if (rec.status !== 'complete') return { ready: false };

  let fields = null;
  try {
    const text = rec.result && rec.result.content && rec.result.content[0] && rec.result.content[0].text;
    if (text) {
      const cleaned = text.replace(/```json|```/g, '').trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      fields = match ? JSON.parse(match[0]) : JSON.parse(cleaned);
    } else if (rec.result && typeof rec.result === 'object') {
      fields = rec.result;
    }
  } catch (e) {
    return { ready: true, failed: true, error: 'could not parse extraction result: ' + e.message };
  }
  if (!fields) return { ready: true, failed: true, error: 'extraction result had no parseable fields' };
  return { ready: true, failed: false, fields };
}
// ============================================================================
// END SWAP POINT
// ============================================================================

console.log('[audit-orchestrator] module fully loaded, handler ready');

exports.handler = async function (event) {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    console.error('[audit-orchestrator] invalid JSON body');
    return { statusCode: 400 };
  }

  const { jobId, overrides = {} } = body;
  if (!jobId) {
    console.error('[audit-orchestrator] missing jobId');
    return { statusCode: 400 };
  }

  console.log(`[audit-orchestrator] jobId=${jobId} started`);

  const resultsStore = getStore(blobsConfig('audit-results'));
  const jobsStore = getStore(blobsConfig('extraction-jobs'));

  // Helper: write a stage-progress record. The FINAL result record is written
  // by audit-background, not here — we only write progress up to the point the
  // audit takes over.
  async function writeStage(stage, extra) {
    await resultsStore.setJSON(jobId, Object.assign(
      { status: 'pending', stage, startedAt: Date.now() },
      extra || {}
    ));
  }

  try {
    // ----- Step 0: give the audit its OWN copy of the PDF ------------------
    // PERMANENT BOUNDARY — payload ownership.
    // audit-submit wrote the PDF to extraction-payloads (shared). But the real
    // extractor's extract-background DELETES extraction-payloads when it
    // finishes — so by the time audit-background runs, the shared copy is
    // gone. We copy the PDF into audit-payloads (a store the audit owns end to
    // end) BEFORE invoking extraction. audit-background reads from
    // audit-payloads and deletes that copy when it's done. No collision with
    // the extractor's cleanup.
    const extractionPayloadStore = getStore(blobsConfig('extraction-payloads'));
    const auditPayloadStore = getStore(blobsConfig('audit-payloads'));
    const sharedPayload = await extractionPayloadStore.get(jobId, { type: 'json' });
    if (!sharedPayload) {
      throw new Error('PDF payload not found in extraction-payloads — audit-submit did not store it, or it expired.');
    }
    await auditPayloadStore.setJSON(jobId, sharedPayload);
    console.log(`[audit-orchestrator] jobId=${jobId} copied PDF into audit-payloads`);

    // ----- Step 1: invoke extraction (existing extract-background) ----------
    await writeStage('extraction');
    console.log(`[audit-orchestrator] jobId=${jobId} invoking extraction`);

    const proto = (event.headers && event.headers['x-forwarded-proto']) || 'https';
    const host = event.headers && event.headers.host;
    const extractUrl = proto + '://' + host + '/.netlify/functions/extract-background';

    try {
      await fetch(extractUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
    } catch (e) {
      throw new Error('Failed to invoke extraction: ' + e.message);
    }

    // ----- Step 2: poll extraction-jobs for the result ---------------------
    let extraction = null;
    const MAX_WAIT_MS = 240000; // 4 min — comfortably inside the 15-min ceiling
    const POLL_MS = 3000;
    const started = Date.now();

    while (Date.now() - started < MAX_WAIT_MS) {
      await sleep(POLL_MS);
      const r = await readExtractionResult(jobsStore, jobId);
      if (r.ready) {
        if (r.failed) throw new Error('Extraction failed: ' + r.error);
        extraction = r.fields;
        break;
      }
    }
    if (!extraction) {
      throw new Error('Extraction did not complete within 4 minutes');
    }
    console.log(`[audit-orchestrator] jobId=${jobId} extraction complete`);

    // ----- Step 3: PERMANENT BOUNDARY — handoff mapper ---------------------
    await writeStage('mapper');

    // The mapper needs page text for form classification. Extraction does not
    // surface raw page text yet, so for the validation phase we feed a small
    // pseudo page-text built from extraction signals (RPA contracts carry a
    // purchase price; AD forms do not). Crude but adequate for RPA-vs-AD; the
    // manual override is the pressure valve when it is wrong.
    const pseudoPageText = [
      extraction._form_hint || '',
      extraction.final_purchase_price ? 'california residential purchase agreement joint escrow instructions' : '',
    ].join(' ');

    const mapped = mapExtractionToAuditParams(extraction, [pseudoPageText]);
    console.log(`[audit-orchestrator] jobId=${jobId} mapper:`, JSON.stringify({
      formId: mapped.formId, buyerCount: mapped.buyerCount, sellerCount: mapped.sellerCount,
    }));

    // ----- Step 4: apply manual overrides (SCAFFOLDING) --------------------
    const auditParams = {
      formId: overrides.formId || mapped.formId,
      buyerCount: overrides.buyerCount != null ? overrides.buyerCount : mapped.buyerCount,
      sellerCount: overrides.sellerCount != null ? overrides.sellerCount : mapped.sellerCount,
      sellerEntity: mapped.sellerEntity,
      buyerEntity: mapped.buyerEntity,
    };

    const overrodeForm = overrides.formId && overrides.formId !== mapped.formId;
    const overrodeBuyers = overrides.buyerCount != null && overrides.buyerCount !== mapped.buyerCount;
    const overrodeSellers = overrides.sellerCount != null && overrides.sellerCount !== mapped.sellerCount;
    if (overrodeForm || overrodeBuyers || overrodeSellers) {
      console.log(`[audit-orchestrator] jobId=${jobId} OVERRIDE applied — ` +
        `form:${overrodeForm ? mapped.formId + '->' + overrides.formId : 'kept'} ` +
        `buyers:${overrodeBuyers ? mapped.buyerCount + '->' + overrides.buyerCount : 'kept'} ` +
        `sellers:${overrodeSellers ? mapped.sellerCount + '->' + overrides.sellerCount : 'kept'}`);
    }

    // NOTE: form classification (formId) is no longer required. The Phase 1
    // holistic audit reads the whole packet and reasons about it regardless of
    // form type — there is no per-form schema anymore. The handoff mapper's
    // formId is kept in auditParams for now (harmless; audit-background ignores
    // it) but it never blocks the audit.

    // Record the extraction + mapper output alongside the stage marker so the
    // test page can show them while the audit runs.
    await resultsStore.setJSON(jobId, {
      status: 'pending',
      stage: 'audit',
      startedAt: Date.now(),
      extraction,
      mapped,
      auditParams,
    });

    // ----- Step 5: PERMANENT — invoke audit-background ---------------------
    console.log(`[audit-orchestrator] jobId=${jobId} invoking audit-background`);
    const auditUrl = proto + '://' + host + '/.netlify/functions/audit-background';
    try {
      await fetch(auditUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ jobId }, auditParams)),
      });
    } catch (e) {
      throw new Error('Failed to invoke audit-background: ' + e.message);
    }

    // audit-background writes the FINAL result into audit-results under jobId.
    // Our job is done — the test page polls audit-status for that result.
    console.log(`[audit-orchestrator] jobId=${jobId} handed off to audit-background`);
    return { statusCode: 200 };
  } catch (err) {
    console.error(`[audit-orchestrator] jobId=${jobId} ERROR:`, err.message);
    try {
      await resultsStore.setJSON(jobId, {
        status: 'error',
        stage: 'orchestrator',
        error: err.message,
        completedAt: Date.now(),
      });
    } catch (writeErr) {
      console.error(`[audit-orchestrator] jobId=${jobId} also failed to write error status:`, writeErr.message);
    }
    return { statusCode: 500 };
  }
};
