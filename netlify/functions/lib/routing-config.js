// netlify/functions/lib/routing-config.js
//
// ============================================================================
// Email Router — CONFIGURATION AS DATA (see EMAIL-ROUTER-SPEC.md).
// ============================================================================
// The ONE place to edit routing behavior. No Airtable, no code changes. This
// encodes the team's "EMAIL TAGGING NOTES" rulebook (how Belle was trained to
// tag incoming mail) as data the person-classifier renders into its prompt.
// Change a duty, add a person, or fix a rule here and redeploy.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ MEGAN — CONFIRM the two ◀── CONFIRM items, and RESOLVE the ◀── CONFLICT   │
// │ notes (the source doc disagreed with itself in these spots).             │
// └─────────────────────────────────────────────────────────────────────────┘
// ============================================================================

// ---------------------------------------------------------------------------
// TENANT — the mailbox this config governs; must match GMAIL_IMPERSONATE_SUBJECT.
// ---------------------------------------------------------------------------
const TENANT = {
  key: 'mtc',
  mailbox: 'megan@mytcconcierge.com',
};

// ---------------------------------------------------------------------------
// LABELS the router reads/writes. Must match Gmail EXACTLY (case aside), because
// person labels are auto-CREATED if the exact string isn't found — a typo makes
// a new empty label instead of using yours.  ◀── CONFIRM every person label
// string below matches Gmail, especially "JILL✨" (with the sparkle emoji?).
// ---------------------------------------------------------------------------
const LABELS = {
  intake: 'INTAKE - REVIEW',      // the queue the poller scans
  needsAttention: 'Needs Attention', // classifier is UNSURE -> human review
};

// ---------------------------------------------------------------------------
// SKIP BEHAVIOR — what the acknowledgment skip gate does on skip=true. Also
// reused for classifier NO_TAG outcomes (per Megan: mark read + drop from queue).
// ---------------------------------------------------------------------------
const SKIP_BEHAVIOR = {
  markRead: true,
  removeFromIntake: true,
  applyPersonLabel: false,
};

// ---------------------------------------------------------------------------
// BRANCH A — deterministic category-label -> person overrides. If a message
// ALREADY carries one of these labels, route straight to the mapped person
// (still gated by the skip gate first). Most routing is NOT deterministic — it
// runs through the classifier — so this stays small. Add entries only for
// labels that ALONE decide the person with no content judgment needed.
// ---------------------------------------------------------------------------
const CATEGORY_ROUTING = {
  // '<CATEGORY LABEL>': '<PERSON>',
};

// ---------------------------------------------------------------------------
// SIDE TAGS — existing Gmail "sub-labels" that reveal whether we represent the
// BUYER or SELLER on this deal. These are READ-ONLY SIGNALS: the router never
// applies, removes, or touches them — it only reads their presence to decide
// WHICH PERSON to tag. If a side tag is present the side is known for certain;
// if not, the classifier infers side from content. Matched by exact name OR as
// a nested sub-label path suffix (e.g. "Disclosures/Buyer Disclosures").
// ---------------------------------------------------------------------------
const SIDE_TAGS = {
  buyer: ['Buyer Disclosures'],
  // Both seller-side disclosure stages route to Ethan: "MEGAN/Seller Disclosures"
  // is completing disclosures WITH the seller; "Seller Signed Disclosures" is
  // sending the signed disclosures to the buyer's agent. (Nested label paths are
  // matched by exact name or as a "/leaf" suffix.)
  seller: ['Seller Signed Disclosures', 'MEGAN/Seller Disclosures'],
};

// Whom a present side sub-label USUALLY means. Passed to the classifier as a
// STRONG PRIOR (not a hard rule): a Buyer Disclosures label usually -> Edelyn,
// a Seller Signed Disclosures label usually -> Ethan. The AI defers to this
// unless the email content clearly points to someone else. To make it an
// absolute rule instead, move the label into CATEGORY_ROUTING.
const SIDE_TAG_ROUTING = {
  buyer: 'Edelyn',
  seller: 'Ethan',
};

