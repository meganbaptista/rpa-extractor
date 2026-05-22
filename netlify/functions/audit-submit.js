// netlify/functions/audit-submit.js
//
// ============================================================================
// VALIDATION SCAFFOLDING — fast synchronous front door
// ============================================================================
// This endpoint is the test-harness entry point. It is NOT the Keeva product
// flow and is deleted when the audit is wired into Keeva's single-upload
// orchestration.
//
// It is FAST and SYNCHRONOUS — it must return in well under a second so it
// never hits the Netlify proxy timeout (~26s). It does four things and stops:
//   1. Store the PDF in the SHARED extraction-payloads store under a jobId
//      (PERMANENT pattern — same store the real extractor's submit.js uses)
//   2. Write a `pending` record to audit-results so audit-status has something
//      to return immediately
//   3. Fire-and-forget invoke audit-orchestrator-background (the long-running
//      extraction -> mapper -> audit chain runs THERE, with a 15-min ceiling)
//   4. Return { jobId } to the caller
//
// The test page then polls audit-status?jobId=... for stage progress and the
// final audit result.
//
// WHY THIS SHAPE: an earlier version of this file ran the whole chain inline
// and blocked 30-180s — the Netlify proxy killed it at ~26s and returned an
// HTML timeout page, which broke the caller's JSON parse. Long-running work
// MUST live in a -background function. This mirrors the extractor's proven
// submit/poll/background split.
// ----------------------------------------------------------------------------
// PERMANENT within this file : the shared-payload-store write (step 1)
// SCAFFOLDING                : this endpoint existing; the override pass-through
// ----------------------------------------------------------------------------

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

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

    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();

    // SCAFFOLDING: manual overrides from the test page (may be absent). Passed
    // straight through to the orchestrator, which applies them over the
    // handoff mapper's output.
    const overrides = body.overrides || {};

    // ----- Step 1: PERMANENT pattern — store the PDF once in the SHARED
    // extraction-payloads store. This is the exact store + key convention the
    // real extractor's submit.js uses, so extraction can read it too.
    const payloadStore = getStore(blobsConfig('extraction-payloads'));
    await payloadStore.setJSON(jobId, {
      documents: body.documents,
      prompt_override: body.prompt_override || null,
    });

    // ----- Step 2: write a pending record to audit-results so audit-status
    // returns something meaningful the instant the test page starts polling.
    const resultsStore = getStore(blobsConfig('audit-results'));
    await resultsStore.setJSON(jobId, {
      status: 'pending',
      stage: 'queued',
      startedAt: Date.now(),
      submitted_at: now,
    });

    // ----- Step 3: fire-and-forget the orchestrator background function.
    // We await only the initial 202 (invocation accepted), NOT the chain.
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const host = event.headers.host;
    const orchestratorUrl = proto + '://' + host + '/.netlify/functions/audit-orchestrator-background';

    try {
      const invocation = await fetch(orchestratorUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, overrides }),
      });
      if (invocation.status !== 202 && !invocation.ok) {
        console.warn('[audit-submit] orchestrator invocation returned status ' + invocation.status);
      }
    } catch (invokeErr) {
      console.error('[audit-submit] failed to invoke orchestrator: ' + invokeErr.message);
      await resultsStore.setJSON(jobId, {
        status: 'error',
        stage: 'queued',
        error: 'Failed to start audit orchestrator: ' + invokeErr.message,
        completedAt: Date.now(),
      });
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to start audit orchestrator' }) };
    }

    // ----- Step 4: return immediately. The test page polls audit-status.
    return {
      statusCode: 202,
      headers,
      body: JSON.stringify({ jobId, status: 'pending', stage: 'queued' }),
    };
  } catch (err) {
    console.error('[audit-submit] error: ' + err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
