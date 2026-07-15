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

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clf(rec) {
  const c = rec.classifier;
  if (!c) return '';
  const conf = typeof c.confidence === 'number' ? c.confidence.toFixed(2) : c.confidence;
  return `${c.assignee || '?'} @${conf}`;
}

function rows(records) {
  return records.map((r) => {
    const skip = r.skip ? 'SKIP' : 'route';
    const applied = r.applied ? (r.applied.label || r.applied.action) : '';
    return `<tr>
      <td class="mono">${esc((r.at || '').replace('T', ' ').slice(0, 19))}</td>
      <td>${esc(r.mode)}</td>
      <td class="ctr">${esc(r.branch)}</td>
      <td class="${r.skip ? 'skip' : ''}">${skip}</td>
      <td class="ctr">${esc(r.deciding_rule)}</td>
      <td class="ctr">${esc(r.side || '')}</td>
      <td><b>${esc(r.plannedLabel || '')}</b></td>
      <td>${esc(clf(r))}</td>
      <td>${esc(applied)}</td>
      <td>${esc(r.from)}</td>
      <td>${esc(r.subject)}</td>
      <td class="reason">${esc(r.gate_reason || '')}</td>
    </tr>`;
  }).join('\n');
}

function summary(records) {
  const n = records.length;
  const skipped = records.filter((r) => r.skip).length;
  const byMode = {};
  const byPlanned = {};
  for (const r of records) {
    byMode[r.mode] = (byMode[r.mode] || 0) + 1;
    if (r.plannedLabel) byPlanned[r.plannedLabel] = (byPlanned[r.plannedLabel] || 0) + 1;
  }
  const planned = Object.entries(byPlanned).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)}: ${v}`).join(' &nbsp;·&nbsp; ');
  const modes = Object.entries(byMode).map(([k, v]) => `${esc(k)}: ${v}`).join(', ');
  return `<p class="sum"><b>${n}</b> decisions &nbsp;·&nbsp; <b>${skipped}</b> skipped, <b>${n - skipped}</b> routed &nbsp;·&nbsp; mode ${modes}</p>
    <p class="sum">planned labels — ${planned || '(none)'}</p>`;
}

function page(records) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Email Router — shadow log</title>
<style>
  body{font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;margin:20px;color:#111}
  h1{font-size:18px;margin:0 0 4px}
  .sum{margin:2px 0;color:#333}
  table{border-collapse:collapse;width:100%;margin-top:12px}
  th,td{border:1px solid #ddd;padding:4px 7px;text-align:left;vertical-align:top}
  th{background:#f4f4f4;position:sticky;top:0}
  .mono{font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
  .ctr{text-align:center}
  .skip{color:#888}
  .reason{color:#555;max-width:320px}
  tr:nth-child(even){background:#fafafa}
</style></head><body>
<h1>Email Router — shadow log</h1>
${summary(records)}
<table>
<thead><tr><th>time</th><th>mode</th><th>br</th><th>skip</th><th>rule</th><th>side</th><th>planned</th><th>classifier</th><th>applied</th><th>from</th><th>subject</th><th>reason</th></tr></thead>
<tbody>
${rows(records) || '<tr><td colspan="12">No decisions logged yet. Enable EMAIL_ROUTER_ENABLED=true and wait for the poller.</td></tr>'}
</tbody></table>
</body></html>`;
}

exports.handler = async function (event) {
  const q = (event && event.queryStringParameters) || {};
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 200, 1), 2000);
  const records = await shadowLog.recent({ limit });

  if (q.format === 'json') {
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: records.length, records }, null, 2) };
  }
  return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: page(records) };
};
