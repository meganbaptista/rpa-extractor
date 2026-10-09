// netlify/functions/email-router-dryrun.js
//
// ============================================================================
// On-demand DRY-RUN re-scorer for the Email Router (see EMAIL-ROUTER-SPEC.md).
// ============================================================================
// A tuning tool. Hit this URL and it re-evaluates EVERYTHING currently in the
// INTAKE - REVIEW queue against the CURRENT rules and shows the decisions as a
// table — so after a config tweak you can instantly see whether the whole queue
// (including mail already processed in the real shadow run) now routes the way
// you want.
//
// It is stricter-than-shadow SAFE:
//   - MUTATES NOTHING in Gmail (never applies labels / marks read), regardless
//     of ROUTER.mode.
//   - IGNORES the "seen" store, so already-processed mail is re-scored.
//   - Does NOT write to the shadow log (this is a scratch re-score, not history).
//
// It DOES make real skip-gate (Haiku) + classifier (Opus) calls per message, so
// it costs a little each run. Processes messages in parallel and caps the count
// so a browser-facing (synchronous) call returns within the function timeout.
//
//   HTML (default):   /.netlify/functions/email-router-dryrun
//   JSON:             /.netlify/functions/email-router-dryrun?format=json
//   Cap:              /.netlify/functions/email-router-dryrun?limit=10   (default 20)
//   Score a LABEL:    /.netlify/functions/email-router-dryrun?label=Buyer Disclosures
//   Score a SEARCH:   /.netlify/functions/email-router-dryrun?q=subject:"600 W California"
// Default scores the INTAKE - REVIEW queue. ?label= / ?q= let you re-score any
// mail (e.g. a message that already left the queue) to test routing on demand.
// ============================================================================

const gmail = require('./lib/gmail');
const cfg = require('./lib/routing-config');
const router = require('./lib/email-router');
const shadowLog = require('./lib/shadow-log');
const render = require('./lib/shadow-render');
const dealSide = require('./lib/deal-side');

async function labelNamesFor(labelIds, allLabels) {
  if (!labelIds || !labelIds.length) return [];
  const byId = new Map(allLabels.map((l) => [l.id, l.name]));
  return labelIds.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * PHISHING-ONLY SWEEP. ?phishing=1 runs ONLY lib/phishing-check over recent
 * inbox mail (default: newer_than:14d, not from us) and lists what it would
 * flag and why. No model calls, nothing applied, so it is free and safe. Built
 * 2026-10-09 to answer "is it going to do that on all escrow signature lines?"
 * with real mail instead of a guess.
 *   /.netlify/functions/email-router-dryrun?phishing=1
 *   /.netlify/functions/email-router-dryrun?phishing=1&q=newer_than:30d&limit=300
 */
async function phishingSweep(q) {
  const phishing = require('./lib/phishing-check');
  const search = q.q || 'in:inbox newer_than:14d -from:me';
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 150, 1), 400);
  const started = Date.now();
  const ids = (await gmail.listMessages({ q: search, maxPages: 5 })).slice(0, limit);
  const rows = [];
  for (let i = 0; i < ids.length; i += 20) {
    if (Date.now() - started > 20000) break; // stay inside the function timeout
    const batch = await Promise.all(ids.slice(i, i + 20).map(async (m) => {
      try {
        const message = await gmail.getMessage(m.id);
        const r = phishing.check(message);
        const h = message.headers || {};
        return { from: h.from || '', subject: h.subject || '', date: h.date || '', flagged: r.suspicious,
          reasons: r.suspicious ? r.reasons : [], weak: r.suspicious ? [] : r.weak };
      } catch (e) { return { from: '', subject: `(error ${m.id})`, date: '', flagged: false, reasons: [e.message], weak: [] }; }
    }));
    rows.push(...batch);
  }
  rows.sort((a, b) => Number(b.flagged) - Number(a.flagged));
  const esc = (x) => String(x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const flagged = rows.filter((r) => r.flagged).length;
  const body = `<html><head><meta charset="utf-8"><title>Phishing sweep</title></head>
<body style="font-family:-apple-system,Arial,sans-serif;font-size:13px;margin:20px">
<h2>Phishing check sweep: ${flagged} of ${rows.length} would be flagged</h2>
<p>Search: <code>${esc(search)}</code>. Nothing was labelled or changed. Rows below the flagged ones show any single weak sign (not enough to flag).</p>
<table cellpadding="6" style="border-collapse:collapse">
<tr style="background:#eee"><th align="left">Flag</th><th align="left">From</th><th align="left">Subject</th><th align="left">Why</th></tr>
${rows.map((r) => `<tr style="border-top:1px solid #ddd;${r.flagged ? 'background:#fdecea' : ''}"><td>${r.flagged ? '\u26A0\uFE0F' : ''}</td>`
    + `<td>${esc(r.from)}</td><td>${esc(r.subject)}</td><td>${esc((r.flagged ? r.reasons : r.weak).join('; '))}</td></tr>`).join('\n')}
</table></body></html>`;
  return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body };
}

/**
 * INSPECTION BACKFILL / PREVIEW. ?inspections=1 runs lib/inspection-filer over
 * recent emails with attachments: which deal folder it would use and what it
 * would name each file, saving NOTHING. Add &apply=1 to actually file them
 * (same "only when sure" rules; a file already there is skipped, so re-running
 * cannot duplicate). Built 2026-10-09 for the reports that arrived before
 * filing went live.
 *   /.netlify/functions/email-router-dryrun?inspections=1
 *   /.netlify/functions/email-router-dryrun?inspections=1&q=newer_than:7d has:attachment&apply=1
 */
