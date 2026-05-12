// netlify/functions/extract-background.js
//
// Netlify background function (15-minute timeout, no HTTP response back to
// caller). Invoked async by submit.js. Wraps the existing extract.js handler
// so all the extraction logic — detection, trim, main+targeted parallel
// calls, image fallback, anti-swap rules — is reused without duplication.
//
// The filename suffix `-background.js` is what triggers background mode on
// Netlify. There's no separate config to declare it; the suffix IS the
// declaration.
//
// Body shape (received from submit.js):
//   { jobId, documents, prompt_override? }
//
// Side effect: writes a status record to the 'extraction-jobs' blob store
// keyed by jobId. The frontend polls /result?jobId=... to read it.

const { connectLambda, getStore } = require('@netlify/blobs');
const extractModule = require('./extract.js');

exports.handler = async function(event) {
  let jobId = null;
  let existing = {};
  let store;

  try {
    // Blobs requires explicit Lambda context wiring in Lambda-compat mode.
    connectLambda(event);

    const body = event.body ? JSON.parse(event.body) : {};
    jobId = body.jobId;

    if (!jobId) {
      console.error('extract-background invoked without jobId');
      return { statusCode: 400 };
    }

    store = getStore('extraction-jobs');

    // Read the existing pending record so we preserve submitted_at and
    // expires_at when we overwrite with the completed/failed state.
    existing = (await store.get(jobId, { type: 'json' })) || {};

    console.log('extract-background: starting job ' + jobId);
    const startedAt = Date.now();

    // Invoke the existing extract.js handler as if it were being called over
    // HTTP. It runs the full pipeline (detection, trim, main+targeted calls,
    // image fallback, merge) and returns an HTTP-shaped result. We strip
    // jobId from the body since extract.js doesn't expect it.
    const proxiedEvent = {
      httpMethod: 'POST',
      headers: event.headers || {},
      body: JSON.stringify({
        documents: body.documents,
        prompt_override: body.prompt_override
      })
    };

    const extractResult = await extractModule.handler(proxiedEvent, {});
    const durationMs = Date.now() - startedAt;
    console.log('extract-background: extract.js returned status ' + extractResult.statusCode + ' in ' + durationMs + 'ms');

    if (extractResult.statusCode === 200) {
      // extract.js returns the field JSON wrapped in an Anthropic-shaped
      // response with content[0].text holding the actual JSON string. The
      // frontend that ate /extract directly parsed it that way; keep the
      // same shape in 'result' so callers don't have to change parsing.
      let parsedResult;
      try {
        parsedResult = JSON.parse(extractResult.body);
      } catch (parseErr) {
        parsedResult = extractResult.body;
      }
      await store.setJSON(jobId, {
        ...existing,
        status: 'complete',
        result: parsedResult,
        completed_at: new Date().toISOString(),
        duration_ms: durationMs
      });
      console.log('extract-background: job ' + jobId + ' complete');
    } else {
      // extract.js returned a non-200 — treat as failure and surface the body.
      let errMsg = 'Extraction returned status ' + extractResult.statusCode;
      try {
        const errBody = JSON.parse(extractResult.body);
        if (errBody.error && errBody.error.message) {
          errMsg = errBody.error.message;
        }
      } catch (_) { /* ignore parse errors */ }
      await store.setJSON(jobId, {
        ...existing,
        status: 'failed',
        error: errMsg,
        failed_at: new Date().toISOString(),
        duration_ms: durationMs
      });
      console.warn('extract-background: job ' + jobId + ' failed — ' + errMsg);
    }

    return { statusCode: 200 };
  } catch (err) {
    console.error('extract-background error: ' + err.message);
    if (jobId && store) {
      try {
        await store.setJSON(jobId, {
          ...existing,
          status: 'failed',
          error: err.message,
          failed_at: new Date().toISOString()
        });
      } catch (writeErr) {
        console.error('extract-background: also failed to write failure status: ' + writeErr.message);
      }
    }
    return { statusCode: 500 };
  }
};
