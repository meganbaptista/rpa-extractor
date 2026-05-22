// netlify/functions/audit-submit.js
//
// ============================================================================
// VALIDATION SCAFFOLDING — test orchestrator
// ============================================================================
// This endpoint exists to VALIDATE the extraction → audit chain against real
// contracts. It is NOT the Keeva product flow and will be deleted when the
// signature audit is wired into Keeva's real single-upload orchestration.
//
// What it does (the chain):
//   1. Receives a PDF upload (this stands in for Keeva's future single upload)
//   2. Stores the PDF in the SHARED extraction-payloads store under a jobId
//      — exactly as the real extractor's submit.js does (PERMANENT pattern)
//   3. Invokes the existing extract-background to run extraction
//   4. Polls for the extraction result
//   5. Runs the handoff mapper (PERMANENT BOUNDARY) on the extraction result
//   6. Invokes audit-background with the mapper's parameters
//   7. Returns the jobId; the test page polls audit-status for the result
//
// If the caller supplied manual overrides (validation scaffolding), those
// replace the mapper's formId / buyerCount / sellerCount before step 6.
//
// ----------------------------------------------------------------------------
// PERMANENT vs SCAFFOLDING within this file:
//   PERMANENT  : the shared-payload-store write (step 2); the handoff-mapper
//                call (step 5); the audit invocation contract (step 6)
//   SCAFFOLDING: this orchestrator existing at all; the override handling;
//                the inline extraction-polling loop
// ----------------------------------------------------------------------------

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');
const { mapExtractionToAuditParams } = require('./handoff-mapper.js');

