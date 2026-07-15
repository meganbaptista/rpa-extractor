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
    side: decision.side || null,  // 'buyer' | 'seller' | null (from a side tag)
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

module.exports = { record, _internal: { buildRecord, summarize } };
