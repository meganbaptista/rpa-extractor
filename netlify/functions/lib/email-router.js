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
//   SKIP GATE (shared, runs before the branch split):
//     skip=true at a TRUSTED confidence  → mark read, remove from intake, no label.
//     skip=true at an UNTRUSTED one      → "Needs Attention" (see GATE
//                                          .trustedSkipConfidence). A shaky skip
//                                          must never silently clear the email.
//
//   BRANCH A — message carries a deterministic category label (CATEGORY_ROUTING):
//     apply the category's mapped person label.
//
//   BRANCH B — everything else:
//     SENDER override? apply that person.
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

  // ALREADY-ASSIGNED short-circuit: if the thread already carries a person label
  // AND has no category label, someone owns it — clear this message (mark read,
  // drop from intake, keep the existing person label, add no new tag) WITHOUT
  // spending a skip-gate or classifier call. Cuts the long tail of replies on
  // already-routed threads. Person labels come from the ROSTER, so this stays in
  // sync as the team changes. (Needs Attention is NOT a person label, so those
  // threads still get processed.)
  //
  // The `!category` guard makes CATEGORY_ROUTING (VP, disclosures) AUTHORITATIVE:
  // a thread with a category label is NOT short-circuited, so it always flows to
  // Branch A and (re)applies the category's person — even if the thread is already
  // assigned to someone ELSE. That's how a disclosure/VP thread mislabeled to the
  // wrong person self-heals: e.g. a "Buyer Signed Disclosures" thread carrying a
  // stale Ethan label gets Edelyn ADDED on its next actionable message (existing
  // labels are kept — Branch A only adds). Acks on category threads still clear
  // via the skip gate below. Non-category assigned threads keep the full savings.
  const personLabelSet = new Set(config.ROSTER.map((p) => String(p.personLabel).toLowerCase()));
  const assignedTo = labelNames.find((n) => personLabelSet.has(String(n).toLowerCase()));
  if (!category && assignedTo) {
    return {
      branch, category, side: null, sideSource: null,
      skip: true, deciding_rule: 'assigned',
      reason: `thread already assigned to "${assignedTo}"; cleared without re-routing`,
      confidence: '', plannedLabel: null, classifier: null,
      actions: clearActions(config),
    };
  }

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
  // But ONLY at a confidence trusted to clear. A skip marks the email read and
  // drops it from the queue with no label, so nobody ever looks at it again —
  // a shaky skip is the one path where actionable mail vanishes unseen. Below
  // the bar we defer to a human instead, exactly as a low-confidence NO_TAG does
  // further down. A missing/unknown confidence is untrusted (runSkipGate already
  // defaults it to 'low'), so this fails safe.
  if (gate.skip) {
    const trusted = (config.GATE && config.GATE.trustedSkipConfidence) || [];
    if (trusted.includes(String(gate.confidence).toLowerCase())) {
      decision.actions = clearActions(config);
      return decision;
    }
    // Not trusted to clear -> route it. `skip` records what we DID (route), not
    // what the gate wanted; gate_reason + deciding_rule preserve the gate's view
    // so a rescued skip is still auditable in the ledger.
    decision.skip = false;
    decision.plannedLabel = config.LABELS.needsAttention;
    decision.reason = `${decision.reason} | skip at ${gate.confidence} confidence is not trusted to clear -> Needs Attention`;
    decision.actions = { addLabels: [config.LABELS.needsAttention], removeIntake: true, markRead: false };
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
