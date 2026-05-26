// netlify/functions/submit.js
//
// Synchronous front door. Receives an extraction job, stamps it with a jobId,
// persists a "pending" record, kicks off the background function that will do
// the real work, and returns the jobId to the caller — all in well under one
// second. The frontend then polls /result?jobId=... for the finished output.
//
// ----------------------------------------------------------------------------
// CHUNKED UPLOAD (why this changed):
// Netlify buffered synchronous functions have a ~6 MB request limit, and
// Netlify Base64-encodes binary bodies (~30% overhead), so the effective
// ceiling is lower still. A 6.2 MB PDF Base64-encodes to ~8.3 MB of JSON —
// over the cap — so the request was rejected at Netlify's edge before this
// function ran (an empty-body response the frontend saw as "Server error").
//
// The PDF is therefore NO LONGER sent in this function's request body.
// Instead, mirroring the proven signature-audit pipeline:
//   - The browser splits each PDF's base64 string into <limit pieces and POSTs
//     them to extract-chunk.js, which stores them at chunk:{uploadId}:{n} in
//     the extraction-payloads store.
//   - This function receives a list of per-file chunk references
//     ({ uploadId, totalChunks, label }), reads each file's chunk pieces back,
//     concatenates the base64 slices (lossless — they are slices of one
//     original base64 string), and writes the assembled payload under jobId
//     in the SAME { documents:[{ data, label }] } shape it always produced.
//
// Per-file uploadId: each uploaded document (RPA, Property Profile, MLS) has
// its own uploadId and its own chunk set, so document boundaries and labels
// are preserved exactly — extract-background relies on per-document labels.
//
// Everything downstream of the assembled payload — extract-background, the
// poll path, the frontend's parsing, the Zapier/Process Street handoff — is
// UNCHANGED. The assembled payload is byte-identical in shape to the legacy
// direct-upload payload.
//
// BACKWARD COMPATIBILITY: a legacy { documents:[...] } body is still accepted
// (small uploads, any external caller not yet migrated). New callers send
// chunk references. Both paths converge on the same assembled payload.
//
// Payload shape accepted:
//   New (chunked):  { files: [{ uploadId, totalChunks, label }], prompt_override? }
//   Legacy (direct): { documents: [{ data, label }], prompt_override? }
//
// Response:
//   202 Accepted { jobId, status: 'pending' }
//
// The legacy /extract endpoint is left in place for backward compatibility
// (Zapier integrations etc.). New callers should use this submit+poll flow.

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

// Get the extraction-jobs blob store using explicit credentials. The
// auto-config / connectLambda path doesn't work reliably across all function
// invocation modes (specifically, background functions invoked via fetch()
// from another function don't get the auto-injected context), so we use a
// PAT instead. The token is set as NETLIFY_BLOBS_TOKEN; the siteID is
// auto-set by Netlify as the SITE_ID env var on all production functions.
function getJobStore() {
  if (!process.env.NETLIFY_BLOBS_TOKEN) {
    throw new Error('NETLIFY_BLOBS_TOKEN env var is not set — generate a Netlify Personal Access Token and add it as a site environment variable.');
  }
  return getStore({
    name: 'extraction-jobs',
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN
  });
}

// Separate store for the PDF payload. Kept distinct from the job-status store
// so that the polling endpoint (result.js) never accidentally returns the
// PDF base64 to the frontend, and so we can delete the payload after
// extraction completes without touching the status record.
//
// This store also holds the temporary chunk pieces (chunk:{uploadId}:{n})
// written by extract-chunk.js; this function reads and then deletes them.
function getPayloadStore() {
  if (!process.env.NETLIFY_BLOBS_TOKEN) {
    throw new Error('NETLIFY_BLOBS_TOKEN env var is not set — generate a Netlify Personal Access Token and add it as a site environment variable.');
  }
  return getStore({
    name: 'extraction-payloads',
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN
  });
}

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const JOB_TTL_HOURS = 24;

// ----------------------------------------------------------------------------
// Assemble one document from its uploaded chunks.
// Reads chunk:{uploadId}:0 .. chunk:{uploadId}:{totalChunks-1} from the
// payload store and concatenates their `data` strings in index order. The
// result is the original PDF's base64 string, reconstructed losslessly.
// Returns { data, label }. Throws with a clear message if a chunk is missing.
// ----------------------------------------------------------------------------
async function assembleFromChunks(payloadStore, fileRef) {
  const { uploadId, totalChunks } = fileRef;
  if (!uploadId || typeof uploadId !== 'string') {
    throw new Error('A file reference is missing its uploadId');
  }
  if (typeof totalChunks !== 'number' || totalChunks < 1) {
    throw new Error('File reference for uploadId=' + uploadId + ' has missing or invalid totalChunks');
  }

  let assembledBase64 = '';
  let label = fileRef.label || 'contract';

  for (let i = 0; i < totalChunks; i++) {
    const chunkKey = 'chunk:' + uploadId + ':' + i;
    let chunk;
    try {
      chunk = await payloadStore.get(chunkKey, { type: 'json' });
    } catch (e) {
      throw new Error('Failed to read chunk ' + i + ' for uploadId=' + uploadId + ': ' + e.message);
    }
    if (!chunk || typeof chunk.data !== 'string') {
      throw new Error('Chunk ' + i + ' of ' + totalChunks + ' is missing for uploadId=' + uploadId + ' — upload incomplete');
    }
    assembledBase64 += chunk.data;
    if (chunk.label) label = chunk.label;
  }

  if (!assembledBase64) {
    throw new Error('Assembled document for uploadId=' + uploadId + ' is empty');
  }
  return { data: assembledBase64, label, uploadId, totalChunks };
}

