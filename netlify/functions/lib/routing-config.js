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
  // '<GMAIL LABEL ON THE THREAD>': '<GMAIL LABEL TO APPLY>'. A thread carrying the
  // key routes deterministically (Branch A) to the mapped person, bypassing the AI
  // classifier — but the skip gate still runs first, so a plain "thanks/received"
  // on one of these threads is SKIPPED (marked read, no label) and never reaches
  // Needs Attention. Net: these threads can only be cleared or land on the right
  // person; Needs Attention is off the table for them.
  'VP Buyer': 'Edelyn',   // buyer-side final walk-through (VP) -> always Edelyn
  'VP Seller': 'Ethan',   // seller-side final walk-through (VP) -> always Ethan
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

// LABEL HINTS — thread/deal labels that strongly suggest a PERSON (a "usually
// this person" prior fed to the classifier, NOT a hard rule). Distinct from
// SIDE_TAGS (which carry buyer/seller side): these are direct label->person
// signals, e.g. a thread carrying a "Request for Repairs" label -> Jill. The
// classifier follows the hint unless the newest message clearly belongs to
// someone else. Add category labels here as you find them.
const LABEL_HINTS = {
  'Request for Repairs': 'Jill',
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
      + 'Time Addendum). A request to OUTLINE or PROVIDE the INSPECTION PERIOD dates and '
      + 'relevant timelines — contingency dates, transaction deadlines / timelines (Jill owns '
      + 'contingency and deadline timelines). Cancellation of escrow / cancellations. Purchase price amendment, '
      + 'purchase price reduction, any change to purchase price or credit. Seller credit '
      + 'addendum. RR / RRRR — request for repairs and seller response to repairs. '
      + 'Contingency removals / releases / CR (including contingency releases delivered to '
      + 'us with an attachment). AOAA, buyer vesting / vesting amendment / assignment (AOAA '
      + 'form). A CAR Purchase Price Amendment form or other CONTRACT-side amendment/addendum '
      + 'requested or sent by an AGENT. (Amended ESCROW INSTRUCTIONS returned by the escrow '
      + 'officer — escrow-company paperwork — go to Belle, not Jill.) RLAS (residential lease '
      + 'AFTER sale / leaseback / rentback), SIP (seller in possession / leaseback / '
      + 'rentback), and IOA (Interim Occupancy Agreement — buyer in possession before close).',
  },
  {
    name: 'Ethan',
    personLabel: 'Ethan',
    handles: 'SELLER-SIDE disclosure and signature work, including the seller\'s Receipt for '
      + 'Reports (RFR) — signing/acknowledging receipt of the completed reports (this is the '
      + 'disclosure-flow "Receipt for Reports", NOT a "Request for Repairs", which is Jill). '
      + 'Home-warranty emails. VP / VOP / '
      + 'final walk-through ATTACHED requesting the SELLER signature. Requesting CAR-form '
      + 'disclosure items for the SELLER to sign (AVID, broker-affiliated disclosures). '
      + 'Someone sending us the package of FULLY EXECUTED disclosures signed by the buyer. '
      + 'Someone sending us disclosures FOR THE SELLER to sign. A client response to a '
      + '"Seller Disclosure Package | [address]" email when we are on the SELLER side '
      + '(their message contains a link for sellers to fill out disclosures). "Completed: '
      + '[Electronic Version] Seller Disclosure Package" from DocuSign — this DocuSign template '
      + 'was renamed to "Seller Package", so "Completed: [Electronic Version] Seller Package | '
      + '[address]" from DocuSign is the SAME seller-disclosure package and also routes to Ethan. '
      + 'SELLER-SIDE document-status questions: confirming what is still outstanding / needed '
      + 'on the SELLER\'s file, whether the seller has signed, or where the seller should '
      + 'find/sign documents (e.g. in DocuSign) — a seller-side file/document audit. (This is '
      + 'NOT a Purchase Contract Audit, which is Allana.)',
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
      + 'carry a Buyer Disclosures tag). A shared disclosure / property-info packet delivered '
      + 'via a PORTAL — Disclosures.io, HomeLight, Glide, "shared access to the property '
      + 'packet", a "REVIEW NOW" notification — route to Edelyn (she clicks through, retrieves '
      + 'the PDFs, and decides whether to apply the "Disclosures - AI Review" label). This '
      + 'holds even without a matched deal address; a shared/received packet means we are the '
      + 'buyer side.',
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
      + 'escrow due dates (a plain confirmation of due dates is NO TAG). '
      + 'An agent, TC, escrow/title officer, or other industry contact ANNOUNCING a new brokerage / '
      + 'new company / new role / new contact info (a "guess who\'s back" / "I landed at [company]" / '
      + '"my new email is" note) -> Megan (relationship / contact update, so we log where they went).',
  },
  {
    name: 'Lovely',
    personLabel: 'Lovely',
    handles: 'Emails from support@planetre.com.',
  },
];