// ---------------------------------------------------------------------------
// SENDER ROUTING — deterministic "this sender always goes to this person".
// Checked BEFORE the model (a match short-circuits the classifier — no API
// cost). Keys are lowercased email addresses or bare domains.
// ---------------------------------------------------------------------------
const SENDER_ROUTING = {
  'dan@anvilre.com': 'Megan',        // "Anything from Dan Smith - Anvil" -> Megan
  'support@planetre.com': 'Lovely',  // resolved 2026-07-15: PlanetRE -> Lovely
};

// ---------------------------------------------------------------------------
// ROSTER — the team + what each person handles. `handles` is the rulebook the
// classifier reads to route Branch B mail; write it concrete. `personLabel` is
// the Gmail label applied (auto-created if missing — match Gmail exactly).
// Compiled from the "EMAIL TAGGING NOTES" doc.
// ---------------------------------------------------------------------------
const ROSTER = [
  {
    name: 'Belle',
    personLabel: 'Belle',
    handles: 'NEW ESCROWS / new files (agent looping in the TC, "adding my TC Megan", '
      + '"attached is the fully executed contract", "accepted offer", "intro to escrow", '
      + '"[address] - acceptance", "new file"). Escrow-officer AGENT opening package or '
      + 'BROKER opening package (escrow instructions/general provisions, EMD, NHD/zone '
      + 'report, prelim/preliminary title report, page 16 of RPA / escrow acknowledgement, '
      + 'commission instructions). AMENDED INSTRUCTIONS of any kind issued/returned by the '
      + 'ESCROW OFFICER — amended escrow instructions, an escrow amendment for a price '
      + 'reduction, and AMENDED COMMISSION INSTRUCTIONS — all route to Belle (escrow-company '
      + 'paperwork returned by the escrow officer). Preliminary title report, natural '
      + 'hazards report, HOA docs (and HOA/9A/city-report updates from escrow), 9A / city '
      + 'report / report of residential property records, retrofit / cert of compliance, '
      + 'grant deed, encrypted messages, "your escrow number is ...". EMD/deposit RECEIVED '
      + '(only when the escrow officer says it was received). Milestone confirmations in '
      + 'the newest message: "we have funded" / "released for recording tomorrow" (funding '
      + 'day), "we are confirmed/recorded/closed" (closing day). Agent/broker CLOSING '
      + 'package and closing documents, closing statement / final closing / final '
      + 'settlement statement, FIRPTA / QS. '
      + 'MLS SOLD copy. Amended/revised commission (the commission amount, from an agent), '
      + 'and commission QUESTIONS or concerns. Lender LOAN-STATUS / loan-progress updates — '
      + 'a "loan update" from the lender: loan approval received, conditions or ICD requested, '
      + 'underwriting or appraisal progress. (This is distinct from the physical loan DOCS '
      + 'arriving or signing logistics, which stay NO_TAG.) '
      + 'Any email that STATES, CONFIRMS, or CHANGES a specific closing date (e.g. "we can '
      + 'close Friday", "set to close on the 30th", a close-date revision, or an escrow '
      + 'closing audit response with a changed close date) — so Belle can verify or update '
      + 'the close date in Process Street. RLA / residential listing agreement / new listing, listing '
      + 'agreement received. Rejected offers. Inspection REPORTS/receipts when a PDF is '
      + 'attached or LINKED (general, termite, HVAC, roof, mold, plumbing, geo, etc.).',
  },
  {
    name: 'Jill',
    personLabel: 'JILL✨', // ◀── CONFIRM exact Gmail string (emoji?)
    handles: 'Addendum or contingency-release (CR) requests — "agent asking us to send an '
      + 'addendum", "send a contingency release", CAR ADDENDUM requests. ETA (Extension of '
      + 'Time Addendum). Cancellation of escrow / cancellations. Purchase price amendment, '
      + 'purchase price reduction, any change to purchase price or credit. Seller credit '
      + 'addendum. RR / RRRR — request for repairs and seller response to repairs. '
      + 'Contingency removals / releases / CR (including contingency releases delivered to '
      + 'us with an attachment). AOAA, buyer vesting / vesting amendment / assignment (AOAA '
      + 'form). A CAR Purchase Price Amendment form or other CONTRACT-side amendment/addendum '
      + 'requested or sent by an AGENT. (Amended ESCROW INSTRUCTIONS returned by the escrow '
      + 'officer — escrow-company paperwork — go to Belle, not Jill.) RLAS (residential lease '
      + 'AFTER sale / leaseback / rentback) and SIP (seller in possession / leaseback / '
      + 'rentback).',
  },
  {
    name: 'Ethan',
    personLabel: 'Ethan',
    handles: 'SELLER-SIDE disclosure and signature work. Home-warranty emails. VP / VOP / '
      + 'final walk-through ATTACHED requesting the SELLER signature. Requesting CAR-form '
      + 'disclosure items for the SELLER to sign (AVID, broker-affiliated disclosures). '
      + 'Someone sending us the package of FULLY EXECUTED disclosures signed by the buyer. '
      + 'Someone sending us disclosures FOR THE SELLER to sign. A client response to a '
      + '"Seller Disclosure Package | [address]" email when we are on the SELLER side '
      + '(their message contains a link for sellers to fill out disclosures). "Completed: '
      + '[Electronic Version] Seller Disclosure Package" from DocuSign.',
  },
  {
    name: 'Edelyn',
    personLabel: 'Edelyn',
    handles: 'BUYER-SIDE disclosure work. Disclosure PACKAGE for the BUYER to sign (has '
      + 'the seller-signed disclosures attached). Requesting us to SEND CAR form VP / VOP / '
      + 'final walk-through. TC introduction on the OTHER side. Requesting us to get / send '
      + 'CAR-form disclosure items for the BUYER to sign (CAR forms, not escrow documents). '
      + 'Glide link or requesting Glide. Skyslope checklist updates. A client response to a '
      + '"Seller Disclosure Package | [address]" email when we are on the BUYER side (these '
      + 'carry a Buyer Disclosures tag).',
  },
  {
    name: 'Allana',
    personLabel: 'Allana',
    handles: 'Purchase contract audits. BRBC (Buyer Representation Agreement). ALL '
      + 'pre-qualification / pre-approval / approval letters and PROOF OF FUNDS (POF / '
      + 'prequal) — including a POF/pre-approval package, or a request to forward or send '
      + "the buyer's pre-approval letter and/or proof of funds. \"Completed: "
      + 'Please DocuSign — Missed Initials on Purchase Agreement".',
  },
  {
    name: 'Megan',
    personLabel: 'Megan',
    handles: 'LEASES — Megan owns the entire lease file. Any thread that is a lease: CAR '
      + 'form "LR" (Residential Lease or month-to-month rental agreement), an RLMM '
      + '(Residential Lease or Month-to-Month) agreement, a subject like "Lease Contract", '
      + 'or a lease agreement attached — but NOT RLAS (that is Jill). Because Megan owns the '
      + 'whole lease file, route EVERY message in a lease thread to her, including questions '
      + 'about compensation, payment, timing, or entity financials on that lease. '
      + 'Phone-call requests to Megan directly. Agent asking to send '
      + 'out a Notice to Perform, or asking for a Notice to Perform / NTB draft. '
      + 'Modification of Terms (MT / MOT). Referrals / W9 for referral. Anything from Dan '
      + 'Smith (dan@anvilre.com) or Anvil. Emails from Zapier. Broker Complete File — a '
      + 'reply with a question/comment/concern after we sent their broker complete file. '
      + 'CDA (commission disbursement authorization) requests. Requests for an MT-BR or '
      + 'MT-LA. Requests to take on new clients / inquiries about our services. TC check / '
      + 'TC fee / Megan check / where to send the check or commission. A QUESTION about '
      + 'escrow due dates (a plain confirmation of due dates is NO TAG).',
  },
  {
    name: 'Lovely',
    personLabel: 'Lovely',
    handles: 'Emails from support@planetre.com.',
  },
];