// Best-effort cleanup of the temp chunk keys after assembly. A cleanup miss is
// non-fatal — the chunk keys carry a TTL and will be evicted anyway — so this
// never fails the job.
async function deleteChunksSafe(payloadStore, fileRefs) {
  for (const ref of fileRefs) {
    if (!ref || !ref.uploadId || typeof ref.totalChunks !== 'number') continue;
    for (let i = 0; i < ref.totalChunks; i++) {
      try {
        await payloadStore.delete('chunk:' + ref.uploadId + ':' + i);
      } catch (e) {
        console.warn('submit: could not delete chunk ' + i + ' for uploadId=' + ref.uploadId + ': ' + e.message);
      }
    }
  }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};

    const payloadStore = getPayloadStore();

    // ----- Resolve `documents` from either the chunked path or the legacy
    //       direct path. Both converge on documents:[{ data, label }].
    let documents = [];
    let chunkRefsToCleanup = [];

    if (Array.isArray(body.files) && body.files.length > 0) {
      // New chunked path: body.files is a list of per-file chunk references.
      try {
        for (const fileRef of body.files) {
          const assembled = await assembleFromChunks(payloadStore, fileRef);
          documents.push({ data: assembled.data, label: assembled.label });
          chunkRefsToCleanup.push({ uploadId: assembled.uploadId, totalChunks: assembled.totalChunks });
        }
      } catch (assembleErr) {
        // Assembly failure means an incomplete or corrupt upload. Fail loudly
        // and early — before any job record is written — so the frontend
        // surfaces it and the user simply re-uploads. Nothing downstream runs.
        return { statusCode: 400, headers, body: JSON.stringify({ error: assembleErr.message }) };
      }
    } else if (Array.isArray(body.documents) && body.documents.length > 0) {
      // Legacy direct path: small uploads / un-migrated callers. Unchanged.
      documents = body.documents;
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No documents provided — send chunked `files` references or a legacy `documents` array' }) };
    }

    const jobId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + JOB_TTL_HOURS * 60 * 60 * 1000);

    // Stash the assembled PDF payload in its own blob store, in the SAME shape
    // the legacy direct-upload path always produced. extract-background reads
    // this unchanged.
    await payloadStore.setJSON(jobId, {
      documents: documents,
      prompt_override: body.prompt_override || null
    });

    // Best-effort cleanup of the temp chunk keys now that the payload is
    // assembled and persisted. Non-fatal if it misses.
    if (chunkRefsToCleanup.length > 0) {
      await deleteChunksSafe(payloadStore, chunkRefsToCleanup);
    }

    // Persist pending status record. Order matters: payload first, then
    // pending record, then invoke background. That way the background
    // function is guaranteed to find both blobs when it runs.
    const store = getJobStore();
    await store.setJSON(jobId, {
      status: 'pending',
      submitted_at: now.toISOString(),
      expires_at: expiresAt.toISOString()
    });

    // Fire-and-forget invoke the background function. Netlify background
    // functions respond with 202 immediately and then run server-side for up
    // to 15 minutes. We `await` the initial 202 so we know the invocation
    // was queued, but we don't await the actual extraction work.
    const protocol = event.headers['x-forwarded-proto'] || 'https';
    const host = event.headers.host;
    const backgroundUrl = protocol + '://' + host + '/.netlify/functions/extract-background';

    try {
      const invocation = await fetch(backgroundUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: jobId })  // Only the jobId — payload is in Blobs
      });
      if (invocation.status !== 202 && !invocation.ok) {
        console.warn('background invocation returned status ' + invocation.status);
      }
    } catch (invokeErr) {
      // If invocation fails outright, mark the job failed so the frontend
      // doesn't poll forever.
      console.error('failed to invoke background function: ' + invokeErr.message);
      const failStore = getJobStore();
      await failStore.setJSON(jobId, {
        status: 'failed',
        error: 'Failed to start extraction: ' + invokeErr.message,
        submitted_at: now.toISOString(),
        failed_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString()
      });
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to start extraction job' }) };
    }

    return {
      statusCode: 202,
      headers: headers,
      body: JSON.stringify({ jobId: jobId, status: 'pending' })
    };
  } catch (err) {
    console.error('submit error: ' + err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
