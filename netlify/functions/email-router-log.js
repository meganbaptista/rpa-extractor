// netlify/functions/email-router-log.js
//
// ============================================================================
// Shadow-log VIEWER for the Email Router (see EMAIL-ROUTER-SPEC.md).
// ============================================================================
// Reads the durable decision ledger (the 'email-router-shadow' Netlify Blobs
// store that shadow-log.js writes to) and renders it as a browser table, so you
// can review what the router decided WITHOUT scrolling ephemeral function logs.
// The Blobs store persists indefinitely; this just displays it. Read-only.
//
//   HTML (default):  /.netlify/functions/email-router-log
//   JSON:            /.netlify/functions/email-router-log?format=json
//   More rows:       /.netlify/functions/email-router-log?limit=500
//
// Columns: time, mode, branch, skip + which of the 14 rules fired, detected
// side, the label routing planned, the classifier's would-be assignee +
// confidence, what was actually applied (blank in shadow), sender, subject, and
// the reason. Every disagreement is attributable to the rule that drove it.
// ============================================================================

const shadowLog = require('./lib/shadow-log');
const render = require('./lib/shadow-render');

exports.handler = async function (event) {
  const q = (event && event.queryStringParameters) || {};
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 200, 1), 2000);
  const records = await shadowLog.recent({ limit });

  if (q.format === 'json') {
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: records.length, records }, null, 2) };
  }
  const html = render.page(records, {
    title: 'Email Router — shadow log',
    empty: 'No decisions logged yet. Enable EMAIL_ROUTER_ENABLED=true and wait for the poller.',
  });
  return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
};