// ---------------------------------------------------------------------------
// PAIRS — the ONLY cases where one email gets TWO person labels, because two
// people genuinely must both act. Deliberately a short, closed list of named
// situations rather than a general "pick N people" capability: if the model
// were free to name any two, it would pair whenever it was torn, and hedging
// would quietly replace UNSURE. Each entry is one discrete choice the model
// can make, and only for the case in `when`.
//
//   name    — the enum value the classifier returns (also what the ledger shows).
//   members — ROSTER names; ALL must resolve or the email falls to Needs
//             Attention rather than being half-labeled (see person-classifier).
//   when    — the situation, written concrete. Rendered into the prompt.
//
// To retire a pair: delete its entry. Nothing else references it.
// ---------------------------------------------------------------------------
const PAIRS = [
  {
    name: 'Belle+Megan',
    members: ['Belle', 'Megan'],
    when: 'AGENT REIMBURSEMENT AT CLOSING — an agent paid out of pocket for a deal '
      + 'expense (an inspection, a repair, a report, a utility or HOA fee) and asks to be '
      + 'repaid out of the proceeds at closing. E.g. "[agent] paid $150 toward the pool leak '
      + 'inspection today, please have the buyers reimburse her at closing." The example is '
      + 'illustrative — any out-of-pocket expense and any amount qualifies. This counts '
      + 'whether or not the email says "CDA", and whether or not an invoice is attached. '
      + 'Belle owns the escrow-side instruction that gets the money moved; Megan owns the '
      + 'CDA the reimbursement flows through — both must act, so tag both.',
  },
];

// ---------------------------------------------------------------------------
// NO-TAG CONTENT RULES — real (non-acknowledgment) emails that get NO person
// label. Per Megan these are cleared like a skip (mark read + drop from intake).
// The classifier returns assignee = NO_TAG when the newest message matches one.
// ---------------------------------------------------------------------------
const NO_TAG_RULES = [
  'MLS LISTING MAINTENANCE that is the listing AGENT\'s job, not ours: removing or editing MLS photos, closing out / withdrawing the MLS listing, updating the MLS with agent names. Our team does not do MLS upkeep, so even a direct "can you take care of this?" request is NO_TAG. (This is DIFFERENT from receiving an "MLS SOLD" copy, which IS Belle.)',
  'SELLER opening package or BUYER opening package (NOT the agent/broker opening package) once escrow is open and the email says "SELLER OPENING" / "BUYER OPENING".',
  '"Loan docs are in / have arrived."',
  'Buyer signing loan docs, notary appointments to sign docs, scheduling the buyer to sign loan docs.',
  'NOTARY appointments and scheduling of ANY kind — escrow (or anyone) coordinating with the client to book, confirm, reschedule, or arrange a notary signing (time, date, location, mobile notary). ALWAYS NO_TAG; our team takes no action on notary scheduling (a big email clog).',
  'ESTIMATED closing statement (must be estimated, not final).',
  'Appraisal has been scheduled, or reaching out to schedule the appraisal.',
  'Wire instructions / deposit instructions.',
  'Third-party deposit form.',
  'CONFIRMING escrow due dates (only a confirmation — a QUESTION about due dates goes to Megan).',
  'Notice to Perform PDF received (no action beyond filing to drive).',
  'A routine incoming CDA DOCUMENT delivery from Marie Maravillas (csfinance@ciresocal.com, a Christie\'s commission specialist) whose only purpose is to DELIVER an attached CDA (e.g. subject "CDA - [address]", body just "please find the attached CDA", no question or request) is a no-action document drop (file to drive) -> NO_TAG, even though it carries the CDA attachment. This applies ONLY to csfinance@ciresocal.com simply attaching a finished CDA; a CDA REQUEST, a request to prepare or modify a CDA, or a CDA question still goes to Megan.',
  'Accepted calendar invite.',
  'Automatic Reply / Out of Office.',
  'Subject line that is just "Split on [address]".',
  'A DocuSign that is NOT completed (we are only copied on delivery, often from an escrow officer).',
  'A Voided DocuSign.',
  'Inspection SCHEDULING — booking/arranging an inspection (no report attached or linked) — is NO_TAG. But a request to SEND or PROVIDE a COPY of an inspection report is NOT NO_TAG (see the routing note on document-copy requests).',
];

