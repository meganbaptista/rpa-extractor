// netlify/functions/lib/document-audit.js
//
// ============================================================================
// WHAT IS THIS DOCUMENT, AND WHO STILL HAS TO SIGN IT.
// ============================================================================
// The second half of the split. page-strips.js has already decided WHERE each
// document starts and ends, deterministically, from the labels printed at the
// edges of the pages. This module takes those spans and answers the two
// questions that genuinely need a document read: what form is it, and is it
// fully executed.
//
// WHY THE SPLIT IS WORTH IT. The old single call asked for the whole split map
// AND a per-form signature audit over an entire packet in one response. On the
// 65-page 1333 S Beverly Glen delivery it answered plausibly and incompletely:
// 28 forms covering 73 of 110 pages, with the cooperating broker's disclosures
// and the buyer agent's AVID simply absent. Nothing in the output said so.
//
// The fix is not a better prompt over 65 pages. It is asking a smaller
// question. Each document here arrives as its own PDF of one to five pages,
// and the model is told what page range it holds and what the strips read off
// its edges. Finding boundaries - the part that degraded with length - is
// already done and is not asked again.
//
// PAGES ARE NOT NEGOTIABLE HERE. The span comes from the strip read and is
// passed through untouched. If the model believes a block holds more than one
// document it says so in `boundary_dispute` and those pages go to human
// review, because a disagreement about where a form ends is exactly the thing
// that must not be resolved by a guess: guessing files half a form under a
// confident name.
// ============================================================================

const { callClaude } = require('./claude');
const { footerDocName } = require('./page-strips')._internal;
const { mapLimit } = require('./map-limit');

/**
 * How much goes in one call.
 *
 * The whole point is to keep each question small, so these are caps on
 * ATTENTION, not on tokens. Five documents of up to fourteen pages between
 * them keeps every block short enough to be read properly while amortising the
 * rule text, which is the expensive constant. A single document longer than
 * the page cap still goes in a call of its own rather than being cut.
 */
const AUDIT_DOCS_PER_CALL = 5;
const AUDIT_PAGES_PER_CALL = 14;

const MODEL = 'claude-opus-4-8';

/**
 * How many audit calls run at once.
 *
 * Measured: the 65-page Beverly Glen packet needs 7 calls and took 335s in
 * sequence. A 110-page delivery would be near 10 minutes, which crowds the
 * background function's ceiling for no reason, since the calls are
 * independent. Three at a time is a bounded speed-up that does not race the
 * API or hold ten carved PDFs in memory at once.
 */
const AUDIT_CONCURRENCY = 3;

/**
 * THE RULES, carried over verbatim from the single-call prompt this replaces.
 *
 * Every paragraph below was written because a real delivery was filed wrong
 * without it, so they are copied rather than re-expressed. What has been
 * DROPPED is the whole split-map half - boundary finding, page spans, "every
 * page should belong to exactly one form" - because that is now decided in
 * code from the page strips and must not be re-litigated here.
 */