// ---------------------------------------------------------------------------
// NO-TAG CONTENT RULES — real (non-acknowledgment) emails that get NO person
// label. Per Megan these are cleared like a skip (mark read + drop from intake).
// The classifier returns assignee = NO_TAG when the newest message matches one.
// ---------------------------------------------------------------------------
const NO_TAG_RULES = [
  'SELLER opening package or BUYER opening package (NOT the agent/broker opening package) once escrow is open and the email says "SELLER OPENING" / "BUYER OPENING".',
  '"Loan docs are in / have arrived."',
  'Buyer signing loan docs, notary appointments to sign docs, scheduling the buyer to sign loan docs.',
  'ESTIMATED closing statement (must be estimated, not final).',
  'Appraisal has been scheduled, or reaching out to schedule the appraisal.',
  'Wire instructions / deposit instructions.',
  'Third-party deposit form.',
  'CONFIRMING escrow due dates (only a confirmation — a QUESTION about due dates goes to Megan).',
  'Notice to Perform PDF received (no action beyond filing to drive).',
  'Accepted calendar invite.',
  'Automatic Reply / Out of Office.',
  'Subject line that is just "Split on [address]".',
  'A DocuSign that is NOT completed (we are only copied on delivery, often from an escrow officer).',
  'A Voided DocuSign.',
  'Inspection SCHEDULING or requests with no report attached or linked (only tag Belle when a report PDF is attached or linked).',
];

