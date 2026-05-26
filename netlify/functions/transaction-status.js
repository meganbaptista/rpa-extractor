// netlify/functions/transaction-status.js
//
// Polling endpoint for Call B (transaction-state). The frontend calls this with
// ?jobId=X to check on a running transaction-state reasoning job. It is a
// near-copy of audit-status.js, pointed at the transaction-results store
// instead of audit-results. The audit-status endpoint is left untouched.
//
// Returns one of:
//   { status: "pending", stage: "transaction", startedAt }
//   { status: "complete", completedAt, result: { prose, transaction_state } }
//   { status: "error", completedAt, error }
//   { status: "unknown" }  — no record found (Call B never started, or expired)
//
// Note: Call B is fanned out by the orchestrator additively. Until Call B
// writes its first record for a jobId, this returns "unknown" — the page
// should treat "unknown" as "not ready yet", not as a failure.

const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };
  }

  const jobId = event.queryStringParameters && event.queryStringParameters.jobId;
  if (!jobId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'jobId query parameter is required' }),
    };
  }

  try {
    const store = getStore({
      name: 'transaction-results',
      siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    const data = await store.get(jobId, { type: 'json' });

    if (!data) {
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'unknown', jobId }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, ...data }),
    };
  } catch (err) {
    console.error('[transaction-status] error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