// ---------------------------------------------------------------------------
// ROUTING NOTES — cross-cutting disambiguation the classifier must apply. These
// are the "read the whole doc, not just keywords" rules.
// ---------------------------------------------------------------------------
const ROUTING_NOTES = [
  'SENDER TYPE matters. The same words route differently from an Escrow Officer, an Agent, a DocuSign notification, or a Client (buyer/seller). Use the sender to disambiguate.',
  'ATTACHMENTS: when the body is uninformative (e.g. "please see the attached"), use the ATTACHMENT FILENAME to identify the document and route by it — e.g. a filename naming a "Cancellation of Contract" / cancellation -> Jill, "Request for Repairs"/RR -> Jill, an addendum -> Jill, an AVID -> Ethan/Edelyn by side. You only have the FILENAME, not the PDF contents. If the body is uninformative AND neither the subject nor the attachment filename reveals the document type (e.g. the file is named only by the property address), route to BELLE for human triage — she opens the document and decides. Prefer Belle-triage over UNSURE for an undeterminable-attachment email.',
  'DOCUMENT-COPY REQUESTS are ACTIONABLE, never NO_TAG: a request to SEND / PROVIDE a copy of a document we may have on file (an inspection report, work order, receipt, disclosure, etc.) needs someone to check the file and send it. Route it — an inspection-report copy -> Belle; a disclosure -> Edelyn/Ethan by side. If the email is a jumble of asks or has no property address to identify the deal/owner, default to Needs Attention (a human triages). Do NOT mark it NO_TAG just because it also mentions inspection scheduling.',
  'SIDE from the counterparty\'s own words: when the SENDER (the opposing agent/broker) refers to "MY seller" / "my listing" / "the seller I represent", THEY are on the seller side, so WE are on the BUYER side -> buyer-side routing (e.g. an AVID/disclosure -> Edelyn). If they say "MY buyer", we are the SELLER side -> Ethan. This is a reliable side signal when present, and beats guessing from a document\'s name.',
  'An AVID (Agent Visual Inspection Disclosure) sent "for signatures" routes by WHO must SIGN it, which follows the side we represent: needs the SELLER\'s signature -> Ethan; needs the BUYER\'s signature -> Edelyn. The document name ("Buyer Agent AVID", "Selling Agent AVID") refers to who PREPARED it, NOT which side signs — do NOT route on the name. If the side is known (side tag or deal list), use it.',
  'The word "AUDIT" splits two ways: a PURCHASE CONTRACT audit (reviewing the RPA/contract itself) -> Allana. A question about what documents are still OUTSTANDING / needed or whether the SELLER has signed / where to find the seller\'s docs -> Ethan (seller-side file/document status). Use the side and what is being audited to tell them apart.',
  'DEAL TYPE comes from the SUBJECT + WHOLE THREAD, not just the newest message. The newest message is the immediate ask; the thread tells you what KIND of deal it is (lease, purchase, listing) and therefore who owns the file. Route by the file owner. Example: a thread whose subject/attachments show a LEASE (Residential Lease, RLMM, month-to-month, "Lease Contract") belongs to Megan even if the newest message is a generic question about compensation, payment, or timing — do not route that to Belle/others on the strength of the newest message alone.',
  'BUYER vs SELLER side flips disclosure routing: buyer-side disclosure work -> Edelyn, seller-side disclosure work -> Ethan. Prefer a side tag if one is present; otherwise infer side from the content.',
  'SOLAR PAY-OFF: a solar loan payoff (a "paid in full" / "paid off" / payoff / "Payment Received" letter for a solar loan, e.g. Solar Mosaic, Solar Servicing, or Sunrun; the letter confirming the solar loan is paid off so title/escrow can clear it before closing) routes by the SIDE we represent, like disclosures: seller-side -> Ethan; buyer-side -> Edelyn; if we represent BOTH sides (dual agency) -> Ethan. This holds even when the newest message is just the agent forwarding the letter to escrow ("this is the paid in full letter"). Do NOT route it to Megan because she is cc\'d or the thread says "Megan\'s team", and do NOT treat it as a generic Belle milestone; it follows the buyer/seller disclosure split.',
  'STRONG PRIOR from sub-labels: if a "Buyer Disclosures" sub-label is present the handler is USUALLY Edelyn; if a "Seller Signed Disclosures" sub-label is present it is USUALLY Ethan. Follow this unless the content clearly indicates a different person.',
  'The abbreviation "RFR" is AMBIGUOUS — read the context: "Receipt for Reports" (acknowledging/signing receipt of the inspection/disclosure REPORTS — part of the disclosure flow, e.g. "signed the RFR for the reports") routes by disclosure SIDE: seller-side (e.g. a "Seller Signed Disclosures" thread) -> Ethan, buyer-side -> Edelyn. That is DIFFERENT from "Request for Repairs" (RR / RRRR — negotiating repairs) -> Jill. Do not send a Receipt-for-Reports email to Jill.',
  'VP / VOP / final walk-through: if ATTACHED requesting the SELLER signature -> Ethan; if someone is requesting us to SEND the VP/VOP -> Edelyn.',
  'Disclosures: "for the SELLER to sign" or fully-executed-by-buyer packages we receive -> Ethan; "for the BUYER to sign" (package to send the buyer) -> Edelyn.',
  'LETTERHEAD / SOURCE is a strong signal. A document on the ESCROW COMPANY\'s letterhead (escrow instructions, escrow amendments, escrow statements — the escrow office\'s own paperwork) -> Belle. A CAR (California Association of Realtors) form is contract paperwork -> its owner: addenda / amendments -> Jill; disclosures -> Ethan or Edelyn by side.',
  'AMENDMENTS split by WHO issues them: amended ESCROW INSTRUCTIONS issued/returned by the ESCROW OFFICER (escrow-company paperwork — amended instructions, an escrow amendment for a price reduction, amended commission instructions) -> Belle. CONTRACT-side amendments on CAR forms requested or sent by an AGENT (CAR addendum, a CAR Purchase Price Amendment form, seller credit addendum, AOAA) -> Jill. So the SAME price reduction is Belle when it arrives as the escrow officer\'s amended instructions, but Jill when an agent sends a CAR Purchase Price Amendment form.',
  'Commission: the commission AMOUNT / amended-revised commission from an agent -> Belle; a commission QUESTION or concern -> Belle; amended commission INSTRUCTIONS from escrow -> Belle (Belle owns all escrow-officer amended instructions).',
  'AGENT REIMBURSEMENT is the Belle+Megan pair, not either one alone. When an agent paid out of pocket for a deal expense and asks to be repaid at closing, do NOT route it to Belle alone as an inspection receipt just because a report or invoice PDF is attached, and do NOT route it to Megan alone as a CDA request just because it touches the CDA. An invoice attached to a reimbursement email is EVIDENCE OF THE AMOUNT owed, not an inspection report being filed — the ask is the money, not the document. This holds even when the email never says "CDA".',
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
  mode: 'live', // 'shadow' = decide + log only, mutate nothing | 'live' = apply
};