// ---------------------------------------------------------------------------
// ROUTING NOTES — cross-cutting disambiguation the classifier must apply. These
// are the "read the whole doc, not just keywords" rules.
// ---------------------------------------------------------------------------
const ROUTING_NOTES = [
  'SENDER TYPE matters. The same words route differently from an Escrow Officer, an Agent, a DocuSign notification, or a Client (buyer/seller). Use the sender to disambiguate.',
  'DEAL TYPE comes from the SUBJECT + WHOLE THREAD, not just the newest message. The newest message is the immediate ask; the thread tells you what KIND of deal it is (lease, purchase, listing) and therefore who owns the file. Route by the file owner. Example: a thread whose subject/attachments show a LEASE (Residential Lease, RLMM, month-to-month, "Lease Contract") belongs to Megan even if the newest message is a generic question about compensation, payment, or timing — do not route that to Belle/others on the strength of the newest message alone.',
  'BUYER vs SELLER side flips disclosure routing: buyer-side disclosure work -> Edelyn, seller-side disclosure work -> Ethan. Prefer a side tag if one is present; otherwise infer side from the content.',
  'STRONG PRIOR from sub-labels: if a "Buyer Disclosures" sub-label is present the handler is USUALLY Edelyn; if a "Seller Signed Disclosures" sub-label is present it is USUALLY Ethan. Follow this unless the content clearly indicates a different person.',
  'VP / VOP / final walk-through: if ATTACHED requesting the SELLER signature -> Ethan; if someone is requesting us to SEND the VP/VOP -> Edelyn.',
  'Disclosures: "for the SELLER to sign" or fully-executed-by-buyer packages we receive -> Ethan; "for the BUYER to sign" (package to send the buyer) -> Edelyn.',
  'AMENDMENTS split by WHO issues them: amended ESCROW INSTRUCTIONS issued/returned by the ESCROW OFFICER (escrow-company paperwork — amended instructions, an escrow amendment for a price reduction, amended commission instructions) -> Belle. CONTRACT-side amendments on CAR forms requested or sent by an AGENT (CAR addendum, a CAR Purchase Price Amendment form, seller credit addendum, AOAA) -> Jill. So the SAME price reduction is Belle when it arrives as the escrow officer\'s amended instructions, but Jill when an agent sends a CAR Purchase Price Amendment form.',
  'Commission: the commission AMOUNT / amended-revised commission from an agent -> Belle; a commission QUESTION or concern -> Belle; amended commission INSTRUCTIONS from escrow -> Belle (Belle owns all escrow-officer amended instructions).',
  'Leases: CAR form "LR" -> Megan; but RLAS / SIP (leaseback or seller-in-possession after sale) -> Jill.',
  'Milestone receipts count only when in the NEWEST message (EMD received, funded, recorded/closed) and route to Belle; the same words quoted from an older message do not.',
  'Loan emails split two ways: a lender LOAN-STATUS / progress update (approval received, conditions/ICD requested, appraisal progress, "loan update") -> Belle. But the physical loan DOCS arriving, buyer signing loan docs / scheduling the signing, and a bare appraisal-scheduling email stay NO_TAG.',
  'CLOSE DATE beats the loan-docs no-tag: if an email states or confirms a specific closing date (e.g. "loan docs are coming so we can close Friday"), route to Belle to verify/update Process Street — do NOT mark it NO_TAG just because it also mentions loan docs arriving. Only a pure loan-docs-arriving note with no close date stays NO_TAG.',
];

