// netlify/functions/disclosure-watch-run.js
//
// Manual trigger for the watcher — a tight beta test loop so you don't wait for
// the 10-minute cron. Runs the SAME scan as disclosure-watch-poller.js.
// Safe to delete once the pipeline is live.
//
// USAGE (browser):
//   /.netlify/functions/disclosure-watch-run?dryRun=true
//     -> builds events and shows what WOULD dispatch; marks nothing seen; repeatable.
//   /.netlify/functions/disclosure-watch-run
//     -> a REAL run: publishes events and marks files seen. Only do this once the
//        splitter (or another consumer) exists, or dispatch will 404 (harmless,
//        but it will mark the file seen — re-drop it to reprocess later).

const { scanIncoming } = require('./lib/watch');

exports.handler = async function (event) {
  const q = (event && event.queryStringParameters) || {};
  const dryRun = ['1', 'true', 'yes'].includes(String(q.dryRun || '').toLowerCase());
  try {
    const summary = await scanIncoming({ dryRun });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(summary, null, 2),
    };
  } catch (err) {
    console.error('[watch-run] error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }, null, 2),
    };
  }
};
