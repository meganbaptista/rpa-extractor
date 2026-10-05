// netlify/functions/lib/shadow-render.js
//
// ============================================================================
// Shared HTML/JSON renderer for Email Router decision records (see
// EMAIL-ROUTER-SPEC.md). Used by both the shadow-log viewer (email-router-log)
// and the on-demand dry-run re-scorer (email-router-dryrun) so they display
// identically. A "record" is the shape lib/shadow-log.js buildRecord() produces.
// ============================================================================

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

// The decision time in Pacific, like the daily summary: "2026-10-03 5:06:13 PM".
const PT_ROW = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
});
function ptTime(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return String(iso || '');
  const p = Object.fromEntries(PT_ROW.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${p.dayPeriod}`;
}

function rows(records) {
  return records.map((r) => {
    const skip = r.skip ? 'SKIP' : 'route';
    const applied = r.applied ? (r.applied.label || r.applied.action) : '';
    return `<tr>
      <td class="mono">${esc(ptTime(r.at))}</td>
      <td>${esc(r.mode)}</td>
      <td class="ctr">${esc(r.branch)}</td>
      <td class="${r.skip ? 'skip' : ''}">${skip}${r.gate_confidence ? `<br><span style="color:#999;font-size:11px">${esc(r.gate_confidence)}</span>` : ''}</td>
      <td class="ctr">${esc(r.deciding_rule)}</td>
      <td class="ctr">${esc(r.side || '')}${r.sideSource ? `<br><span style="color:#999;font-size:11px">${esc(r.sideSource)}</span>` : ''}</td>
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
  return `<p class="sum"><b>${n}</b> decisions &nbsp;·&nbsp; <b>${skipped}</b> skipped, <b>${n - skipped}</b> routed &nbsp;·&nbsp; ${modes}</p>
    <p class="sum">planned labels — ${planned || '(none)'}</p>`;
}

// ---------------------------------------------------------------------------
// DAILY SUMMARY (2026-10-05). Megan tracks how much lands on Belle: her own
// label plus Needs Attention, which Belle triages. A "day" is 5:30 PM to
// 5:30 PM Pacific, her team's working day, so an email at 6 PM counts toward
// tomorrow. Pacific time comes from Intl, so daylight saving is handled.
// ---------------------------------------------------------------------------
const DAY_START_MIN = 17 * 60 + 30;
const PT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** The Pacific date (YYYY-MM-DD) on which this timestamp's 5:30 PM day began. */
function windowStart(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const p = Object.fromEntries(PT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day);
  const before = (+p.hour * 60 + +p.minute) < DAY_START_MIN;
  return new Date(before ? local - 86400000 : local).toISOString().slice(0, 10);
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(start) {
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(a.getTime() + 86400000);
  const f = (d) => `${WD[d.getUTCDay()]} ${MO[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return `${f(a)} 5:30 PM to ${f(b)} 5:30 PM`;
}

/** The labels an email ended up with: "Belle + Megan" is two. */
function labelsOf(r) {
  return String(r.plannedLabel || '').split('+').map((x) => x.trim()).filter(Boolean);
}

// Our OWN mail is not incoming: a reply of ours that lands back in the inbox, or
// a notice sent from our account (AutoCrat). Megan counts incoming only.
const OWN_DOMAINS = String(process.env.ROUTER_OWN_DOMAINS || 'mytcconcierge.com')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
function isOwnMail(r) {
  const addr = String((r && r.from) || '').toLowerCase().split('<').pop().replace(/>.*$/, '').trim();
  const dom = addr.split('@').pop();
  return OWN_DOMAINS.includes(dom);
}

/**
 * Counted in CONVERSATIONS, not emails (Megan, 2026-10-05: "we don't want to
 * count how many emails are in the thread"). A thread is counted once per day
 * under each label any of its messages got that day; a thread whose messages
 * were all skipped / no-tag that day is "cleared". A record with no threadId
 * stands alone (keyed by its messageId).
 *
 * Split in two so a CLOSED day can be cached (see shadow-log.dailyAggregates):
 * aggregate() turns records into { day: { threads: {id: [labels]}, own } },
 * and daily() renders those. 7 days at ~800 emails/day is ~6,000 records,
 * which timed out the page (26 s cap) when every load re-read them all.
 */
function aggregate(records) {
  const out = {};
  for (const r of records || []) {
    if (!r || r.mode === 'error') continue;
    const key = windowStart(r.at);
    if (!key) continue;
    if (!out[key]) out[key] = { threads: {}, own: 0 };
    if (isOwnMail(r)) { out[key].own++; continue; }
    const t = r.threadId || `msg:${r.messageId || r.at}`;
    const set = new Set(out[key].threads[t] || []);
    for (const l of labelsOf(r)) set.add(l);
    out[key].threads[t] = [...set];
  }
  return out;
}

function daily(aggs, { nowIso = new Date().toISOString() } = {}) {
  const NA = 'Needs Attention';
  const keys = Object.keys(aggs || {});
  if (!keys.length) return '';
  const people = new Set();
  let ownSkipped = 0;
  for (const k of keys) {
    ownSkipped += aggs[k].own || 0;
    for (const ls of Object.values(aggs[k].threads)) for (const l of ls) if (l !== 'Belle' && l !== NA) people.add(l);
  }
  const others = [...people].sort();
  const current = windowStart(nowIso);
  const head = ['Day (Pacific)', 'Conversations', 'Belle', NA, 'Belle + NA', ...others, 'Cleared']
    .map((h) => `<th>${esc(h)}</th>`).join('');
  const body = keys.sort().reverse().map((k) => {
    if (aggs[k].pending) {
      return `<tr><td>${esc(dayLabel(k))}</td><td colspan="${6 + others.length}" style="color:#999">still counting, refresh the page in a moment</td></tr>`;
    }
    const threads = Object.values(aggs[k].threads).map((ls) => new Set(ls));
    const n = (fn) => threads.filter(fn).length;
    const has = (l) => (ls) => ls.has(l);
    const cell = (v, bold) => `<td class="ctr">${bold ? '<b>' : ''}${v || 0}${bold ? '</b>' : ''}</td>`;
    return `<tr><td>${esc(dayLabel(k))}${k === current ? ' <span style="color:#999">(so far)</span>' : ''}</td>`
      + cell(threads.length) + cell(n(has('Belle')), true) + cell(n(has(NA)), true)
      + cell(n((ls) => ls.has('Belle') || ls.has(NA)), true)
      + others.map((o) => cell(n(has(o)))).join('') + cell(n((ls) => !ls.size)) + '</tr>';
  }).join('\n');
  return `<h2 style="font-size:15px;margin:14px 0 2px">Daily summary</h2>
<p class="note">Counted in conversations: an email thread counts once per day, however many replies it had. Incoming email only: ${ownSkipped} sent from our own address (${esc(OWN_DOMAINS.join(', '))}) not counted. Each day runs 5:30 PM to 5:30 PM Pacific. A conversation is counted under every label it got that day, so the person columns can add up to more than the total; "Belle + NA" counts it once. "Cleared" = every message that day was skipped or needed no tag.</p>
<table style="width:auto"><thead><tr>${head}</tr></thead><tbody>
${body}
</tbody></table>`;
}

function page(records, { title = 'Email Router — decisions', note = '', empty = 'No decisions.', dailyAggs = null } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;margin:20px;color:#111}
  h1{font-size:18px;margin:0 0 4px}
  .sum{margin:2px 0;color:#333}
  .note{margin:2px 0 8px;color:#666}
  table{border-collapse:collapse;width:100%;margin-top:12px}
  th,td{border:1px solid #ddd;padding:4px 7px;text-align:left;vertical-align:top}
  th{background:#f4f4f4;position:sticky;top:0}
  .mono{font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
  .ctr{text-align:center}
  .skip{color:#888}
  .reason{color:#555;max-width:320px}
  tr:nth-child(even){background:#fafafa}
</style></head><body>
<h1>${esc(title)}</h1>
${note ? `<p class="note">${esc(note)}</p>` : ''}
${dailyAggs ? daily(dailyAggs) : ''}
<h2 style="font-size:15px;margin:16px 0 2px">Latest ${records.length} decisions</h2>
${summary(records)}
<table>
<thead><tr><th>time (Pacific)</th><th>mode</th><th>br</th><th>skip</th><th>rule</th><th>side</th><th>planned</th><th>classifier</th><th>applied</th><th>from</th><th>subject</th><th>reason</th></tr></thead>
<tbody>
${rows(records) || `<tr><td colspan="12">${esc(empty)}</td></tr>`}
</tbody></table>
</body></html>`;
}

module.exports = { page, rows, summary, daily, aggregate, esc, clf, _internal: { windowStart, dayLabel, ptTime } };