console.log('[audit-submit] module loading');

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

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============================================================================
// SWAP POINT — extraction result read
// ----------------------------------------------------------------------------
// Per the build agreement: this is the ONE piece isolated so it can be changed
// without touching the audit engine or the handoff mapper. It assumes:
//   - the extractor's background function is named `extract-background`
//   - extraction results land in the `extraction-jobs` blob store, keyed by
//     jobId, with the shape the extractor's result.js returns
//
// If either assumption is wrong, FIX ONLY THIS FUNCTION. The extraction result
// returned must be the plain 50-field object the handoff mapper expects.
//
// The extractor's result.js wraps the data as:
//   { status:'complete', result:{ content:[{type:'text', text:'<JSON string>'}] } }
// so we unwrap content[0].text and JSON.parse it. If the extractor changes its
// result shape, adjust the unwrap here.
// ============================================================================
async function readExtractionResult(jobsStore, jobId) {
  const rec = await jobsStore.get(jobId, { type: 'json' });
  if (!rec) return { ready: false };
  if (rec.status === 'failed' || rec.status === 'error') {
    return { ready: true, failed: true, error: rec.error || 'extraction failed' };
  }
  if (rec.status !== 'complete') return { ready: false };

  // Unwrap the extractor's Anthropic-shaped result → the 50-field object.
  let fields = null;
  try {
    const text = rec.result && rec.result.content && rec.result.content[0] && rec.result.content[0].text;
    if (text) {
      const cleaned = text.replace(/```json|```/g, '').trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      fields = match ? JSON.parse(match[0]) : JSON.parse(cleaned);
    } else if (rec.result && typeof rec.result === 'object') {
      // Fallback: result already the plain object
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

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    if (!body.documents || !Array.isArray(body.documents) || body.documents.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No documents provided' }) };
    }

    // SCAFFOLDING: manual overrides from the test page (may be absent).
    const overrides = body.overrides || {};

    const jobId = crypto.randomUUID();
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const host = event.headers.host;

    const payloadStore = getStore(blobsConfig('extraction-payloads'));
    const jobsStore = getStore(blobsConfig('extraction-jobs'));

    // ----- PERMANENT PATTERN: store the PDF once in the shared payload store
    await payloadStore.setJSON(jobId, {
      documents: body.documents,
      prompt_override: body.prompt_override || null,
    });
    await jobsStore.setJSON(jobId, { status: 'pending', submitted_at: new Date().toISOString() });

    // ----- Step 3: invoke extraction (existing extract-background)
    const extractUrl = proto + '://' + host + '/.netlify/functions/extract-background';
    try {
      await fetch(extractUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
    } catch (e) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to start extraction: ' + e.message }) };
    }

    // ----- Step 4: poll for extraction result (SCAFFOLDING: inline poll).
    // Extraction typically completes in 25-40s. We poll up to ~3 minutes.
    let extraction = null;
    let extractionError = null;
    const MAX_WAIT_MS = 180000;
    const POLL_MS = 3000;
    const started = Date.now();
    while (Date.now() - started < MAX_WAIT_MS) {
      await sleep(POLL_MS);
      const r = await readExtractionResult(jobsStore, jobId);
      if (r.ready) {
        if (r.failed) { extractionError = r.error; }
        else { extraction = r.fields; }
        break;
      }
    }

    if (extractionError) {
      return { statusCode: 200, headers, body: JSON.stringify({
        jobId, stage: 'extraction', status: 'failed', error: extractionError,
      })};
    }
    if (!extraction) {
      return { statusCode: 200, headers, body: JSON.stringify({
        jobId, stage: 'extraction', status: 'timeout',
        error: 'Extraction did not complete within 3 minutes',
      })};
    }

    // ----- Step 5: PERMANENT BOUNDARY — handoff mapper.
    // The mapper needs page texts for form classification. The extractor does
    // not currently surface raw page text in its result, so for the validation
    // phase we classify from a small set of signals already in the extraction
    // output plus any override. If the override supplies formId we skip
    // classification entirely. (When form classification moves into extraction
    // proper, the mapper will receive real page texts.)
    //
    // For now: give the mapper a best-effort "page text" assembled from
    // extraction fields that echo form identity, so high-confidence RPA
    // detection still works; otherwise the operator selects the form via
    // override.
    const pseudoPageText = [
      extraction._form_hint || '',
      // RPA contracts always carry these; AD will not.
      extraction.final_purchase_price ? 'california residential purchase agreement joint escrow instructions' : '',
    ].join(' ');

    const mapped = mapExtractionToAuditParams(extraction, [pseudoPageText]);

    // ----- Apply manual overrides (SCAFFOLDING) over the mapper output.
    const auditParams = {
      formId: overrides.formId || mapped.formId,
      buyerCount: overrides.buyerCount != null ? overrides.buyerCount : mapped.buyerCount,
      sellerCount: overrides.sellerCount != null ? overrides.sellerCount : mapped.sellerCount,
      sellerEntity: mapped.sellerEntity,
      buyerEntity: mapped.buyerEntity,
    };

    // Log when an override changed a mapper-derived value — this data tells us
    // how reliable the handoff is and whether it is Keeva-ready.
    const overrodeForm = overrides.formId && overrides.formId !== mapped.formId;
    const overrodeBuyers = overrides.buyerCount != null && overrides.buyerCount !== mapped.buyerCount;
    const overrodeSellers = overrides.sellerCount != null && overrides.sellerCount !== mapped.sellerCount;
    if (overrodeForm || overrodeBuyers || overrodeSellers) {
      console.log(`[audit-submit] jobId=${jobId} OVERRIDE applied — ` +
        `form:${overrodeForm ? mapped.formId + '->' + overrides.formId : 'kept'} ` +
        `buyers:${overrodeBuyers ? mapped.buyerCount + '->' + overrides.buyerCount : 'kept'} ` +
        `sellers:${overrodeSellers ? mapped.sellerCount + '->' + overrides.sellerCount : 'kept'}`);
    }

    if (!auditParams.formId) {
      // Mapper couldn't classify and no override given — return so the test
      // page can show the override panel and the operator can pick the form.
      return { statusCode: 200, headers, body: JSON.stringify({
        jobId, stage: 'handoff', status: 'needs_override',
        extraction, mapped,
        message: 'Form could not be classified. Select the form via override and resubmit.',
      })};
    }

    // ----- Step 6: PERMANENT — invoke audit-background with mapper params.
    const auditUrl = proto + '://' + host + '/.netlify/functions/audit-background';
    try {
      await fetch(auditUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, ...auditParams }),
      });
    } catch (e) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to start audit: ' + e.message }) };
    }

    // Return everything the test page needs to show the chain + poll the audit.
    return { statusCode: 202, headers, body: JSON.stringify({
      jobId,
      stage: 'audit',
      status: 'pending',
      extraction,          // SCAFFOLDING: shown on test page
      mapped,              // SCAFFOLDING: shown on test page (derivation + confidence)
      auditParams,         // what the audit was actually invoked with
    })};
  } catch (err) {
    console.error('[audit-submit] error: ' + err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
