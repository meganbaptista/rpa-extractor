// netlify/functions/submit.js
//
// Synchronous front door. Receives a PDF upload payload, stamps it with a
// jobId, persists a "pending" record, kicks off the background function that
// will do the real work, and returns the jobId to the caller — all in well
// under one second. The frontend then polls /result?jobId=... for the
// finished output.
//
// Payload shape (identical to legacy /extract endpoint so callers can switch
// over with minimal changes):
//   { documents: [{ data: <base64>, label: <string> }], prompt_override?: <string> }
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

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const JOB_TTL_HOURS = 24;

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    if (!body.documents || !Array.isArray(body.documents) || body.documents.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No documents provided' }) };
    }

    const jobId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + JOB_TTL_HOURS * 60 * 60 * 1000);

    // Persist pending record FIRST, before invoking the background function.
    // Order matters: if the background function starts and finishes before we
    // write the pending record, our setJSON here would clobber the completed
    // record. By writing pending first, the background function's eventual
    // write of 'complete' or 'failed' wins as expected.
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
        body: JSON.stringify({ jobId: jobId, documents: body.documents, prompt_override: body.prompt_override })
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
