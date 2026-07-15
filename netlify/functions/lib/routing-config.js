// netlify/functions/lib/routing-config.js
//
// ============================================================================
// Email Router — CONFIGURATION AS DATA (see EMAIL-ROUTER-SPEC.md).
// ============================================================================
// This is the ONE place to edit routing behavior. No Airtable, no code changes:
// change a label name or add an employee here and redeploy. Shaped for V2
// multi-tenant (one config object per mailbox) even though V1 ships a single
// tenant — so growing to more mailboxes is adding entries, not a rewrite.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ MEGAN — FILL IN THE VALUES MARKED  ◀── FILL  BELOW.                       │
// │ Everything with a real label name, person name, or "handles" description  │
// │ must come from your actual Gmail + team. The example values are           │
// │ placeholders so the module loads and the shape is clear; they are NOT     │
// │ your real routing until you replace them.                                 │
// └─────────────────────────────────────────────────────────────────────────┘
//
// TERMS:
//   category label  — a label your current Zaps already put on a message that
//                     identifies WHAT it is (e.g. "Escrow", "Showings").
//                     Presence of one of these = Branch A.
//   person label    — the label naming WHO handles it (e.g. "Jill", "Needs Attention").
//   intake label    — the label that means "sitting in the router's inbox queue".
//                     The poller scans this; skip + routing both remove it.
// ============================================================================

// ---------------------------------------------------------------------------
// TENANT — the mailbox this config governs. `key` is an internal id used in the
// shadow log; `mailbox` must match GMAIL_IMPERSONATE_SUBJECT for this tenant.
// ---------------------------------------------------------------------------
const TENANT = {
  key: 'mtc',
  mailbox: 'megan@mytcconcierge.com', // ◀── FILL  confirm this is the box to route
};

// ---------------------------------------------------------------------------
// LABELS the router reads/writes. Names must match Gmail EXACTLY (case aside).
// ---------------------------------------------------------------------------
const LABELS = {
  // The queue the poller scans. Everything the router touches carries this until
  // it's routed or skipped. ◀── FILL with your real intake/triage label name.
  intake: 'Intake',

  // Branch B fallback when the message matters but no category tells us who.
  // In V2 this is what the person-classifier falls back to at low confidence.
  needsAttention: 'Needs Attention',
};

// ---------------------------------------------------------------------------
// SKIP BEHAVIOR — what "skip=true" from the gate does, in BOTH branches.
// Matches your correction: mark read, remove from intake, apply NO person label.
// ---------------------------------------------------------------------------
const SKIP_BEHAVIOR = {
  markRead: true,
  removeFromIntake: true,
  applyPersonLabel: false,
};

// ---------------------------------------------------------------------------
// BRANCH A — category label -> person label. When a message already carries one
// of these category labels AND the gate says skip=false, apply the mapped person
// label. Keys are category label names; values are person label names.
//   ◀── FILL  with your real categories and who owns each.
// ---------------------------------------------------------------------------
const CATEGORY_ROUTING = {
  // 'Escrow':    'Jill',
  // 'Showings':  'Marco',
  // 'Listings':  'Priya',
  // 'Offers':    'Jill',
  // '<CATEGORY LABEL>': '<PERSON LABEL>',
};

// ---------------------------------------------------------------------------
// ROSTER — the team the V2 person-classifier can assign to (Branch B, no
// category). `handles` is the ONLY thing the classifier reads to decide who a
// message belongs to, so write it like you'd brief a new hire: concrete duties,
// deal stages, document types, sender types. `personLabel` is the Gmail label
// applied (must exist or be auto-created). `emails` (optional) lets the router
// short-circuit to a person when a known address is the sender/recipient.
//   ◀── FILL  with your real team.
// ---------------------------------------------------------------------------
const ROSTER = [
  // {
  //   name: 'Jill',
  //   personLabel: 'Jill',
  //   handles: 'Open escrow, contract-to-close coordination, RPA + disclosure packages, '
  //          + 'title/escrow officer correspondence, contingency and closing deadlines.',
  //   emails: ['jill@mytcconcierge.com'],
  // },
  // {
  //   name: 'Marco',
  //   personLabel: 'Marco',
  //   handles: 'Showing requests and scheduling, lockbox/access, buyer tour logistics, '
  //          + 'feedback follow-ups.',
  //   emails: ['marco@mytcconcierge.com'],
  // },
];

// ---------------------------------------------------------------------------
// MODELS + CLASSIFIER SETTINGS.
//   gate.model        — the skip gate. Haiku per spec (cheap, high volume).
//   classifier.mode   — 'shadow' = log the would-be person label, DO NOT apply
//                       (V1 default: Branch B still routes to Needs Attention).
//                       'live'   = actually apply the classifier's person label.
//   classifier.model  — start on Haiku; bump to Opus if shadow accuracy is short.
//   classifier.confidenceThreshold — below this, fall back to Needs Attention
//                       even in 'live' mode.
// ---------------------------------------------------------------------------
// ROUTER-LEVEL mode — governs the WHOLE router during cutover, independent of
// the V2 classifier. Since we're migrating fully OFF Zapier, there is no live
// Zap decision to diff against per message; instead run the router itself in
// 'shadow' first: it evaluates every message and writes the full decision +
// deciding rule to the shadow log, but applies NO labels and marks nothing read.
// You compare the logged decisions (and which rule drove each) against what the
// Zaps would have done, confirm Branch B parity + the intended Branch A
// differences (rules 10–14 / quoted-history scoping), then flip to 'live'.
const ROUTER = {
  mode: 'shadow', // 'shadow' = decide + log only, mutate nothing | 'live' = apply
};

const GATE = {
  model: 'claude-haiku-4-5-20251001',
  effort: 'low',
};

const CLASSIFIER = {
  mode: 'shadow', // 'shadow' | 'live'  — keep 'shadow' until the log proves it out
  model: 'claude-haiku-4-5-20251001',
  effort: 'low',
  confidenceThreshold: 0.7,
};

// ---------------------------------------------------------------------------
// Helpers (small, so consumers don't reach into the raw objects).
// ---------------------------------------------------------------------------

// The category label (if any) present on a message, given its label NAMES.
// Returns the matched category name or null. First match wins; if a message
// somehow carries two category labels, order here is the tiebreak, so list the
// most specific categories first if that ever matters.
function matchedCategory(labelNames = []) {
  const set = new Set(labelNames.map((n) => String(n).toLowerCase()));
  for (const cat of Object.keys(CATEGORY_ROUTING)) {
    if (set.has(cat.toLowerCase())) return cat;
  }
  return null;
}

// Person label for a category (Branch A target).
function personForCategory(cat) {
  return CATEGORY_ROUTING[cat] || null;
}

// Look up a roster member by a sender/recipient email (Branch B short-circuit).
function rosterByEmail(email) {
  if (!email) return null;
  const lc = String(email).toLowerCase();
  return ROSTER.find((p) => (p.emails || []).some((e) => e.toLowerCase() === lc)) || null;
}

module.exports = {
  TENANT,
  LABELS,
  SKIP_BEHAVIOR,
  CATEGORY_ROUTING,
  ROSTER,
  ROUTER,
  GATE,
  CLASSIFIER,
  matchedCategory,
  personForCategory,
  rosterByEmail,
};
