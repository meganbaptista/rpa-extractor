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
//   BRANCH A — message carries a known category label:
//     1. skip gate.
//     2. skip=true  → mark read, remove from intake, NO person label.
//     3. skip=false → apply the category's mapped person label.
//
//   BRANCH B — no category label:
//     1. skip gate.
//     2. skip=true  → mark read, no labels.
//     3. skip=false → V1: apply "Needs Attention".
//                     V2: run the person-classifier. In CLASSIFIER.mode 'live'
//                         and confidence ≥ threshold, apply that person label;
//                         otherwise fall back to Needs Attention. In 'shadow'
//                         mode the suggestion is recorded but Needs Attention is
//                         still what gets planned. Either way the suggestion is
//                         attached to the decision for the shadow log.
// ============================================================================

const cfg = require('./routing-config');
const skipGate = require('./skip-gate');
const personClassifier = require('./person-classifier');

// Decide what to do with one message.
//   message    — lib/gmail.js getMessage() shape.
//   labelNames — the message's current label DISPLAY names (consumer resolves ids→names).
//   deps       — injectable for tests: { runSkipGate, classify, config }.
// Returns a DECISION the consumer knows how to apply + the shadow log knows how
// to record. `plannedLabel` is the person label routing wants applied (null when
// skipping). `actions` is the concrete mutation plan.
async function route(message, labelNames = [], deps = {}) {
  const config = deps.config || cfg;
  const runSkipGate = deps.runSkipGate || skipGate.runSkipGate;
  const classify = deps.classify || personClassifier.classify;

  const category = config.matchedCategory(labelNames);
  const branch = category ? 'A' : 'B';

  const gate = await runSkipGate(message);

  const decision = {
    branch,
    category,
    skip: gate.skip,
    deciding_rule: gate.deciding_rule,
    reason: gate.reason,
    confidence: gate.confidence,
    plannedLabel: null,
    classifier: null,
    actions: null,
  };

  // SKIP — identical in both branches: mark read, drop from intake, no person label.
  if (gate.skip) {
    decision.actions = {
      addLabels: [],
      removeIntake: config.SKIP_BEHAVIOR.removeFromIntake,
      markRead: config.SKIP_BEHAVIOR.markRead,
    };
    return decision;
  }

  // NOT SKIP.
  if (branch === 'A') {
    // Category already tells us who owns it.
    const person = config.personForCategory(category);
    decision.plannedLabel = person; // may be null if the map has a category with no owner yet
    decision.actions = {
      addLabels: person ? [person] : [config.LABELS.needsAttention],
      removeIntake: true,
      markRead: false,
    };
    if (!person) {
      // Category is mapped in config but to no person — surface, don't silently drop.
      decision.reason = `${decision.reason} | category "${category}" has no person mapping; routed to Needs Attention`;
    }
    return decision;
  }

  // BRANCH B — no category. Infer the person (V2), fall back to Needs Attention.
  const suggestion = await classify(message);
  decision.classifier = suggestion;

  const live = config.CLASSIFIER.mode === 'live'
    && suggestion.personLabel
    && suggestion.confidence >= config.CLASSIFIER.confidenceThreshold;

  const label = live ? suggestion.personLabel : config.LABELS.needsAttention;
  decision.plannedLabel = label;
  decision.actions = {
    addLabels: [label],
    removeIntake: true,
    markRead: false,
  };
  return decision;
}

module.exports = { route };