const GATE = {
  model: 'claude-haiku-4-5-20251001',
  effort: 'low',
  // Confidence levels TRUSTED to CLEAR an email on skip=true (the gate returns
  // 'high' | 'medium' | 'low'). A skip at any other level routes to Needs
  // Attention instead of being cleared.
  //
  // Why this exists: a skip marks the email read, drops it from the queue, and
  // applies no label — so a wrong skip is the one path where actionable mail
  // vanishes with nobody watching. The gate runs FIRST, on every email, before
  // the classifier ever sees it. This mirrors CLASSIFIER.confidenceThreshold,
  // which already blocks a shaky NO_TAG from silently clearing for the same
  // reason. Rule 6 ("if unsure, return skip_assignment = false") is a fail-safe
  // in the PROMPT; this is the one in the CODE.
  //
  // To tighten: drop 'medium' so only a high-confidence skip may clear.
  trustedSkipConfidence: ['high', 'medium'],
};

const CLASSIFIER = {
  mode: 'live', // 'shadow' = log the would-be person, still apply Needs Attention | 'live'
  // Model: Opus. Haiku trial (2026-07-17) was rejected — in the shadow day it made
  // 2 CONFIDENT misroutes to the wrong person (should-be-Ethan -> Jill@0.95,
  // should-be-Jill -> Allana@0.85), which is the one failure the confidence gate
  // can't catch (high-confidence wrong answers sail past the threshold). Opus
  // routed cleanly across 200+. Opus costs ~5x Haiku, but dropping Zapier to the
  // 50k tier once labeling moves in-house more than covers it, so Opus is net
  // cost-positive AND accurate.
  model: 'claude-opus-4-8',
  effort: 'medium', // log-only (the ledger's Effort column); not sent to the API
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

// Person hints implied by a thread's labels: [{ label, person }] for every
// LABEL_HINTS entry present. Passed to the classifier as strong priors.
function labelHints(labelNames = []) {
  const out = [];
  for (const [label, person] of Object.entries(LABEL_HINTS)) {
    if (labelsInclude(labelNames, label)) out.push({ label, person });
  }
  return out;
}

module.exports = {
  TENANT,
  LABELS,
  SKIP_BEHAVIOR,
  CATEGORY_ROUTING,
  SIDE_TAGS,
  SIDE_TAG_ROUTING,
  LABEL_HINTS,
  SENDER_ROUTING,
  ROSTER,
  PAIRS,
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
  labelHints,
};
