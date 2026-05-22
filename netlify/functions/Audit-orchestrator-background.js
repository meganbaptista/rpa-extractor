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
const { mapExtractionToAuditParams } = require('./handoff-mapper.js');

console.log('[audit-orchestrator] module loading');

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

    // If the form could not be classified and no override supplied one, stop
    // here with a needs_override status so the test page can prompt for it.
    if (!auditParams.formId) {
      await resultsStore.setJSON(jobId, {
        status: 'needs_override',
        stage: 'mapper',
        extraction,
        mapped,
        message: 'Form could not be classified. Select the form via override and resubmit.',
        completedAt: Date.now(),
      });
      console.log(`[audit-orchestrator] jobId=${jobId} needs override (form not classified)`);
      return { statusCode: 200 };
    }

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
