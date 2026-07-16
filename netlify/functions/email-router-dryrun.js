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

exports.handler = async function (event) {
  const q = (event && event.queryStringParameters) || {};
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
