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
//                              a PAIRS assignee (e.g. Belle+Megan) applies BOTH.
//                    NO_TAG  → mark read, remove from intake (skip-like).
//                    UNSURE  → apply "Needs Attention".
// ============================================================================

const cfg = require('./routing-config');
const skipGate = require('./skip-gate');
const personClassifier = require('./person-classifier');
const dealSideLookup = require('./deal-side');

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
  const dealSide = deps.dealSide || dealSideLookup;

  const category = config.matchedCategory(labelNames);
  const branch = category ? 'A' : 'B';

  // Side signal: prefer a Gmail side tag on the thread; else look up the side we
  // represent for this deal in the deals sheet (matched by the subject address).
  const h0 = message.headers || {};
  let side = config.sideFromLabels(labelNames); // 'buyer'|'seller'|null
  let sideSource = side ? 'tag' : null;
  if (!side) {
    const dealSideVal = await dealSide.sideForSubject(h0.subject);
    if (dealSideVal) { side = dealSideVal; sideSource = 'deal-list'; }
  }

  const gate = await runSkipGate(message);

  const decision = {
    branch,
    category,
    side,
    sideSource,
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

  // BRANCH B — the rulebook classifier. Pass strong priors from the thread's
  // labels: buyer/seller side (Edelyn/Ethan) and any label->person hints
  // (e.g. a "Request for Repairs" thread -> Jill).
  const suggestion = await classify(message, {
    side,
    // The Edelyn/Ethan lean only applies when the side came from a DISCLOSURE
    // sub-label (that label is itself a disclosure signal). Side from the deal
    // list just means "which side we represent" — it disambiguates buyer/seller
    // but must NOT bias every buyer-side email toward Edelyn (e.g. an ETA -> Jill).
    tagLean: sideSource === 'tag' ? config.personForSideTag(side) : null,
    labelHints: config.labelHints(labelNames),
  });
  decision.classifier = suggestion;

  // We only ACT on the classifier when it is LIVE and CONFIDENT. In shadow the
  // classifier is logged but never mutates mail; below the threshold we defer to
  // a human. This applies to NO_TAG too — a shaky "no action" must never silently
  // clear a potentially actionable email.
  const classifierLive = config.CLASSIFIER.mode === 'live';
  const confident = suggestion.confidence >= config.CLASSIFIER.confidenceThreshold;

  if (classifierLive && confident && suggestion.noTag) {
    // Confident, trusted no-action email -> clear it like a skip.
    decision.plannedLabel = null;
    decision.reason = `${decision.reason} | NO_TAG (confident): ${suggestion.reason}`;
    decision.actions = clearActions(config);
    return decision;
  }
  const personLabels = suggestion.personLabels || [];
  if (classifierLive && confident && personLabels.length && !suggestion.unsure) {
    // Confident, trusted person assignment. Usually one label; a PAIRS assignee
    // (e.g. Belle+Megan) yields two and BOTH get applied.
    // NOTE: plannedLabel is DISPLAY ONLY here (a pair joins to "Belle + Megan",
    // which is not a real Gmail label). actions.addLabels is what gets applied —
    // never derive labels from plannedLabel on this path.
    decision.plannedLabel = personLabels.join(' + ');
    decision.reason = `${decision.reason} | routed to ${suggestion.person} (${suggestion.confidence})`;
    decision.actions = { addLabels: personLabels, removeIntake: true, markRead: false };
    return decision;
  }

  // Everything else -> Needs Attention (a human decides): classifier still in
  // shadow, UNSURE, a low-confidence person, or a low-confidence NO_TAG.
  decision.plannedLabel = config.LABELS.needsAttention;
  if (suggestion.noTag && !confident) {
    decision.reason = `${decision.reason} | NO_TAG but low confidence -> Needs Attention`;
  }
  decision.actions = { addLabels: [config.LABELS.needsAttention], removeIntake: true, markRead: false };
  return decision;
}

module.exports = { route };
