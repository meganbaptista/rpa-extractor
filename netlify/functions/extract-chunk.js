// netlify/functions/extract-chunk.js
//
// ============================================================================
// CHUNKED-UPLOAD RECEIVER — RPA / RLA extractor
// ============================================================================
// Netlify buffered synchronous functions have a 6 MB request limit, and because
// Netlify Base64-encodes binary request bodies (~30% overhead) the EFFECTIVE
// binary upload ceiling is ~4.5 MB. Real contract packets (RPA + counters +
// addenda) routinely exceed that — a 6.2 MB PDF Base64-encodes to ~8.3 MB of
// JSON, well over the cap, so the request is rejected at Netlify's edge before
// submit.js ever runs. This endpoint lets the browser upload a large PDF in
// pieces: it receives ONE base64 chunk per request and stores it in the
// extraction-payloads blob store under a temp key.
//
// This is a verbatim copy of audit-chunk.js, deployed as its own file on
// purpose: the RPA extractor and the signature-audit test harness must not
// share a live endpoint. The audit test harness is throwaway scaffolding; when
// it is deleted, the RPA extractor's upload path must not break. Same code,
// independent lifecycle.
//
// Flow:
//   1. Browser splits each PDF's base64 string into <limit pieces.
//   2. Browser POSTs each piece here: { uploadId, chunkIndex, totalChunks, data, label }
//   3. This function stores each piece at key `chunk:{uploadId}:{chunkIndex}`.
//   4. When all pieces are uploaded, the browser calls submit.js with just the
//      uploadId(s); submit.js assembles the pieces into the final payload.
//
// IMPORTANT: chunks are pieces of the ALREADY-base64-encoded PDF string. They
// are concatenated as strings on assembly — never re-encoded. base64 string
// concatenation is lossless as long as the original string was split, which it
// is (the browser holds each PDF as one base64 string and slices that).
//
// V2 NOTE: the chunk dance is a disposable adapter for Netlify's request cap.
// On a future S3 move (presigned uploads, no size ceiling) this whole file is
// deleted and submit.js goes back to a direct payload reference.
// ----------------------------------------------------------------------------

const { getStore } = require('@netlify/blobs');

console.log('[extract-chunk] module loading');

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
  // DIAGNOSTIC PROBE (temporary — remove after Blobs 401 is resolved).
  // Logs which env vars are actually injected, so we can tell whether the 401
  // is caused by a missing siteID (auto-injection gone) vs. a bad token vs.
  // something else. Uses !! to log only true/false — never the values.
  console.log('[extract-chunk] env probe:',
    'SITE_ID=', !!process.env.SITE_ID,
    'NETLIFY_SITE_ID=', !!process.env.NETLIFY_SITE_ID,
    'NETLIFY_PROJECT_ID=', !!process.env.NETLIFY_PROJECT_ID,
    'BLOBS_TOKEN=', !!process.env.NETLIFY_BLOBS_TOKEN
  );

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const { uploadId, chunkIndex, totalChunks, data, label } = body;

    // Validate — every field is required and must be sane.
    if (!uploadId || typeof uploadId !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing uploadId' }) };
    }
    if (typeof chunkIndex !== 'number' || chunkIndex < 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing or invalid chunkIndex' }) };
    }
    if (typeof totalChunks !== 'number' || totalChunks < 1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing or invalid totalChunks' }) };
    }
    if (typeof data !== 'string' || data.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing chunk data' }) };
    }
    if (chunkIndex >= totalChunks) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'chunkIndex out of range' }) };
    }

    // Store this chunk in the extraction-payloads store under a temp key.
    // Key convention: chunk:{uploadId}:{chunkIndex}
    // submit.js reads chunk:{uploadId}:0 .. chunk:{uploadId}:{totalChunks-1}
    // and concatenates them.
    const store = getStore(blobsConfig('extraction-payloads'));
    const chunkKey = `chunk:${uploadId}:${chunkIndex}`;

    await store.setJSON(chunkKey, {
      uploadId,
      chunkIndex,
      totalChunks,
      data,                       // a slice of the PDF's base64 string
      label: label || 'contract',
      storedAt: Date.now(),
    });

    console.log(`[extract-chunk] uploadId=${uploadId} stored chunk ${chunkIndex + 1}/${totalChunks} (${data.length} b64 chars)`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        uploadId,
        chunkIndex,
        totalChunks,
        received: true,
      }),
    };
  } catch (err) {
    console.error('[extract-chunk] error: ' + err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
