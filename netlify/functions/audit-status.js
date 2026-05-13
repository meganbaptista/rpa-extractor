// netlify/functions/audit-status.js
//
// Polling endpoint. Frontend calls this with ?jobId=X to check on a running
// audit. Returns one of:
//   { status: "pending", startedAt, formId }
//   { status: "complete", completedAt, result: {...full audit output...} }
//   { status: "error", completedAt, error, ... }
//   { status: "unknown" }  — no record found (job never started, or expired)

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
  name: 'audit-results',
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
    console.error('[audit-status] error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
