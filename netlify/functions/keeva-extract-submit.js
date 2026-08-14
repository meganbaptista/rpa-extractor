// netlify/functions/keeva-extract-submit.js
//
// ============================================================================
// KEEVA CONTRACT DROP — extraction only, no audit, no Zapier
// ============================================================================
// Keeva's Create Transaction wizard drops the same three documents the
// extractor's own page takes — Purchase Agreement (required), Property Profile
// and MLS Listing (optional) — and polls /result?jobId=... for the 50-field
// extraction, which prefills the deal.
//
// WHY NOT submit.js:
// submit.js does the same extraction, then ALSO fans out to the signature-audit
// pipeline, which on success POSTs to the audit Zapier webhook and lands a
// record in Process Street. Opening a file in Keeva shouldn't run a signature
// audit nobody asked for, spend a second full Opus call, or push an artifact
// into a Zapier flow that isn't part of this workflow.
//
// WHY NOT transaction-background (Call B):
// Call B reads `documents[0]` ONLY — it reasons over the contract packet alone.
// It produces the reconciled `transaction_state` (counter chain, controlling
// document, needs_review), which is excellent for terms on a countered deal but
// knows nothing about year built, square footage, MLS number or list price.
// Those live in the Property Profile and MLS, and only extract-background reads
// multiple labelled documents.
//
// NOTHING EXISTING CHANGES. submit.js, audit-submit.js, the orchestrator and
// every Zapier flow are untouched; this adds a path beside them.
//
// Body (chunked, via audit-chunk.js — same convention submit.js uses):
//   { files: [{ uploadId, totalChunks, label }] }
// Response: 202 { jobId } — then poll /result?jobId=...
// ============================================================================

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

console.log('[keeva-extract-submit] module loading');

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

// Mirrors submit.js. Chunks are slices of one base64 string, so concatenating
// them is lossless.
async function assembleFromChunks(store, fileRef) {
  const { uploadId, totalChunks } = fileRef;
  if (!uploadId || typeof uploadId !== 'string') {
    throw new Error('A file reference is missing its uploadId');
  }
  if (typeof totalChunks !== 'number' || totalChunks < 1) {
    throw new Error('File reference ' + uploadId + ' has invalid totalChunks');
  }

  let assembled = '';
  let label = fileRef.label || 'document';

  for (let i = 0; i < totalChunks; i++) {
    const chunk = await store.get('chunk:' + uploadId + ':' + i, { type: 'json' });
    if (!chunk || typeof chunk.data !== 'string') {
      throw new Error(
        'Chunk ' + i + ' of ' + totalChunks + ' missing for ' + uploadId + ' — upload incomplete',
      );
    }
    assembled += chunk.data;
    if (chunk.label) label = chunk.label;
  }

  if (!assembled) throw new Error('Assembled document ' + uploadId + ' is empty');
  return { data: assembled, label, uploadId, totalChunks };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body must be JSON' }) };
  }

  const jobId = crypto.randomUUID();
  const payloadStore = getStore(blobsConfig('extraction-payloads'));
  const jobsStore = getStore(blobsConfig('extraction-jobs'));

  try {
    const documents = [];
    const cleanup = [];

    if (Array.isArray(body.files) && body.files.length > 0) {
      for (const fileRef of body.files) {
        const assembled = await assembleFromChunks(payloadStore, fileRef);
        // Per-document labels are load-bearing: extract-background uses them
        // to tell the RPA from the Property Profile and the MLS sheet.
        documents.push({ data: assembled.data, label: assembled.label });
        cleanup.push({ uploadId: assembled.uploadId, totalChunks: assembled.totalChunks });
      }
    } else if (Array.isArray(body.documents) && body.documents.length > 0) {
      for (const doc of body.documents) {
        if (doc && doc.data) documents.push({ data: doc.data, label: doc.label || 'document' });
      }
    }

    if (documents.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'No documents provided — send chunked `files` references or a `documents` array',
        }),
      };
    }

    console.log(
      '[keeva-extract-submit] jobId=' + jobId + ' assembled ' + documents.length + ' document(s): ' +
        documents.map((d) => d.label).join(', '),
    );

    // Same shape submit.js writes; extract-background reads this by jobId.
    await payloadStore.setJSON(jobId, { documents });

    // Best-effort chunk cleanup.
    for (const ref of cleanup) {
      for (let i = 0; i < ref.totalChunks; i++) {
        try {
          await payloadStore.delete('chunk:' + ref.uploadId + ':' + i);
        } catch (e) {
          console.warn('[keeva-extract-submit] could not delete chunk: ' + e.message);
        }
      }
    }

    // Pending record first, so a poll straight after submit has something to
    // read rather than a 404.
    await jobsStore.setJSON(jobId, {
      status: 'pending',
      submitted_at: new Date().toISOString(),
      source: 'keeva',
    });

    const proto = event.headers['x-forwarded-proto'] || 'https';
    const host = event.headers.host;
    const url = proto + '://' + host + '/.netlify/functions/extract-background';

    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      console.log('[keeva-extract-submit] jobId=' + jobId + ' invoked extract-background');
    } catch (invokeErr) {
      console.error('[keeva-extract-submit] jobId=' + jobId + ' invoke failed: ' + invokeErr.message);
      await jobsStore.setJSON(jobId, {
        status: 'failed',
        failed_at: new Date().toISOString(),
        error: 'Failed to start extraction: ' + invokeErr.message,
      });
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to start extraction' }) };
    }

    return { statusCode: 202, headers, body: JSON.stringify({ jobId }) };
  } catch (err) {
    console.error('[keeva-extract-submit] jobId=' + jobId + ' ERROR: ' + err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
