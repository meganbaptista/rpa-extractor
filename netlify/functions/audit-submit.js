// netlify/functions/audit-submit.js
//
// Synchronous function. Receives PDF payload from the frontend (well under
// the 6 MB sync request limit), stores it in the audit-payloads blob store,
// invokes the audit-background function with just a small {jobId} body,
// and returns the jobId for the frontend to poll on.
//
// This decouples the large PDF payload from the background function call,
// which has a 256 KB request body limit.

const { getStore } = require('@netlify/blobs');
const { randomUUID } = require('crypto');

exports.handler = async function (event) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };
  }

  try {
    const { pdfBase64, formId, buyerCount = 1, sellerCount = 1 } = JSON.parse(event.body || '{}');

    if (!pdfBase64 || !formId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'pdfBase64 and formId are required' }),
      };
    }

    const jobId = randomUUID();

    // Store the payload in the audit-payloads blob store
    const payloadStore = getStore('audit-payloads');
    await payloadStore.setJSON(jobId, {
      pdfBase64,
      formId,
      buyerCount,
      sellerCount,
      createdAt: Date.now(),
    });

    // Pre-write a "pending" status to audit-results so polling immediately sees a record
    const resultsStore = getStore('audit-results');
    await resultsStore.setJSON(jobId, {
      status: 'pending',
      queuedAt: Date.now(),
      formId,
    });

    // Invoke the background function with just the jobId.
    // Background functions return 202 immediately; we don't need to await
    // completion, but we do want to know the invocation was accepted.
    const host = event.headers.host;
    const protocol = event.headers['x-forwarded-proto'] || 'https';
    const bgUrl = `${protocol}://${host}/.netlify/functions/audit-background`;

    try {
      const bgResp = await fetch(bgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      console.log(`[audit-submit] jobId=${jobId} background invoke returned ${bgResp.status}`);
    } catch (err) {
      console.error(`[audit-submit] jobId=${jobId} background invoke failed:`, err.message);
      // Update the results record so the frontend sees the failure
      await resultsStore.setJSON(jobId, {
        status: 'error',
        completedAt: Date.now(),
        error: `Failed to invoke audit-background: ${err.message}`,
      });
      // Clean up the orphaned payload
      try { await payloadStore.delete(jobId); } catch (_) {}
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Failed to start audit job', jobId }),
      };
    }

    return {
      statusCode: 202,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, status: 'queued' }),
    };
  } catch (err) {
    console.error('[audit-submit] error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
