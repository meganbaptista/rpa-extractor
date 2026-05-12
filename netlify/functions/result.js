// netlify/functions/result.js
//
// Polled by the frontend every ~2 seconds after submission. Returns the
// current state of the job — one of:
//   • { status: 'pending', submitted_at, expires_at }
//   • { status: 'complete', result, submitted_at, completed_at, expires_at }
//     where result is the full extraction JSON (same shape the legacy
//     /extract endpoint returned in data.content[0].text)
//   • { status: 'failed', error, submitted_at, failed_at, expires_at }
//
// Status codes:
//   200 — job exists, returning current state
//   400 — no jobId in query string
//   404 — jobId unknown
//   410 — job expired (older than 24h)

const { getStore } = require('@netlify/blobs');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
  // Discourage CDN caching since the value changes during polling.
  'Cache-Control': 'no-store'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const jobId = event.queryStringParameters && event.queryStringParameters.jobId;
  if (!jobId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'jobId query parameter required' }) };
  }

  try {
    const store = getStore('extraction-jobs');
    const data = await store.get(jobId, { type: 'json' });

    if (!data) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Job not found' }) };
    }

    // Treat expired jobs as gone even if the blob is still on disk.
    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
      return { statusCode: 410, headers, body: JSON.stringify({ error: 'Job expired' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    console.error('result lookup error: ' + err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
