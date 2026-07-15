// netlify/functions/lib/email-router.js
//
// ============================================================================
// The routing brain (Email Router — see EMAIL-ROUTER-SPEC.md).
// ============================================================================
// Pure decision logic: given a message + its label NAMES, produce a DECISION.
// It does NOT touch Gmail — the consumer applies the decision (respecting
// ROUTER.mode). That split keeps this unit testable with plain objects.
//
// Flow (both branches run the skip gate first — never a pure lookup):
//
//   BRANCH A — message carries a deterministic category label (CATEGORY_ROUTING):
//     skip=true  → mark read, remove from intake, NO person label.
//     skip=false → apply the category's mapped person label.
//
//   BRANCH B — everything else:
//     skip=true  → mark read, remove from intake, no label.
//     skip=false → SENDER override? apply that person.
//                  else run the classifier (rulebook):
//                    person  → apply their label (live) or log-only (shadow).
//                    NO_TAG  → mark read, remove from intake (skip-like).
//                    UNSURE  → apply "Needs Attention".
// ============================================================================

const cfg = require('./routing-config');
const skipGate = require('./skip-gate');
const personClassifier = require('./person-classifier');

// The concrete "clear from the queue" action shared by skip + NO_TAG.
function clearActions(config) {
  return {
    addLabels: [],
    removeIntake: config.SKIP_BEHAVIOR.removeFromIntake,
    markRead: config.SKIP_BEHAVIOR.markRead,
  };
}

async function route(message, labelNames = [], deps = {}) {
  const config = deps.config || cfg;
  const runSkipGate = deps.runSkipGate || skipGate.runSkipGate;
  const classify = deps.classify || personClassifier.classify;

  const category = config.matchedCategory(labelNames);
  const branch = category ? 'A' : 'B';
  const side = config.sideFromLabels(labelNames); // 'buyer'|'seller'|null

  const gate = await runSkipGate(message);

  const decision = {
    branch,
    category,
    side,
    skip: gate.skip,
    deciding_rule: gate.deciding_rule,
    reason: gate.reason,
    confidence: gate.confidence,
    plannedLabel: null,
    classifier: null,
    actions: null,
  };

  // SKIP — identical in both branches: clear from the queue, no person label.
  if (gate.skip) {
    decision.actions = clearActions(config);
    return decision;
  }

  // BRANCH A — deterministic category label decides the person.
  if (branch === 'A') {
    const person = config.personForCategory(category);
    decision.plannedLabel = person || config.LABELS.needsAttention;
    decision.actions = { addLabels: [decision.plannedLabel], removeIntake: true, markRead: false };
    if (!person) decision.reason = `${decision.reason} | category "${category}" has no person mapping; routed to Needs Attention`;
    return decision;
  }

  // BRANCH B — sender override first (deterministic, no model call).
  const h = message.headers || {};
  const senderPerson = config.personForSender(h.from);
  if (senderPerson) {
    decision.plannedLabel = senderPerson;
    decision.reason = `${decision.reason} | sender override -> ${senderPerson}`;
    decision.actions = { addLabels: [senderPerson], removeIntake: true, markRead: false };
    return decision;
  }

  // BRANCH B — the rulebook classifier. When a side sub-label is present, pass
  // the person it usually implies (Edelyn/Ethan) as a strong prior.
  const suggestion = await classify(message, { side, tagLean: config.personForSideTag(side) });
  decision.classifier = suggestion;

  // NO_TAG — a real but no-action email: clear it like a skip.
  if (suggestion.noTag) {
    decision.plannedLabel = null;
    decision.reason = `${decision.reason} | classifier NO_TAG: ${suggestion.reason}`;
    decision.actions = clearActions(config);
    return decision;
  }

  // A confident person (in live classifier mode) -> that person; else Needs Attention.
  const live = config.CLASSIFIER.mode === 'live'
    && suggestion.personLabel
    && !suggestion.unsure
    && suggestion.confidence >= config.CLASSIFIER.confidenceThreshold;

  const label = live ? suggestion.personLabel : config.LABELS.needsAttention;
  decision.plannedLabel = label;
  decision.actions = { addLabels: [label], removeIntake: true, markRead: false };
  return decision;
}

module.exports = { route };