// ---------------------------------------------------------------------------
// CONFLICTS — spots where the source doc contradicted itself. Left explicit so
// they are resolved deliberately, not silently. Resolve by editing ROSTER /
// SENDER_ROUTING / ROUTING_NOTES above, then delete the entry here.
// ---------------------------------------------------------------------------
// All three source-doc conflicts resolved 2026-07-15: commission question -> Belle,
// BRBC -> Allana, PlanetRE -> Lovely, Skyslope -> Edelyn ("for now").
const CONFLICTS = [];

// ---------------------------------------------------------------------------
// MODES + MODELS (both default SAFE).
// ---------------------------------------------------------------------------
const ROUTER = {
  mode: 'shadow', // 'shadow' = decide + log only, mutate nothing | 'live' = apply
};

const GATE = {
  model: 'claude-haiku-4-5-20251001',
  effort: 'low',
};

const CLASSIFIER = {
  mode: 'shadow', // 'shadow' = log the would-be person, still apply Needs Attention | 'live'
  // Opus for the rulebook: it's a nuanced, sender/side-aware classification and
  // shadow mode makes accuracy (not cost) the priority. Drop to Haiku later if
  // shadow shows it's accurate enough.
  model: 'claude-opus-4-8',
  effort: 'medium',
  confidenceThreshold: 0.7,
};

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
function matchedCategory(labelNames = []) {
  const set = new Set(labelNames.map((n) => String(n).toLowerCase()));
  for (const cat of Object.keys(CATEGORY_ROUTING)) {
    if (set.has(cat.toLowerCase())) return cat;
  }
  return null;
}

function personForCategory(cat) {
  return CATEGORY_ROUTING[cat] || null;
}

// Deterministic sender override -> person name, or null. Matches full address
// first, then the bare domain.
function personForSender(fromHeader) {
  if (!fromHeader) return null;
  const m = String(fromHeader).match(/[<\s]?([^<>\s@]+@[^<>\s]+)>?/);
  const email = (m ? m[1] : String(fromHeader)).toLowerCase().replace(/>$/, '');
  if (SENDER_ROUTING[email]) return SENDER_ROUTING[email];
  const domain = email.split('@')[1];
  if (domain && SENDER_ROUTING[domain]) return SENDER_ROUTING[domain];
  return null;
}

// True if any of the message's labels equals `tag`, or is a nested sub-label
// ending in `.../tag` (Gmail stores nested labels as full slash-paths).
function labelsInclude(labelNames, tag) {
  const t = String(tag).toLowerCase();
  return labelNames.some((n) => {
    const ln = String(n).toLowerCase();
    return ln === t || ln.endsWith('/' + t);
  });
}

// Side implied by the message's current labels, or null if no side tag present.
function sideFromLabels(labelNames = []) {
  if (SIDE_TAGS.buyer.some((t) => labelsInclude(labelNames, t))) return 'buyer';
  if (SIDE_TAGS.seller.some((t) => labelsInclude(labelNames, t))) return 'seller';
  return null;
}

// The person a present side sub-label usually implies (strong prior), or null.
function personForSideTag(side) {
  return side ? (SIDE_TAG_ROUTING[side] || null) : null;
}

module.exports = {
  TENANT,
  LABELS,
  SKIP_BEHAVIOR,
  CATEGORY_ROUTING,
  SIDE_TAGS,
  SIDE_TAG_ROUTING,
  SENDER_ROUTING,
  ROSTER,
  NO_TAG_RULES,
  ROUTING_NOTES,
  CONFLICTS,
  ROUTER,
  GATE,
  CLASSIFIER,
  matchedCategory,
  personForCategory,
  personForSender,
  sideFromLabels,
  personForSideTag,
};
