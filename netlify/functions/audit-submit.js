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
// never hits the Netlify proxy timeout. It does four things and stops:
//   1. ASSEMBLE the uploaded chunks (uploaded separately via audit-chunk.js)
//      into the final PDF payload, stored in the SHARED extraction-payloads
//      store under the jobId.
//   2. Write a `pending` record to audit-results so audit-status has something
//      to return immediately.
//   3. Fire-and-forget invoke audit-orchestrator-background (the long-running
//      extraction -> mapper -> audit chain runs THERE).
//   4. Return { jobId } to the caller.
//
// ----------------------------------------------------------------------------
// CHUNKED UPLOAD (why this changed):
// Netlify buffered synchronous functions have a 6 MB request limit, and Netlify
// Base64-encodes binary bodies (~30% overhead) so the EFFECTIVE binary ceiling
// is ~4.5 MB. Real contract packets exceed that. So the PDF is NO LONGER sent
// in this function's request body. Instead:
//   - The browser splits the PDF's base64 string into <limit pieces and POSTs
//     them to audit-chunk.js, which stores them at chunk:{uploadId}:{n}.
//   - This function receives just an `uploadId`, reads the chunk pieces back,
//     concatenates the base64 strings (lossless — they are slices of one
//     original base64 string), and writes the assembled payload under jobId.
//
// This is the throwaway adapter layer. On a future AWS/S3 move (presigned
// uploads, no size ceiling) the chunk dance is deleted and this function goes
// back to a direct payload reference.
//
// PERMANENT within this file : the shared-payload-store write, the job-start
// SCAFFOLDING                : this endpoint existing; chunk assembly; override
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

    // ----- New chunked-upload path: body carries an uploadId, not documents.
    const { uploadId, totalChunks } = body;
    if (!uploadId || typeof uploadId !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing uploadId — chunks must be uploaded via audit-chunk first' }) };
    }
    if (typeof totalChunks !== 'number' || totalChunks < 1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing or invalid totalChunks' }) };
    }

    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();

    // SCAFFOLDING: manual overrides from the test page (may be absent).
    const overrides = body.overrides || {};

    const payloadStore = getStore(blobsConfig('extraction-payloads'));

    // ----- Step 1: ASSEMBLE the uploaded chunks into the final PDF base64.
    // Read chunk:{uploadId}:0 .. chunk:{uploadId}:{totalChunks-1} and
    // concatenate their `data` strings in index order.
    let assembledBase64 = '';
    let label = 'contract';
    for (let i = 0; i < totalChunks; i++) {
      const chunkKey = `chunk:${uploadId}:${i}`;
      let chunk;
      try {
        chunk = await payloadStore.get(chunkKey, { type: 'json' });
      } catch (e) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Failed to read chunk ${i}: ${e.message}` }) };
      }
      if (!chunk || typeof chunk.data !== 'string') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Chunk ${i} of ${totalChunks} is missing — upload incomplete` }) };
      }
      assembledBase64 += chunk.data;
      if (chunk.label) label = chunk.label;
    }

    if (!assembledBase64) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Assembled payload is empty' }) };
    }
    console.log(`[audit-submit] jobId=${jobId} assembled ${totalChunks} chunks -> ${assembledBase64.length} b64 chars`);

    // Write the assembled payload under jobId — the exact shape the extractor's
    // submit.js produces, so extraction can read it: { documents:[{data,label}] }.
    await payloadStore.setJSON(jobId, {
      documents: [{ data: assembledBase64, label }],
      prompt_override: body.prompt_override || null,
    });

    // ----- Step 1b: clean up the temp chunk keys (best-effort).
    for (let i = 0; i < totalChunks; i++) {
      try {
        await payloadStore.delete(`chunk:${uploadId}:${i}`);
      } catch (e) {
        console.warn(`[audit-submit] could not delete chunk ${i}: ${e.message}`);
      }
    }

    // ----- Step 2: write a pending record to audit-results.
    const resultsStore = getStore(blobsConfig('audit-results'));
    await resultsStore.setJSON(jobId, {
      status: 'pending',
      stage: 'queued',
      startedAt: Date.now(),
      submitted_at: now,
    });

    // ----- Step 3: fire-and-forget the orchestrator background function.
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