const RULES =
  'IDENTIFYING THE FORM.\n' +
  'Return the standard C.A.R. code in "code" (e.g. TDS, SPQ, SBSA, AVID, FHDS, LPD, WBSA, ESD, RPA, ' +
  'BRBC, RLA, AD, BCA, BIA, CCPA, PRBS-B, PRBS-S), the full form name in "name", and the printed ' +
  'revision date in "revision" as M/YY ("" if none). A document with no C.A.R. code gets "code":"" and ' +
  'keeps its own printed title as "name".\n' +
  'Also return "brokerage": the real estate BROKERAGE whose document this is, as printed on it - ' +
  '"Coldwell Banker Realty", "Sotheby\'s International Realty", "Christie\'s International Real ' +
  'Estate", "Compass". Read it from the logo or name in the header, or from the firm name and ' +
  'address printed in the footer when the header carries none. Give the FIRM only, without an office ' +
  'or region suffix: "Coldwell Banker Realty", not "Coldwell Banker Realty - Hancock Park". Use "" ' +
  'for a C.A.R. form, which belongs to no brokerage - the California Association of Realtors is the ' +
  'PUBLISHER and is never the answer here.\n' +
  'NEVER INVENT A NAME. If you cannot tell what a document is, return an EMPTY name rather than a ' +
  'placeholder like "Misc", "Other" or "Disclosures". An honestly unnamed document is filed for human ' +
  'review; a placeholder name is filed as though it were understood.\n' +
  'AVID side: an Agent Visual Inspection Disclosure can be the listing agent\'s or the buyer\'s ' +
  'agent\'s. Set "code" to "AVID-LA" when completed by the LISTING (seller\'s) agent and "AVID-BA" when ' +
  'completed by the BUYER\'S agent. Read the agent name and brokerage on the "Inspection Performed By ' +
  '(Real Estate Broker Firm Name)" line, then match that brokerage to a side using the PACKET CONTEXT ' +
  'given below, which lists the brokerages appearing across the whole delivery: the LISTING brokerage ' +
  'recurs throughout a seller-disclosure package, so an AVID matching the recurring brokerage is ' +
  'AVID-LA and one matching a different, clearly buyer-side brokerage is AVID-BA. Only when it cannot ' +
  'be matched to either side from any evidence, use plain "AVID" rather than guessing.\n' +
  'TOA (Text Overflow Addendum): a continuation sheet for whatever form ran out of space in a field. ' +
  'Its body starts by naming the PARENT form\'s code in square brackets, e.g. "[SPQ]" or "[TDS]". Set ' +
  '"code" to "TOA" and "parent_code" to that bracketed code ("" if none is printed).\n' +
  'ADDENDUM (an amendment or continuation that is NOT text overflow). Two kinds. (a) A C.A.R. Form ' +
  'ADM: its header reads "ADDENDUM No. ___" and "(C.A.R. Form ADM...)". Read the checkbox row near the ' +
  'top to see what it amends - "Purchase Agreement", "Transfer Disclosure Statement", a lease, or ' +
  '"Other ___" - and confirm against the section codes referenced in its body. Set "code" to "ADM", ' +
  '"name" to "Addendum", "parent_code" to the parent\'s C.A.R. code ("TDS" for the Transfer Disclosure ' +
  'Statement, "SPQ" for the Seller Property Questionnaire, "RPA" for the Purchase Agreement), and ' +
  '"doc_no" to the number printed after "ADDENDUM No." ("" if blank). (b) A custom continuation sheet ' +
  'with NO C.A.R. code whose title is "Addendum to <form>" (e.g. "Addendum to Seller Property ' +
  'Questionnaire") and whose body is keyed to that form\'s sections - set "code" to "", keep its ' +
  'printed "name", set "parent_code" to that parent\'s C.A.R. code, and leave "doc_no" as "".\n' +
  'COUNTER OFFER: C.A.R. Forms BCO (Buyer Counter Offer), SCO (Seller Counter Offer) and SMCO (Seller ' +
  'Multiple Counter Offer) are NUMBERED. Set "code" to the printed code, "name" to the full form name, ' +
  'and "doc_no" to the number printed after "No." in its title ("" if blank). Leave "parent_code" ' +
  'blank - a counter is its own document, not an amendment of another form.\n' +
  'For every document that is neither a TOA nor an addendum nor a counter, set both "parent_code" and ' +
  '"doc_no" to "".\n' +
  'Booklet receipt: a page acknowledging RECEIPT of the environmental-hazards / earthquake-safety ' +
  'booklet(s) (the "Homeowner\'s Guide to Environmental Hazards and Earthquake Safety", and/or the HERS ' +
  '/ lead-paint booklets) - the standard C.A.R. receipt OR a custom brokerage equivalent (e.g. a ' +
  '"Receipt for Links to Booklets" page). Set "code" to "" and "name" to exactly "EQ Booklet Receipt". ' +
  'CRITICAL: the informational BOOKLET itself (the multi-page guide) is NOT this receipt - only a ' +
  'signed or signable acknowledgment-of-receipt page is.\n' +
  '  TWO COPIES ON ONE PAGE: this receipt is very often printed TWICE on the same sheet, one ' +
  'acknowledgement above the other, separated by a dashed cut line. They are NOT duplicates - the ' +
  'upper block is signed by the BUYER side (its lines read "(Buyer\'s signature)" and "(Buyer\'s ' +
  'Agent\'s signature)") and the lower block by the SELLER side ("(Seller\'s signature)", "(Seller\'s ' +
  'Agent\'s signature)"). AUDIT BOTH BLOCKS. A sheet where the seller half is fully signed and the ' +
  'buyer half is entirely blank is NOT complete: required_signers includes the parties named on BOTH ' +
  'blocks, and present_signers only those who actually signed. Read the party label printed UNDER each ' +
  'signature line to decide whose block it is, never the position on the page. A "(Broker\'s name)" ' +
  'line on this form is a printed firm name, not a signature - ignore it.\n' +
  'BROKERAGE-BRANDED DOCUMENTS: a disclosure package very often carries a brokerage\'s own paperwork - ' +
  'a branded addendum or that brokerage\'s area disclosures. Tells: the brokerage logo and name in a ' +
  'header or footer (Coldwell Banker Realty, Compass, Douglas Elliman, Sotheby\'s International ' +
  'Realty, Christie\'s, The Agency, Berkshire Hathaway), a title like "<BROKERAGE> CONTRACT ADDENDUM ' +
  'AND OTHER <REGION> AREA DISCLOSURES", and numbered paragraphs about that brokerage\'s affiliated ' +
  'services. Set "code" to "" and "name" to the document\'s own printed title, KEEPING the brokerage in ' +
  'it (e.g. "Coldwell Banker Contract Addendum and Other Greater Los Angeles Area Disclosures").\n' +
  'MLS printout and Property Profile: two NON-C.A.R. documents that commonly ride along inside a ' +
  'signed disclosure package.\n' +
  '  - MLS printout: an MLS listing detail sheet for the subject property. Tells: an MLS report ' +
  'header/footer such as "Customer Full", "Agent Full" or "Client Full", a "Listing ID" or "MLS #", a ' +
  '"Printed:" timestamp, the MLS/association name, listing photos, and "Facts & Features" / Interior / ' +
  'Exterior bullet sections. Set "code" to "" and "name" to exactly "MLS".\n' +
  '  - Property Profile: a title- or data-vendor property report (e.g. a CoreLogic "Property Details" ' +
  'report). Tells: an APN and/or CLIP, and sections like OWNER INFORMATION, COMMUNITY INSIGHTS, ' +
  'LOCATION INFORMATION, TAX INFORMATION, ASSESSMENT & TAX, LAST MARKET SALE & SALES HISTORY, MORTGAGE ' +
  'HISTORY, PROPERTY MAP. Set "code" to "" and "name" to exactly "Property Profile".\n' +
  '  Neither carries C.A.R. signature lines: their only marks are initials, typically a DocuSign ' +
  'initial tag in a top corner of the first page, and WHO initials varies (the seller, the buyers, or ' +
  'both). So for these two ONLY, do not reason about who was required to sign. Report who actually ' +
  'marked it: set "present_signers" to every party that left ANY initial or signature mark anywhere on ' +
  'the document, and "required_signers" to that exact same set. If there is no mark anywhere, set BOTH ' +
  'to [].\n\n' +
  'THE SIGNATURE AUDIT.\n' +
  'Determine who has signed or initialed everywhere this document requires. The parties are: B = ' +
  'Buyer, S = Seller, BA = Buyer\'s Agent, LA = Listing/Seller\'s Agent, BR = the Broker or Office ' +
  'Manager THEMSELVES. A line labelled "Broker", "Brokerage", "Broker/Agent" or "By (Agent)" is ' +
  'normally an AGENT line: map it to BA on a buyer-side document (BRBC, buyer advisories, a buyer ' +
  'counter offer) and to LA on a listing-side document (RLA, seller advisories, a seller counter ' +
  'offer). USE BR ONLY where the form asks the broker or office manager to sign IN THAT CAPACITY, ' +
  'distinct from the agent who already signed - the clearest case is the ABA, whose acknowledgement ' +
  'lines read "By (Broker/Office Manager)". A printed "(Broker\'s name)" or brokerage-name field is ' +
  'NOT a signature line and is never BR. Two-party agreements are normal - a BRBC requires only B and ' +
  'BA, an RLA only S and LA - so do NOT pad required_signers to all four.\n' +
  '  - "signature_lines": EVERY signature or initial line PRINTED on this document, in the order they ' +
  'appear, as {"label":"","signed":true|false}. "label" is the party wording printed beside or beneath ' +
  'the line, verbatim - "Seller", "Buyer", "Buyer\'s or Seller\'s Signature", "(Buyer\'s Agent\'s ' +
  'signature)", "By (Broker/Office Manager)", "Inspection Performed By". "signed" is whether THAT line ' +
  'carries a mark.\n' +
  '    LIST THE BLANK LINES. This is the whole point of the field. A printed line nobody signed is the ' +
  'strongest evidence in the document that the party WAS required, and it is exactly the line that ' +
  'gets overlooked because there is nothing written on it. On page 3 of a Coldwell Banker affiliated ' +
  'business disclosure the two Buyer lines were signed and dated and the two Seller lines were empty; ' +
  'reporting only the signed ones made an unsigned form read as fully executed, which is the one ' +
  'status a coordinator acts on without opening the file.\n' +
  '    Count them individually: two Seller lines on a two-seller deal are TWO entries, not one.\n' +
  '  - "required_signers": the subset of ["B","S","BA","LA","BR"] this document requires, judged from ' +
  'those printed lines and nothing else.\n' +
  '  - "present_signers": the subset of required_signers who have ACTUALLY completed their signature ' +
  'AND every initial they are required to. A party counts as present ONLY if all of their required ' +
  'marks are done; if any required initial or signature for that party is missing, do NOT include ' +
  'them.\n' +
  'Judge by how a party actually signed: a wet signature, a DocuSign/e-sign block, or initials all ' +
  'count. A pre-printed or typed party name (e.g. a typed "Seller" name that is a trust or LLC) is NOT ' +
  'a signature.\n' +
  'AVID signatures: the AVID carries acknowledgement lines for BOTH principals, so required_signers is ' +
  'the inspecting agent PLUS both: a listing-side AVID is LA + S + B, and a BUYER\'s agent AVID is ' +
  'BA + S + B. THE SELLER IS REQUIRED ON A BUYER-AGENT AVID and is very often the one still missing ' +
  'when it reaches us, because it arrives straight from the other side before our seller has seen it. ' +
  'Megan, 2026-09-24: "expect there is NOT a seller signature present on the BA AVID usually", and she ' +
  'hand-names exactly that case "BA AVID - need SS". So a BA AVID signed only by the buyer and their ' +
  'agent is NOT fully executed; it is NeedSS. The same holds for ANY document arriving from the ' +
  'cooperating broker for the first time: absent OUR side\'s signature is the normal state and must be ' +
  'reported, never rounded up to complete.\n\n' +
  'WHERE EACH DOCUMENT STARTS AND ENDS HAS ALREADY BEEN WORKED OUT from the labels printed at the ' +
  'edges of the pages. Each block below should be exactly one document. Do NOT return page numbers for ' +
  'a normal document.\n' +
  'BUT THE EDGES CAN BE WRONG, and you are looking at whole pages while that step saw two narrow ' +
  'strips. If a block plainly holds MORE THAN ONE document - two different titles, each with its own ' +
  'signature lines, or a different signing envelope stamped at the top - then say so:\n' +
  '  set "boundary_dispute" to true;\n' +
  '  set "split_after" to the positions WITHIN THIS BLOCK after which a new document begins, counting ' +
  'the block\'s own pages from 1. A 3-page block holding three separate one-page documents is ' +
  '"split_after":[1,2]. A 4-page block holding a 3-page form then a 1-page receipt is ' +
  '"split_after":[3]. Never include the block\'s last position, and never a position outside it;\n' +
  '  set "dispute_note" to a one-line description of what you saw.\n' +
  'The pieces are then re-read separately, so a correct "split_after" gets every document filed under ' +
  'its own name. If you are sure there are several documents but cannot tell where they divide, set ' +
  'boundary_dispute true and leave "split_after" empty - those pages go to a human, which is the right ' +
  'outcome for a genuine unknown but a poor one for a boundary you can actually see. In every normal ' +
  'case set "boundary_dispute" to false and "split_after" to [].';

