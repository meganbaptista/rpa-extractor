// netlify/functions/lib/shadow-log.js
//
// ============================================================================
// Shadow-mode comparison ledger (Email Router — see EMAIL-ROUTER-SPEC.md).
// ============================================================================
// Every routed message writes ONE decision record here so the cutover can be
// audited before it ever mutates real mail. Two things this must make obvious,
// per the owner's requirement:
//   • which branch + which RULE drove the decision (deciding_rule), so a
//     Branch A disagreement with the old Zaps can be confirmed as the INTENDED
//     improvement (rules 10–14 / quoted-history scoping) vs. a porting error.
//   • what the router WOULD have done vs. what it actually did (mode: shadow
//     logs the plan but applies nothing; live logs what it applied).
//
// Storage: a Netlify Blobs store, one record per message id (idempotent on
// re-runs), same pattern as the disclosure "seen" store. Also emits a compact
// one-line console summary so a quick scan of function logs is readable without
// opening blobs. Failure-isolated: a broken ledger must never fail routing.
// ============================================================================

const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'email-router-shadow';

function store() {
  return getStore({
    name: STORE_NAME,
    siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

// Build the durable record. `nowIso` is passed in (callers stamp time) so this
// module has no hidden clock dependency.
function buildRecord({ message, decision, mode, applied, nowIso }) {
  const h = (message && message.headers) || {};
  return {
    at: nowIso,
    mode,                         // 'shadow' | 'live'
    messageId: message && message.id,
    threadId: message && message.threadId,
    subject: h.subject || '',
    from: h.from || '',
    branch: decision.branch,      // 'A' | 'B'
    category: decision.category || null,
    side: decision.side || null,  // 'buyer' | 'seller' | null
    sideSource: decision.sideSource || null, // 'tag' | 'deal-list' | null
    skip: decision.skip,
    deciding_rule: decision.deciding_rule,   // which of the 14 rules drove it
    gate_reason: decision.reason || '',
    gate_confidence: decision.confidence || '',
    plannedLabel: decision.plannedLabel || null,     // what routing WANTS to apply
    classifier: decision.classifier || null,         // { person, confidence, reason } (Branch B)
    applied: applied || null,     // what was ACTUALLY done (null in shadow mode)
  };
}

// One-line human-readable summary for the function log.
function summarize(rec) {
  const bits = [
    `[shadow]`,
    rec.mode.toUpperCase(),
    `br=${rec.branch}`,
    rec.category ? `cat=${rec.category}` : null,
    `skip=${rec.skip}`,
    `rule=${rec.deciding_rule}`,
    rec.side ? `side=${rec.side}` : null,
    rec.plannedLabel ? `plan="${rec.plannedLabel}"` : null,
    rec.classifier ? `clf=${rec.classifier.assignee}@${rec.classifier.confidence}` : null,
    rec.applied ? `applied="${rec.applied.label || rec.applied.action}"` : null,
    `"${(rec.subject || '').slice(0, 48)}"`,
  ].filter(Boolean);
  return bits.join(' ');
}

// Record a decision. Never throws.
async function record({ message, decision, mode, applied, nowIso }) {
  const rec = buildRecord({ message, decision, mode, applied, nowIso });
  try {
    console.log(summarize(rec));
  } catch (_) { /* logging must never break routing */ }
  try {
    await store().setJSON(`${(nowIso || '').slice(0, 10)}/${rec.messageId}`, rec);
  } catch (err) {
    console.warn(`[shadow-log] blob write failed (non-fatal): ${err.message}`);
  }
  return rec;
}

// Write a minimal ERROR record so a message whose consumer failed still shows
// up in the viewer (as mode 'error') instead of vanishing. Same key scheme as a
// normal record. Never throws.
async function recordError({ messageId, subject = '', from = '', error = '', nowIso }) {
  const rec = {
    at: nowIso, mode: 'error', messageId, subject: subject || '(processing error)', from,
    branch: '', category: null, side: null, skip: false, deciding_rule: '',
    gate_reason: error, gate_confidence: '', plannedLabel: null, classifier: null, applied: null,
  };
  try { console.warn(`[shadow-log] ERROR ${messageId}: ${error}`); } catch (_) { /* noop */ }
  try {
    await store().setJSON(`${(nowIso || '').slice(0, 10)}/${messageId}`, rec);
  } catch (err) {
    console.warn(`[shadow-log] error-record write failed: ${err.message}`);
  }
  return rec;
}

// Read back the most recent decision records, newest first. Keys are
// `YYYY-MM-DD/messageId`, so sorting keys descending gives newest-first without
// fetching every blob's body to compare timestamps. `limit` caps how many we
// hydrate. Never throws — returns [] on any store error.
async function recent({ limit = 200 } = {}) {
  try {
    const s = store();
    const { blobs = [] } = await s.list();
    const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
    const recs = await Promise.all(keys.map((k) => s.get(k, { type: 'json' }).catch(() => null)));
    return recs.filter(Boolean);
  } catch (err) {
    console.warn(`[shadow-log] recent() read failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// FAST READS for the log page (2026-10-05). The page has 26 seconds. Listing
// the WHOLE store and reading ~6,000 records one by one timed it out, so:
//   - keys are listed by DATE PREFIX ("2026-10-04/"), only for the dates needed;
//   - bodies are fetched with wide concurrency;
//   - a CLOSED day's summary is computed once and cached in its own store, so
//     a normal load only reads today's records (plus any day not yet cached).
// ---------------------------------------------------------------------------
const DAILY_STORE = 'email-router-daily';
const DAILY_VERSION = 'v1';

function dailyStore() {
  return getStore({
    name: DAILY_STORE,
    siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

async function keysForDates(s, dates) {
  const lists = await Promise.all(dates.map((d) => s.list({ prefix: `${d}/` }).catch(() => ({ blobs: [] }))));
  return lists.flatMap((l) => (l.blobs || []).map((b) => b.key));
}

async function getMany(s, keys, width = 150) {
  const out = new Array(keys.length);
  let next = 0;
  async function worker() {
    while (next < keys.length) {
      const i = next++;
      out[i] = await s.get(keys[i], { type: 'json' }).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, keys.length) }, worker));
  return out.filter(Boolean);
}

const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date, n) => utcDate(Date.parse(`${date}T00:00:00Z`) + n * 86400000);

/**
 * The newest `limit` decisions by real time. Lists today's date prefix, then
 * earlier ones, until there are enough keys; never the whole store.
 */
async function recentFast({ limit = 200, nowMs = Date.now() } = {}) {
  try {
    const s = store();
    let keys = [];
    for (let i = 0; i < 14 && keys.length < limit; i++) {
      keys = keys.concat(await keysForDates(s, [utcDate(nowMs - i * 86400000)]));
    }
    const recs = await getMany(s, keys);
    return recs.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, limit);
  } catch (err) {
    console.warn(`[shadow-log] recentFast() read failed: ${err.message}`);
    return [];
  }
}

/**
 * Per-day conversation aggregates for the last `days` days (render.daily's
 * input). A day is closed an hour after it ends; closed days come from the
 * cache, and are written to it the first time they are computed.
 */
async function dailyAggregates({ days = 7, nowMs = Date.now(), render }) {
  const { windowStart } = render._internal;
  const today = windowStart(new Date(nowMs).toISOString());
  const windows = Array.from({ length: days }, (_, i) => addDays(today, -i));
  // A day that starts at 5:30 PM Pacific on date W ends at W+1 5:30 PM PT,
  // which is W+2 00:30/01:30 UTC at the latest; one hour of slack for late writes.
  const closed = (w) => Date.parse(`${addDays(w, 2)}T02:30:00Z`) + 3600000 < nowMs;
  const aggs = {};
  let cache = null;
  try { cache = dailyStore(); } catch (_) { cache = null; }
  if (cache) {
    const hits = await Promise.all(windows.filter(closed).map((w) =>
      cache.get(`${DAILY_VERSION}/${w}`, { type: 'json' }).then((v) => [w, v]).catch(() => [w, null])));
    for (const [w, v] of hits) if (v) aggs[w] = v;
  }
  // Newest first, inside a time budget: the page has 26 s, and the first load
  // after a deploy has nothing cached. A day not reached is marked pending and
  // computed (then cached) on a later load. Each day's records span 3 UTC
  // dates, shared with its neighbours, so each date is read once.
  const missing = windows.filter((w) => !aggs[w]);
  const deadline = Date.now() + 15000;
  const byDate = new Map();
  const s = missing.length ? store() : null;
  for (const w of missing) {
    if (Date.now() > deadline) { aggs[w] = { pending: true, threads: {}, own: 0 }; continue; }
    const dates = [addDays(w, 0), addDays(w, 1), addDays(w, 2)].filter((d) => !byDate.has(d));
    if (dates.length) {
      const recs = await getMany(s, await keysForDates(s, dates));
      for (const d of dates) byDate.set(d, []);
      for (const r of recs) { const d = String(r.at || '').slice(0, 10); if (byDate.has(d)) byDate.get(d).push(r); }
    }
    const recs = [addDays(w, 0), addDays(w, 1), addDays(w, 2)].flatMap((d) => byDate.get(d) || []);
    aggs[w] = render.aggregate(recs)[w] || { threads: {}, own: 0 };
    if (cache && closed(w)) await cache.setJSON(`${DAILY_VERSION}/${w}`, aggs[w]).catch(() => {});
  }
  // Drop days with nothing at all (before the router existed).
  for (const w of Object.keys(aggs)) if (!aggs[w].pending && !Object.keys(aggs[w].threads).length && !aggs[w].own) delete aggs[w];
  return aggs;
}

module.exports = { record, recordError, recent, recentFast, dailyAggregates, _internal: { buildRecord, summarize } };
