// netlify/functions/email-route-background.js
//
// ============================================================================
// CONSUMER for the Email Router (see EMAIL-ROUTER-SPEC.md). One invocation per
// message, fanned out by email-route-poller. Being a *-background function it
// returns 202 immediately and may run up to the background time limit, so the
// per-message Claude calls (skip gate + optional classifier) have headroom.
// ============================================================================
// Steps:
//   1. Fetch the message (headers + body + current-attachment flag).
//   2. Resolve its label ids -> display names (the router matches categories by name).
//   3. router.route() -> a DECISION (branch, skip, deciding_rule, planned label, …).
//   4. shadow-log.record() -> durable audit line (always, both modes).
//   5. If ROUTER.mode === 'live', APPLY the decision to Gmail. In 'shadow' mode
//      we mutate NOTHING — decide + log only.
//
// Idempotent: the poller's seen-store means we normally see a message once, but
// applying labels is naturally idempotent (adding an existing label is a no-op),
// so a duplicate delivery does no harm.
// ============================================================================

const gmail = require('./lib/gmail');
const cfg = require('./lib/routing-config');
const router = require('./lib/email-router');
const shadowLog = require('./lib/shadow-log');

// Resolve the message's label ids to display names, so the router can match
// category labels by their human names (as configured).
async function labelNamesFor(labelIds) {
  if (!labelIds || !labelIds.length) return [];
  const all = await gmail.listLabels();
  const byId = new Map(all.map((l) => [l.id, l.name]));
  return labelIds.map((id) => byId.get(id)).filter(Boolean);
}

// Apply a decision to Gmail (LIVE mode only). Returns a summary of what was done.
async function applyDecision(message, decision) {
  const actions = decision.actions || {};
  const addLabelIds = [];
  // Person / Needs-Attention labels are ours -> ensure (auto-create). Category
  // labels are never in addLabels (Branch A applies a PERSON label), so every
  // name here is one we own and may create.
  for (const name of actions.addLabels || []) {
    // eslint-disable-next-line no-await-in-loop
    addLabelIds.push(await gmail.ensureLabel(name));
  }
  const removeLabelIds = [];
  if (actions.removeIntake) removeLabelIds.push(await gmail.labelId(cfg.LABELS.intake));
  if (actions.markRead) removeLabelIds.push('UNREAD');

  if (addLabelIds.length || removeLabelIds.length) {
    await gmail.modifyMessage(message.id, { add: addLabelIds, remove: removeLabelIds });
  }
  return {
    action: decision.skip ? 'skip' : `route_${decision.branch}`,
    label: (actions.addLabels || [])[0] || null,
    removedIntake: !!actions.removeIntake,
    markedRead: !!actions.markRead,
  };
}

// Stamp time at the boundary (scripts/libs stay clock-free).
function nowIso() {
  return new Date().toISOString();
}

exports.handler = async function (event) {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return { statusCode: 400, body: 'bad json' };
  }
  const { messageId } = body;
  if (!messageId) return { statusCode: 400, body: 'missing messageId' };

  try {
    const message = await gmail.getMessage(messageId);
    const labelNames = await labelNamesFor(message.labelIds);

    const decision = await router.route(message, labelNames);

    const mode = cfg.ROUTER.mode; // 'shadow' | 'live'
    let applied = null;
    if (mode === 'live') {
      applied = await applyDecision(message, decision);
    }

    await shadowLog.record({ message, decision, mode, applied, nowIso: nowIso() });
    return { statusCode: 200 };
  } catch (err) {
    console.error(`[email-route-background] ${messageId} failed: ${err.message}`);
    // 500 so a transient failure isn't marked "done" — the poller's seen store
    // already recorded dispatch, so re-processing needs a manual re-drop or a
    // seen-store clear; keep the loud log so failures are visible.
    return { statusCode: 500, body: err.message };
  }
};