const SHAPE =
  'Respond with ONLY this JSON, no prose and no fences, with exactly one entry per document block ' +
  'above, in the same order:\n' +
  '{"documents":[{"n":1,"code":"TDS","name":"Real Estate Transfer Disclosure Statement",' +
  '"revision":"12/25","parent_code":"","doc_no":"","required_signers":["S","B","BA","LA"],' +
  '"present_signers":["S","B","BA","LA"],' +
  '"brokerage":"",' +
  '"signature_lines":[{"label":"Seller","signed":true},{"label":"Buyer","signed":true}],' +
  '"boundary_dispute":false,"split_after":[],"dispute_note":""}]}';

/**
 * A printed line's party label -> the tokens it can belong to.
 *
 * Returns a LIST because some labels are genuinely ambiguous: an affiliated
 * business disclosure prints four lines all reading "Buyer's or Seller's
 * Signature", and on a two-buyer two-seller deal that is two of each. Both
 * tokens are then required, which is the conservative and correct reading.
 *
 * Order matters: AGENT wordings are checked before the bare party, or
 * "(Buyer's Agent's signature)" matches Buyer and routes an agent's signature
 * to the buyer.
 */
function tokensForLabel(label) {
  const t = String(label || '').toLowerCase();
  if (!t.trim()) return [];
  // The broker or office manager signing IN THAT CAPACITY, distinct from the
  // agent who already signed. Needs the capacity wording; a bare "Broker" does
  // not qualify.
  if (/broker\s*\/\s*office\s*manager|office\s*manager/.test(t)) return ['BR'];
  // An AVID's "Inspection Performed By (Real Estate Broker Firm Name)" line is
  // the inspecting AGENT's; which side that is comes from the form's own code.
  if (/inspection\s+performed\s+by/.test(t)) return ['AGENT'];
  const out = new Set();
  if (/buyer'?s?\s*agent|agent.*buyer/.test(t)) out.add('BA');
  if (/(seller|listing)'?s?\s*agent|agent.*seller/.test(t)) out.add('LA');
  if (!out.size) {
    if (/\bbuyer|\btenant/.test(t)) out.add('B');
    if (/\bseller|\blandlord/.test(t)) out.add('S');
    if (!out.size && /\bbroker|\bby\s*\(agent\)/.test(t)) out.add('AGENT');
  }
  return [...out];
}

const TOKENS = ['B', 'S', 'BA', 'LA', 'BR'];
function normTokens(arr) {
  const out = new Set();
  for (const v of (Array.isArray(arr) ? arr : [])) {
    const t = String(v || '').trim().toUpperCase();
    if (TOKENS.includes(t)) out.add(t);
  }
  return [...out];
}

/**
 * THE REQUIREMENT COMES FROM THE PRINTED LINES. THIS IS THE FIX FOR AN
 * UNSIGNED FORM BEING STAMPED FX.
 *
 * On the 1333 S Beverly Glen delivery two affiliated business disclosures
 * filed as fully executed with the sellers' signature lines blank. The audit
 * had reported `required_signers: ["B"]`, because the buyers were the only
 * parties who HAD signed. Asking "who signed?" and "who had to sign?" as one
 * question lets the second answer collapse into the first, and it collapses in
 * the dangerous direction every time - FX is the one status a coordinator acts
 * on without opening the file. Megan: "it broke them up and then marked one as
 * FX when it wasn't."
 *
 * So the model now transcribes every printed line and whether it carries a
 * mark, and the requirement is computed from that list. Two properties worth
 * keeping:
 *   The model's own `required_signers` is UNIONED in, never used to subtract.
 *     If it noticed an initial box the line list missed, that is a real
 *     requirement; if it forgot a blank line, the list still carries it.
 *   `present_signers` stays the model's answer, intersected with what is
 *     required. WHO signed needs reading - a printed name, a date, a DocuSign
 *     block - and the ambiguous labels make it undecidable from counts alone:
 *     four "Buyer's or Seller's" lines with two signed cannot tell you which
 *     two from the list, but the document itself plainly can.
 */
function resolveSigners(audit, code) {
  const lines = Array.isArray(audit.signature_lines) ? audit.signature_lines : [];
  const side = /AVID-BA/i.test(code || '') ? 'BA' : (/AVID-LA/i.test(code || '') ? 'LA' : null);
  const required = new Set();
  for (const l of lines) {
    for (const tok of tokensForLabel(l && l.label)) {
      if (tok !== 'AGENT') required.add(tok);
      else if (side) required.add(side);
    }
  }
  for (const tok of normTokens(audit.required_signers)) required.add(tok);

  const present = new Set();
  for (const tok of normTokens(audit.present_signers)) if (required.has(tok)) present.add(tok);

  /**
   * WHEN THE PAGE DOES NOT SAY WHICH PARTY, DO NOT NAME ONE.
   *
   * Sotheby's affiliated business disclosure prints four identical lines
   * reading "Buyer's or Seller's Signature" with no printed names beside them.
   * On the Beverly Glen packet two were signed and two were blank, and the
   * audit called the signers the SELLERS - but their date, 09/18/2026, is the
   * buyers' signing date everywhere else in that delivery (the sellers signed
   * 09/10). From that page alone the attribution is genuinely undecidable, and
   * getting it backwards is worse than not answering: it sends a coordinator
   * to chase the buyer's side for a signature their own seller owes.
   *
   * So an unsigned line whose own label refuses to say whose it is makes the
   * document a review rather than a named chase. The cross-document evidence
   * that would settle it - each party's signing date, taken from a form whose
   * labels ARE explicit - is not available to a per-document audit.
   */
  const unresolved = lines.filter((l) => l && !l.signed && tokensForLabel(l.label).length > 1).length;

  return {
    required_signers: [...required],
    present_signers: [...present],
    lines,
    signerAmbiguity: unresolved > 0 ? unresolved : 0,
  };
}


/**
 * Split the documents into calls.
 *
 * Pure, so the batching is testable without a PDF or a model. A document is
 * never split across calls: the whole design rests on each block being one
 * complete document, so an oversized one goes alone rather than being cut.
 */
function groupForAudit(documents, docsPerCall = AUDIT_DOCS_PER_CALL, pagesPerCall = AUDIT_PAGES_PER_CALL) {
  const groups = [];
  let group = [];
  let pages = 0;
  for (const doc of documents) {
    const n = doc.pages.length;
    const full = group.length >= docsPerCall || (group.length > 0 && pages + n > pagesPerCall);
    if (full) { groups.push(group); group = []; pages = 0; }
    group.push(doc);
    pages += n;
  }
  if (group.length) groups.push(group);
  return groups;
}

/**
 * What the strips read off this document's edges, as a hint.
 *
 * Offered as evidence rather than as an answer. The strips are a transcription
 * of two narrow bands, so they can miss a code printed mid-page, and the model
 * is looking at the whole document - it should correct them. What it may not
 * do is change the page span, which is why the pages are stated as settled.
 */
function hintFor(doc) {
  const bits = [];
  if (doc.title) bits.push(`title "${doc.title}"`);
  if (doc.carCode) bits.push(`C.A.R. code "${doc.carCode}"`);
  if (doc.brand) bits.push(`brokerage "${doc.brand}"`);
  if (doc.footerName) bits.push(`footer names "${doc.footerName}"`);
  return bits.length ? `Strips read from its edges: ${bits.join('; ')}.` : 'Its edges carried no readable label.';
}

/**
 * The brokerage evidence, WITH COUNTS, which is how an AVID gets a side.
 *
 * An AVID is the listing agent's or the buyer's agent's, and the only way to
 * tell from the packet is whose brokerage performed the inspection. Bare names
 * were not enough: on the Beverly Glen packet the same AVID came back AVID-BA
 * twice and AVID-LA once, because "these brokerages appear in this delivery"
 * gives no way to tell the side that ASSEMBLED the package from the side that
 * sent two pages into it.
 *
 * Counts do give a way. The listing side prepares a seller-disclosure
 * delivery, so its brand recurs across many documents, while a cooperating
 * broker's paperwork arrives as one packet. That is evidence rather than proof,
 * so it is handed over as counts and reasoning rather than as a verdict - and
 * the AVID rule still says to fall back to plain "AVID" rather than guess.
 */
function brandKey(brand) {
  return String(brand || '')
    .replace(/[\u00ae\u2122]/g, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The form PUBLISHER is not a brokerage.
 *
 * Every C.A.R. form carries "CALIFORNIA ASSOCIATION OF REALTORS" in its
 * header, so counting it puts the publisher near the top of a list whose whole
 * purpose is to tell two brokerages apart.
 */
const NOT_A_BROKERAGE = /^(california association of realtors|c a r|snapnhd)$/;

function tallyBrands(documents) {
  // Group by normalised key so casing and a registered-trademark mark do not
  // make one firm look like three.
  const groups = new Map();
  for (const d of documents) {
    const key = brandKey(d.brand);
    if (!key || NOT_A_BROKERAGE.test(key)) continue;
    const g = groups.get(key) || { key, count: 0, spellings: new Map() };
    g.count += 1;
    g.spellings.set(d.brand, (g.spellings.get(d.brand) || 0) + 1);
    groups.set(key, g);
  }
  // Fold a longer name into a shorter one it contains: "AKG | Christie's
  // International Real Estate" and "Christie's International Real Estate
  // SoCal" are one firm branding itself at three lengths, and split across
  // three rows they lose to a cooperating broker that appears four times.
  const keys = [...groups.keys()].sort((a, b) => a.length - b.length);
  const canonical = new Map();
  for (const key of keys) {
    const host = keys.find((k) => k !== key && k.length < key.length && key.includes(k));
    canonical.set(key, host ? (canonical.get(host) || host) : key);
  }
  const merged = new Map();
  for (const g of groups.values()) {
    const into = canonical.get(g.key);
    const m = merged.get(into) || { count: 0, spellings: new Map() };
    m.count += g.count;
    for (const [text, n] of g.spellings) m.spellings.set(text, (m.spellings.get(text) || 0) + n);
    merged.set(into, m);
  }
  // Display the SHORTEST spelling the firm used, not its normalised key and
  // not its most frequent spelling. The shortest is the bare firm name, which
  // is what an AVID's "Inspection Performed By (Real Estate Broker Firm Name)"
  // line is matched against - and that line carries an office suffix
  // ("Coldwell Banker Realty - Hancock Park"), so the firm name being a
  // substring of it is what makes the match work. Ties break on frequency and
  // then on first appearance, so the output is stable run to run.
  return [...merged.values()]
    .map((m) => {
      const [best] = [...m.spellings.entries()]
        .sort((a, b) => a[0].length - b[0].length || b[1] - a[1]);
      return [best[0], m.count];
    })
    .sort((a, b) => b[1] - a[1]);
}

function packetContext(documents) {
  const ranked = tallyBrands(documents);
  if (!ranked.length) return 'PACKET CONTEXT: no brokerage names were read from this delivery.';
  const lines = ranked.map(([brand, n]) => `  ${brand} - on ${n} document(s)`).join('\n');
  const top = ranked[0];
  const clear = ranked.length > 1 && top[1] > ranked[1][1];
  return 'PACKET CONTEXT. Brokerage names read from the headers of this whole delivery, with how many '
    + 'documents each appears on:\n' + lines + '\n'
    + 'The side that ASSEMBLED this delivery brands many of its documents; a cooperating broker on the '
    + 'other side typically contributes one packet of two or three. '
    + (clear
      ? `So "${top[0]}" is most likely the assembling side's brokerage here, and a brokerage lower down `
        + 'this list is most likely the other side\'s.'
      : 'The counts here do not clearly separate the two sides, so weigh other evidence in the document '
        + 'itself and do not guess.');
}

/**
 * Turn a disputed block into the pieces the audit says are in it.
 *
 * Returns null unless the proposal is usable, and "usable" is strict on
 * purpose: this REPLACES a span, so a half-understood proposal is worse than
 * the dispute it came from. Every offset must be inside the block, in order,
 * and distinct - otherwise the pages go to a human, which is what a dispute
 * with no readable split does anyway.
 */
function applySplit(doc, splitAfter) {
  const offsets = (Array.isArray(splitAfter) ? splitAfter : [])
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n < doc.pages.length);
  const unique = [...new Set(offsets)].sort((a, b) => a - b);
  if (!unique.length) return null;

  const pieces = [];
  let from = 0;
  for (const cut of [...unique, doc.pages.length]) {
    pieces.push(doc.pages.slice(from, cut));
    from = cut;
  }
  if (pieces.some((p) => !p.length)) return null;
  // Belt and braces: the pieces must be exactly the block, no page lost or
  // duplicated. This is the one place a model gets to change a page span.
  const flat = pieces.flat();
  if (flat.length !== doc.pages.length || flat.some((p, i) => p !== doc.pages[i])) return null;

  return pieces.map((pages, i) => ({
    ...doc,
    pages,
    // The strip labels described the whole block, so they no longer describe
    // any one piece. Only the first piece can still own the block's title.
    title: i === 0 ? doc.title : '',
    carCode: i === 0 ? doc.carCode : '',
    declaredLength: 0,
    // The block's OWN span notes are dropped: "span is 2 page(s) but the
    // document says 1" described the merged block and stopped being true the
    // moment it was split, but it rode onto both halves on 834 Victoria Ln and
    // sat in the log beside two correctly filed documents.
    notes: [`split out of pages ${doc.pages[0]}-${doc.pages[doc.pages.length - 1]} after the audit found more than one document there`],
  }));
}

/** Audit one group of documents in a single call. */
async function auditGroup(group, allDocuments, carve, note) {
  const content = [];
  const carved = [];
  for (let i = 0; i < group.length; i++) {
    const doc = group[i];
    const bytes = await carve(doc.pages);
    if (!bytes) { carved.push(null); continue; }
    carved.push(doc);
    const span = doc.pages.length === 1
      ? `page ${doc.pages[0]}`
      : `pages ${doc.pages[0]}-${doc.pages[doc.pages.length - 1]}`;
    content.push({ type: 'text', text: `=== DOCUMENT ${i + 1}: ${span} of the delivery (${doc.pages.length} page(s)). ${hintFor(doc)} ===` });
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') }, title: `document-${i + 1}.pdf` });
  }
  if (!content.length) return [];
  content.push({ type: 'text', text: `${packetContext(allDocuments)}\n\n${RULES}\n\n${SHAPE}` });

  const raw = await callClaude({
    fn: 'disclosure-audit', model: MODEL, content, maxTokens: 8000,
    effort: 'high',        // the signature audit is the part that needs thinking
    note,
  });
  const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const byN = new Map((Array.isArray(parsed.documents) ? parsed.documents : [])
    .map((d) => [parseInt(d.n, 10), d]));

  const out = [];
  for (let i = 0; i < group.length; i++) {
    const doc = group[i];
    if (!carved[i]) {
      out.push({ doc, audit: null, reason: 'its pages could not be carved out of the packet' });
      continue;
    }
    const a = byN.get(i + 1);
    // A document the response skipped is UNREAD, not clean. This is the exact
    // failure mode of the old single call, so it is recorded rather than
    // defaulted - an unread document must not become a fully-executed one.
    if (!a) { out.push({ doc, audit: null, reason: 'the audit response did not include it' }); continue; }
    out.push({ doc, audit: a, reason: null });
  }
  return out;
}

/**
 * Identify and audit every document, returning the splitter's `forms` shape.
 *
 * `carve(pageNumbers) -> Buffer|null` builds a small PDF of those pages; the
 * splitter already has one for writing the output files, so the same function
 * serves as the audit's input and there is no second page-extraction path that
 * could disagree with it.
 */
async function auditDocuments(documents, carve, label = '', pass = 1) {
  const groups = groupForAudit(documents);
  const perGroup = await mapLimit(groups, AUDIT_CONCURRENCY, (group, g) => {
    const note = `${label} audit ${g + 1}/${groups.length}`;
    return auditGroup(group, documents, carve, note).catch((err) => {
      // One failed call loses its own documents, not the packet. They come
      // back unnamed with the reason attached, which routes them to review.
      console.warn(`[document-audit] ${note} failed: ${err.message}`);
      return group.map((doc) => ({ doc, audit: null, reason: `the audit call failed: ${err.message}` }));
    });
  });

  /**
   * A DISPUTED BLOCK GETS ONE MORE LOOK BEFORE ANYBODY HEARS ABOUT IT.
   *
   * The audit sees whole pages, so when it says a block holds three documents
   * and names where they divide, it is better informed than the strip read
   * that merged them. Re-reading the pieces turns the dispute into three
   * correctly filed documents instead of three pages in Unsorted.
   *
   * ONE round only (`pass`), because a second dispute on an already-split
   * piece means the disagreement is real and not a clerical miss - at that
   * point a human is the right answer, and a loop is not.
   */
  const resplit = [];
  const settled = [];
  for (const results of perGroup) {
    for (const r of results) {
      const pieces = (pass === 1 && r.audit && r.audit.boundary_dispute === true)
        ? applySplit(r.doc, r.audit.split_after)
        : null;
      if (pieces) resplit.push(...pieces);
      else settled.push(r);
    }
  }
  let extraForms = [];
  if (resplit.length) {
    const from = [...new Set(resplit.map((d) => d.pages[0]))].length;
    console.log(`[document-audit] ${from} disputed block(s) split into ${resplit.length} document(s), re-reading`);
    extraForms = await auditDocuments(resplit, carve, `${label} resplit`, pass + 1);
  }

  const forms = [];
  for (const { doc, audit, reason } of settled) {
    if (!audit) {
      // No name, so isUnidentified() routes it to Unsorted for review.
      forms.push({
        code: '', name: '', revision: '', pages: doc.pages,
        parent_code: '', doc_no: '',
        required_signers: [], present_signers: [],
        review: reason, strip: doc,
      });
      continue;
    }
    // A dispute that survived the resplit - the audit is sure there is more
    // than one document here but could not say where they divide. Left
    // unnamed so it files to Unsorted with the reason attached, which is the
    // right answer for a genuine unknown.
    const disputed = audit.boundary_dispute === true;
    const code = disputed ? '' : String(audit.code || '').trim();
    const signers = resolveSigners(audit, code);
    forms.push({
      code,
      name: disputed ? '' : String(audit.name || '').trim(),
      revision: String(audit.revision || '').trim(),
      pages: doc.pages,                     // from the strips, never the model
      parent_code: String(audit.parent_code || '').trim(),
      doc_no: String(audit.doc_no || '').trim(),
      // Whose document this is. The audit reads the whole page, so it sees a
      // firm name printed only in the footer, which the header strip cannot.
      // Falls back to what the strips read off the header.
      brokerage: String(audit.brokerage || '').trim() || String(doc.brand || '').trim(),
      required_signers: signers.required_signers,
      present_signers: signers.present_signers,
      signature_lines: signers.lines,
      review: disputed
        ? `more than one document may be here but the audit could not say where they divide: ${String(audit.dispute_note || '').trim() || 'unspecified'}`
        : (doc.notes && doc.notes.length ? doc.notes.join('; ') : null),
      strip: doc,
    });
  }

  // Page order, so the filed names follow the packet rather than the order the
  // resplit happened to finish in.
  const ordered = [...forms, ...extraForms].sort((a, b) => (a.pages[0] || 0) - (b.pages[0] || 0));
  return pass === 1 ? rejoinOutOfSequence(rejoinSplitForms(ordered)) : ordered;
}

/**
 * ONE DOCUMENT DELIVERED ACROSS NON-ADJACENT PAGES.
 *
 * Megan expects this never to happen - "nobody would send documents out of
 * sequence" - and she is right about what SHOULD arrive. The 1333 S Beverly
 * Glen package from the buyer's agent did it anyway, twice, and she confirmed
 * it after looking: "Page 17 is alone and goes with page 27, 18 is also alone
 * and goes with 42 and 43... i'm just shocked it was mismatched like that."
 *
 * Filed as fragments those cost twice over: three files for two forms, and the
 * compliance reconcile then matches one piece and reports the other as a
 * document nothing on the list asks for - one form reading as two separate
 * problems, which is exactly the confusion the DIA and SBSA caused earlier the
 * same day.
 *
 * SO THE PAGES ARE JOINED AND THE CONDITION IS REPORTED. Both halves matter.
 * Reassembling silently would hide a defect in what was SENT, which belongs
 * back with the sender, not buried in a tidy folder. Provenance survives
 * because the original delivery is archived to Incoming/_processed/.
 *
 * Only documents with NO C.A.R. code are considered: a C.A.R. form prints its
 * own "PAGE m OF n" and is contiguous by construction.
 */
function rejoinOutOfSequence(forms) {
  let out = joinByFooterTemplate(forms);
  out = joinOrphanAcknowledgement(out);
  return out.sort((a, b) => (a.pages[0] || 0) - (b.pages[0] || 0));
}

/** Pieces of one document, in page order, as a single form. */
function fuse(pieces, why) {
  const ordered = [...pieces].sort((a, b) => (a.pages[0] || 0) - (b.pages[0] || 0));
  const head = ordered[0];
  const all = ordered.flatMap((f) => f.pages).sort((a, b) => a - b);
  // The piece that carries the TITLE names the document, which is not always
  // the first piece by page number; and the piece that carries the SIGNATURE
  // lines is the one that knows whether it is executed.
  const named = ordered.find((f) => f.name) || head;
  const signed = ordered.reduce((best, f) =>
    ((f.required_signers || []).length > (best.required_signers || []).length ? f : best), head);
  return {
    ...head,
    name: named.name,
    code: named.code,
    parent_code: named.parent_code || '',
    doc_no: named.doc_no || '',
    brokerage: named.brokerage || head.brokerage || '',
    required_signers: signed.required_signers,
    present_signers: signed.present_signers,
    signature_lines: signed.signature_lines,
    signerAmbiguity: signed.signerAmbiguity,
    pages: all,
    outOfSequence: `pages ${all.join(', ')} - ${why}`,
    review: `delivered out of sequence: ${why}`,
  };
}

/** True when a form's pages do not run consecutively. */
function isSplitAcrossPacket(pages) {
  for (let i = 1; i < pages.length; i++) if (pages[i] !== pages[i - 1] + 1) return true;
  return false;
}

/**
 * Join pieces that print the identical document name in their footer.
 *
 * Pages 18, 42 and 43 all carry "Brokerage Matters/Affiliated Business
 * Disclosure/So Cal 010926.docx", and they were the only pages in that packet
 * carrying both that footer AND no DocuSign envelope banner - attached outside
 * the signing.
 *
 * THE GUARD IS ESSENTIAL: that string is the source WORD TEMPLATE path, not a
 * fingerprint of one filled-in document. Every affiliated business disclosure
 * Anywhere generates prints it, across Sotheby's, Coldwell Banker, Corcoran and
 * Century 21, so on its own it would fuse two genuinely separate disclosures.
 * Exactly ONE piece may carry a title: two titled pages means two documents,
 * and the group is left alone.
 */
function joinByFooterTemplate(forms) {
  const groups = new Map();
  for (const f of forms) {
    if (f.code) continue;                        // a C.A.R. form is contiguous
    const key = footerDocName((f.strip || {}).footerName);
    if (!key) continue;
    (groups.get(key) || groups.set(key, []).get(key)).push(f);
  }
  const fused = new Map();
  for (const [key, pieces] of groups) {
    if (pieces.length < 2) continue;
    const titled = pieces.filter((f) => (f.strip || {}).title);
    if (titled.length !== 1) continue;           // two titles = two documents
    const pages = pieces.flatMap((f) => f.pages).sort((a, b) => a - b);
    if (!isSplitAcrossPacket(pages)) continue;   // already contiguous, nothing to do
    fused.set(key, fuse(pieces, `they print the same document name in the footer, "${((pieces[0].strip || {}).footerName || '').trim()}"`));
  }
  if (!fused.size) return forms;
  const consumed = new Set();
  for (const [key, joined] of fused) for (const p of joined.pages) consumed.add(`${key}:${p}`);
  const out = [];
  const emitted = new Set();
  for (const f of forms) {
    const key = f.code ? '' : footerDocName((f.strip || {}).footerName);
    if (key && fused.has(key)) {
      if (!emitted.has(key)) { out.push(fused.get(key)); emitted.add(key); }
      continue;
    }
    out.push(f);
  }
  return out;
}

/**
 * Join a bare acknowledgement page to the titled document that needs one.
 *
 * Pages 17 and 27 share no footer key at all - what pairs them is that each is
 * defective in a way the other explains. Page 17 is a titled affiliated
 * business disclosure with NO signature lines anywhere on it; page 27 is an
 * untitled page that is NOTHING BUT an acknowledgement and four signature
 * lines; both are Christie's-branded. A disclosure nobody can sign and a
 * signature page belonging to nothing are the same defect seen from two ends.
 *
 * `signature_lines` is what makes this checkable rather than a hunch: "has no
 * signature lines of its own" is now a fact the audit reports.
 *
 * GATED HARD, because it is inference rather than a printed key: exactly one
 * orphan and exactly one candidate parent, of the same brokerage, with the
 * orphan AFTER the parent. Anything ambiguous is left as it was, which files
 * the orphan to Unsorted with its reason - the honest outcome for a page
 * nobody can place.
 */
function joinOrphanAcknowledgement(forms) {
  const firm = (f) => String(f.brokerage || (f.strip || {}).brand || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const lines = (f) => (Array.isArray(f.signature_lines) ? f.signature_lines : []);

  const orphans = forms.filter((f) => !f.code && !f.name && !(f.strip || {}).title && lines(f).length > 0);
  if (orphans.length !== 1) return forms;
  const orphan = orphans[0];
  if (!firm(orphan)) return forms;

  const parents = forms.filter((f) => f !== orphan && !f.code && (f.strip || {}).title
    && lines(f).length === 0 && firm(f) === firm(orphan)
    && f.pages[f.pages.length - 1] < orphan.pages[0]);
  if (parents.length !== 1) return forms;

  const joined = fuse([parents[0], orphan],
    'a page of signatures with no document of its own follows a document of the same brokerage with no signature lines of its own');
  return forms.map((f) => (f === parents[0] ? joined : f)).filter((f) => f !== orphan);
}

/**
 * ONE FORM FILED AS TWO FILES IS THE WORST OUTPUT THIS PIPELINE HAS.
 *
 * The audit sees one block at a time, so it can say "there are two documents
 * in this block" and can never say "this block and the next one are halves of
 * the same form". That blind spot is structural, and 834 Victoria Ln walked
 * straight into it: the DIA filed as `DIA - ... - FX.pdf` (pages 1,2) and
 * `DIA - ... - FX (2).pdf` (page 3), and the SBSA as a 1-page NeedReview plus
 * a 14-page FX. Downstream the compliance reconcile then matched the WRONG
 * half and reported the other as a document nothing on the list asked for -
 * so a split form is worse than a missing one, because it reads as two
 * separate problems.
 *
 * The boundary rules now prevent it upstream. This is a second, independent
 * net, and it is pure arithmetic: two ADJACENT forms are rejoined only when
 * they agree on identity AND the first one's own printed length exactly
 * accounts for both. Deliberately strict, because the same code twice in a
 * packet is normal - two counter offers, two AVIDs, two ABAs - and merging
 * those would be the mirror-image mistake.
 */
function rejoinSplitForms(forms) {
  const out = [];
  for (const form of forms) {
    const prev = out[out.length - 1];
    if (prev && sameForm(prev, form) && adjacent(prev, form)) {
      const declared = (prev.strip && prev.strip.declaredLength) || 0;
      const combined = prev.pages.length + form.pages.length;
      if (declared && declared === combined) {
        console.log(`[document-audit] rejoined ${prev.code || prev.name} pages `
          + `${prev.pages[0]}-${form.pages[form.pages.length - 1]}: it declared ${declared} pages `
          + 'and was filed as two');
        prev.pages = [...prev.pages, ...form.pages];
        // The fuller audit wins. A form cut in two leaves one half missing the
        // signature block, and on 834 Victoria Ln that half was the one
        // stamped NeedReview - so taking the half that could actually see the
        // signatures is what makes the rejoined status right.
        if ((form.required_signers || []).length > (prev.required_signers || []).length) {
          prev.required_signers = form.required_signers;
          prev.present_signers = form.present_signers;
        }
        if (!prev.revision && form.revision) prev.revision = form.revision;
        prev.review = `rejoined from two pieces: it declared ${declared} pages`;
        continue;
      }
    }
    out.push(form);
  }
  return out;
}

/** Same identity: the same code, or failing that the same name, and the same number. */
function sameForm(a, b) {
  const num = (f) => String(f.doc_no || '').trim();
  if (num(a) !== num(b)) return false;      // Counter Offer No.1 vs No.2
  const code = (f) => String(f.code || '').trim().toUpperCase();
  if (code(a) && code(b)) return code(a) === code(b);
  const name = (f) => String(f.name || '').trim().toLowerCase();
  return !!name(a) && name(a) === name(b);
}

/** Do these two spans touch, in order? */
function adjacent(a, b) {
  return a.pages[a.pages.length - 1] + 1 === b.pages[0];
}

module.exports = {
  auditDocuments, groupForAudit,
  AUDIT_DOCS_PER_CALL, AUDIT_PAGES_PER_CALL, AUDIT_CONCURRENCY,
};
module.exports._internal = { hintFor, packetContext, applySplit, tallyBrands, brandKey, auditGroup, rejoinSplitForms, sameForm, resolveSigners, tokensForLabel, rejoinOutOfSequence, joinByFooterTemplate, joinOrphanAcknowledgement, RULES, SHAPE };
