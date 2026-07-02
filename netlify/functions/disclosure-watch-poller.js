// netlify/functions/disclosure-watch-poller.js
//
// Scheduled producer for the Disclosure Intake Pipeline (see
// DISCLOSURE-INTAKE-PIPELINE.md). Runs on the cron set in netlify.toml
// ([functions."disclosure-watch-poller"] schedule = "*/10 * * * *"), scans every
// Incoming folder, and emits a `disclosure.uploaded` event per new PDF.
//
// The heavy work lives in the consumers; this function only lists Drive and fires
// fast fan-out POSTs (consumers are background functions that 202 immediately), so
// it stays well under the function time limit for a normal deal volume.

const { scanIncoming } = require('./lib/watch');

exports.handler = async function () {
  try {
    const summary = await scanIncoming();
    console.log('[watch-poller]', JSON.stringify(summary));
    return { statusCode: 200 };
  } catch (err) {
    console.error('[watch-poller] error:', err.message);
    return { statusCode: 500 };
  }
};