async function inspectionSweep(q) {
  const filer = require('./lib/inspection-filer');
  const apply = q.apply === '1';
  const search = q.q || 'in:inbox has:attachment newer_than:3d';
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 120, 1), 300);
  const started = Date.now();
  const ids = (await gmail.listMessages({ q: search, maxPages: 3 })).slice(0, limit);
  const rows = [];
  let looked = 0;
  for (const m of ids) {
    if (Date.now() - started > 22000) break; // stay inside the function timeout
    looked++;
    try {
      const message = await gmail.getMessage(m.id);
      if (!filer._internal.pickFiles(message, {}).pdfs.length) continue; // not an inspection email
      const r = await filer.fileInspectionReports(message, {}, { preview: !apply });
      if (!r) continue; // skipped on purpose (our own email, filing off): nothing to show
      const h = message.headers || {};
      rows.push({ subject: h.subject || '', from: h.from || '', result: r });
    } catch (e) { rows.push({ subject: `(error ${m.id})`, from: '', result: { filed: [], why: e.message } }); }
  }
  const esc = (x) => String(x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ok = rows.filter((r) => r.result && r.result.filed && r.result.filed.length).length;
  const body = `<html><head><meta charset="utf-8"><title>Inspection filing ${apply ? '' : 'preview'}</title></head>
<body style="font-family:-apple-system,Arial,sans-serif;font-size:13px;margin:20px">
<h2>Inspection filing ${apply ? '<span style="color:#2e7d32">APPLIED</span>' : 'PREVIEW (nothing saved)'}: ${ok} of ${rows.length} inspection emails ${apply ? 'filed' : 'would file'}</h2>
<p>Search: <code>${esc(search)}</code>, ${looked} of ${ids.length} emails checked${looked < ids.length ? ' (time limit; narrow the search or run again)' : ''}.
${apply ? '' : 'Add <code>&amp;apply=1</code> to the address to file them for real.'}</p>
<table cellpadding="6" style="border-collapse:collapse">
<tr style="background:#eee"><th align="left">Email</th><th align="left">From</th><th align="left">Deal folder</th><th align="left">${apply ? 'Filed as' : 'Would file as'} / why not</th></tr>
${rows.map((r) => { const x = r.result || {}; const good = x.filed && x.filed.length;
    return `<tr style="border-top:1px solid #ddd;${good ? 'background:#e8f5e9' : ''}"><td>${esc(r.subject)}</td><td>${esc(r.from)}</td>`
      + `<td>${esc(x.folder || '')}</td><td>${good ? esc(x.filed.join('<br>')).replace(/&lt;br&gt;/g, '<br>') : esc(filer.summary(x).replace(/^INSPECTION\s*/, ''))}</td></tr>`; }).join('\n')}
</table></body></html>`;
  return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body };
}

exports.handler = async function (event) {
  const q = (event && event.queryStringParameters) || {};
  if (q.inspections) {
    try { return await inspectionSweep(q); } catch (e) { return { statusCode: 500, body: `inspection sweep failed: ${e.message}` }; }
  }
  if (q.phishing) {
    try { return await phishingSweep(q); } catch (e) { return { statusCode: 500, body: `phishing sweep failed: ${e.message}` }; }
  }
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 60);
  const nowIso = new Date().toISOString();

  let records = [];
  let errorNote = '';
  let scored = `the ${cfg.LABELS.intake} queue`;
  try {
    const allLabels = await gmail.listLabels();
    // What to score: a Gmail search (?q=), a named label (?label=), or the
    // default INTAKE - REVIEW queue.
    let listOpts;
    if (q.q) {
      listOpts = { q: q.q };
      scored = `search "${q.q}"`;
    } else if (q.label) {
      listOpts = { labelIds: [await gmail.labelId(q.label)] };
      scored = `label "${q.label}"`;
    } else {
      listOpts = { labelIds: [await gmail.labelId(cfg.LABELS.intake)] };
    }
    const msgs = await gmail.listMessages(listOpts);
    const slice = msgs.slice(0, limit);

    records = await Promise.all(slice.map(async (m) => {
      try {
        const message = await gmail.getMessage(m.id);
        // Read the THREAD's labels for routing context (deal-level side/category
        // labels aren't copied onto fresh replies) — same as the live consumer.
        const threadLabelIds = await gmail.getThreadLabelIds(message.threadId);
        const labelNames = await labelNamesFor(threadLabelIds, allLabels);
        const decision = await router.route(message, labelNames);
        // Build the same record shape the viewer renders; applied stays null
        // because a dry run never applies anything.
        return shadowLog._internal.buildRecord({ message, decision, mode: 'dry-run', applied: null, nowIso });
      } catch (err) {
        return { at: nowIso, mode: 'dry-run', subject: `(error on ${m.id})`, gate_reason: err.message, branch: '', skip: false, deciding_rule: '', from: '', plannedLabel: '', classifier: null, applied: null };
      }
    }));

    if (msgs.length > slice.length) {
      errorNote = `Showing ${slice.length} of ${msgs.length} in the queue — pass ?limit= to see more.`;
    }
  } catch (err) {
    errorNote = `Error: ${err.message}`;
  }

  if (q.format === 'json') {
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: records.length, note: errorNote, records }, null, 2) };
  }
  const ds = await dealSide.status();
  const dealNote = !ds.configured
    ? 'Deal-side list: not configured (set DEALS_SHEET_ID).'
    : ds.error
      ? `Deal-side list: ERROR — ${ds.error}`
      : `Deal-side list: ${ds.count} deals from tab(s) [${ds.tabs.join(', ')}].`;
  const html = render.page(records, {
    title: `Email Router — dry run (${scored})`,
    note: `Re-scored live against the current rules. Nothing applied, nothing marked read, seen-store ignored. ${dealNote} ${errorNote}`,
    empty: `Nothing matched ${scored}.`,
  });
  return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
};
