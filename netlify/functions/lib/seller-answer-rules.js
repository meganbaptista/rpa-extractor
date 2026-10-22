// netlify/functions/lib/seller-answer-rules.js
//
// HARD CONSISTENCY RULES ON THE SELLER'S PROCESS STREET ANSWERS (listing side).
//
// Megan, 2026-10-22: "we aren't flagging the same, which we should be because
// TCs now are flagging my disclosures as incorrect." 1131 Alta Loma Rd #415, a
// condo: the seller answered TDS C2 and SPQ 15D (features shared with
// neighbors, such as walls) No, the listing review asked only about SPQ 7A, and
// the buyer's TC (Matthew Bauer, 2026-10-19) sent both back: "should be YES
// since the property is a condo that shares walls with neighboring units". The
// questionnaire even prints a red reminder above C2; the seller missed it.
//
// The listing review (disclosure-review-background.js) judged only whether
// explanations were VAGUE, so it never compared answers with each other. These
// rules bring over the buyer-side intake audit's consistency checks. Process
// Street hands us structured answers with codes, so they are CODE, not prompt:
// they fire every time, like the fire-zone/17G check.
//   1. sharedWalls      a unit-numbered address with TDS C2 or SPQ 15D = No
//   2. hoaConsistency   anything says HOA, but an HOA item is No
//                       (buyer audit rule (d); 14E, 14F(1), 14F(2) can be No)
//   3. yesNoExplanation a Yes whose OWN explanation field is empty
//                       (buyer audit rule (b) and its exceptions)
//   4. explainedButNo   an explanation written for a question answered No
//                       (buyer audit rule (c))
//
// THE WORKFLOW HOLDS SEVERAL FORMS (TDS, SPQ, SOLAR, ESD, VLQ, commercial), so
// a code like "C2" or "14C" appears on more than one of them. A question is
// found by its code AND its wording, and an explanation is paired with the
// question by POSITION in the form (the explanation field follows its
// question), never by code alone.
//
// Input: `ordered`, the form's fields in form order with their answers:
//   [{ id, label, value }]   value '' when unanswered
// Each rule returns a mandate for the review (see disclosure-review-background)
// or null.

const { hasUnitDesignator } = require('./property-type');

const RX_CODE = /^\s*([A-Z]\d{1,2}|\d{1,2}[A-Z])(\(\d\))?\s*:\s*/i;
const RX_EXPLAIN = /please (?:explain|describe|list|share|provide)|explain your|explanation/i;

function codeOf(label) {
  const m = String(label || '').match(RX_CODE);
  return m ? (m[1] + (m[2] || '')).toUpperCase() : '';
}
function textOf(label) { return String(label || '').replace(RX_CODE, '').trim(); }
function yesNo(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (/^yes\b/.test(s)) return 'yes';
  if (/^no\b/.test(s)) return 'no';
  return '';
}
const isExplainLabel = (label) => RX_EXPLAIN.test(textOf(label));
// An explanation field can hold a Process Street VARIABLE that copies another
// question's answer (SPQ 15E copies TDS C3's description). When the source is
// blank the raw token shows, e.g. "‹C3: Please describe here:›": form text, not
// the seller's words.
const isEmptyExplanation = (v) => {
  const t = String(v || '').replace(/‹[^›]*›/g, '').trim();
  return !t || /^(n\/?a|none|no|-+|\.)$/i.test(t);
};
// "TDS C2" for a letter-number code, "SPQ 15D" for number-letter (the scheme the
// review prompt uses), with the question so the seller can find it either way.
const locatorOf = (code) => (/^[A-Z]\d/.test(code) ? `TDS ${code}` : `SPQ ${code}`);
const locator = (code) => (/^[A-Z]\d/.test(code) ? `TDS ${code}` : `SPQ ${code}`);
const short = (s, n = 90) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 3).trim()}...` : t; };

/** Questions (not explanations) in form order, each with its explanation field(s). */
function questions(ordered) {
  const out = [];
  for (const f of ordered || []) {
    const code = codeOf(f.label);
    if (!code) { if (out.length) out[out.length - 1].closed = true; continue; }
    const last = out[out.length - 1];
    if (isExplainLabel(f.label) && last && !last.closed && last.code === code) { last.explains.push(f); continue; }
    if (last) last.closed = true;
    out.push({ code, label: f.label, text: textOf(f.label), value: f.value, answer: yesNo(f.value), explains: [] });
  }
  return out;
}

/** The answered question with this code whose wording matches `rx`. */
function find(qs, code, rx) {
  return qs.find((q) => q.code === code && q.answer && (!rx || rx.test(q.text))) || null;
}

// ---------------------------------------------------------------------------

function sharedWalls(qs, address) {
  if (!hasUnitDesignator(address)) return null;
  const c2 = find(qs, 'C2', /features in common|walls, fences/i);
  const d15 = find(qs, '15D', /shared in common|walls, fences/i);
  const no = [c2 && c2.answer === 'no' ? 'TDS C2' : '', d15 && d15.answer === 'no' ? 'SPQ 15D' : ''].filter(Boolean);
  if (!no.length) return null;
  const both = no.length === 2;
  return {
    rule: 'sharedWalls',
    topic: 'Shared walls',
    section: no.join('; '),
    sectionRx: /\bC\s*2\b|15\s*D/i,
    emailHeading: `Shared walls (${no.join(', ')})`,
    seller_wrote: 'No',
    why: 'The property is a unit in a building that shares walls with neighboring units, so a "No" reads as incorrect and the buyer\'s side will send it back.',
    ask: `I noticed you answered "No" to the property sharing features in common with adjoining owners, such as walls, fences and driveways${both ? ' (on both the Transfer Disclosure Statement and the Seller Property Questionnaire)' : ''}. Since the unit shares walls with the neighboring units, this would typically be a "Yes". Could we update ${both ? 'these' : 'this'} to "Yes" and note the shared walls?`,
    keyword: /shar\w* (?:features|walls)|walls, fences/i,
  };
}

// The same question on both forms. Process Street itself copies the TDS
// explanation into the SPQ one for these pairs, so the two answers must agree.
// 11545 Dona Cecilia (2026-10): C2 Yes "Fences", 15D No with the copied "Fences".
const MIRROR_PAIRS = [
  ['C2', /features in common|walls, fences/i, '15D', /shared in common|walls, fences/i, 'features shared with neighbors, such as walls, fences and driveways'],
  ['C3', /encroachments|easements/i, '15E', /encroachments|easements/i, 'encroachments, easements or boundary matters'],
];
function mirrorMismatch(qs) {
  const hits = [];
  for (const [a, rxA, b, rxB, about] of MIRROR_PAIRS) {
    const qa = find(qs, a, rxA); const qb = find(qs, b, rxB);
    if (qa && qb && qa.answer !== qb.answer) hits.push({ a, b, about, ansA: qa.answer, ansB: qb.answer });
  }
  if (!hits.length) return null;
  const cap = (x) => x[0].toUpperCase() + x.slice(1);
  return {
    rule: 'mirrorMismatch',
    topic: 'Answers that differ between the two forms',
    section: hits.map((h) => `TDS ${h.a}; SPQ ${h.b}`).join('; '),
    sectionRx: new RegExp(hits.map((h) => `\\b${h.a}\\b|${h.b.replace(/(\d+)([A-Z])/, '$1\\s*$2')}`).join('|'), 'i'),
    emailHeading: `Answers that differ between the two forms (${hits.map((h) => `TDS ${h.a}, SPQ ${h.b}`).join('; ')})`,
    seller_wrote: hits.map((h) => `TDS ${h.a} ${cap(h.ansA)}, SPQ ${h.b} ${cap(h.ansB)}`).join('; '),
    why: 'The Transfer Disclosure Statement and the Seller Property Questionnaire ask the same question here, and different answers are sent back by the buyer\'s side.',
    ask: hits.map((h) => `The Transfer Disclosure Statement (${h.a}) and the Seller Property Questionnaire (${h.b}) both ask about ${h.about}, and they are answered "${cap(h.ansA)}" and "${cap(h.ansB)}". Which answer is correct, so we can make them match?`).join(' '),
    keyword: /differ between the two forms|make them match/i,
  };
}

const HOA_ITEMS = [
  ['6G', /condominium|planned unit|common interest/i],
  ['14A', /condominium|planned unit|common interest/i],
  ['14B', /homeowner|association|hoa/i],
  ['14C', /common area/i],
  ['14D', /cc&r|deed restriction/i],
  ['14F', /cc&r|committee/i],
  ['C12', /cc&r|deed restriction/i],
  ['C13', /homeowner|association|hoa/i],
  ['C14', /common area/i],
];
function hoaConsistency(qs, fields) {
  const hoaField = (fields || []).find((f) => /property within an hoa|hoa\?/i.test(f.label || '') && !codeOf(f.label));
  const items = HOA_ITEMS.map(([code, rx]) => ({ code, q: find(qs, code, rx) })).filter((x) => x.q);
  const signals = [hoaField && yesNo(hoaField.value) === 'yes' ? 'the property information says it is in an HOA' : '']
    .concat(items.filter((x) => ['6G', '14A', '14B', '14C', 'C13'].includes(x.code) && x.q.answer === 'yes').map((x) => `${locator(x.code)} is Yes`))
    .filter(Boolean);
  if (!signals.length) return null;
  const no = items.filter((x) => x.q.answer === 'no');
  if (!no.length) return null;
  const list = no.map((x) => locator(x.code));
  return {
    rule: 'hoaConsistency',
    topic: 'HOA questions',
    section: list.join('; '),
    sectionRx: new RegExp(no.map((x) => x.code.replace(/(\d+)([A-Z])/, '$1\\s*$2')).join('|'), 'i'),
    emailHeading: `HOA questions (${list.join(', ')})`,
    seller_wrote: 'No',
    why: `The property is in an HOA (${signals[0]}), so these HOA questions should be "Yes"; a "No" contradicts the rest of the disclosures.`,
    ask: `Since the property is part of an HOA, ${no.length === 1 ? 'this question' : 'these questions'} would typically be answered "Yes": ${no.map((x) => `${locator(x.code)} (${short(x.q.text, 70)})`).join('; ')}. Could we update ${no.length === 1 ? 'it' : 'them'} to "Yes"? For the explanation you can write "Buyer to review HOA documents in escrow."`,
    keyword: /HOA questions|part of an HOA/i,
  };
}

// The buyer audit's exceptions: these ask whether a feature EXISTS or WORKS
// (13B sprinklers, 13C pool heater, 13D spa heater, "is it operational?"), and
// 7E (built before 1978) needs a word only when 7E(1)/(2) are Yes.
const NO_EXPLANATION_NEEDED = /^(13B|13C|13D|7E)$/;
function yesNoExplanation(qs) {
  const missing = qs.filter((q) => q.answer === 'yes' && q.explains.length && !NO_EXPLANATION_NEEDED.test(q.code)
    && !/operational/i.test(q.text) && q.explains.every((e) => isEmptyExplanation(e.value)));
  if (!missing.length) return null;
  const list = missing.map((q) => locator(q.code));
  return {
    rule: 'yesNoExplanation',
    topic: 'Yes answers without an explanation',
    section: list.join('; '),
    sectionRx: new RegExp(`(${missing.map((q) => q.code.replace(/(\d+)([A-Z])/, '$1\\s*$2')).join('|')})\\b`, 'i'),
    emailHeading: 'A few "Yes" answers need a short explanation',
    seller_wrote: 'Yes (no explanation)',
    why: 'Every "Yes" needs its own explanation; the buyer\'s side sends back a Yes with a blank explanation.',
    ask: `You answered "Yes" to ${missing.length === 1 ? 'this question' : 'these questions'} but the explanation was left blank: ${missing.map((q) => `${locator(q.code)} (${short(q.text, 70)})`).join('; ')}. Could you add a short explanation for ${missing.length === 1 ? 'it' : 'each'}?`,
    keyword: /need a short explanation|explanation was left blank/i,
  };
}

function explainedButNo(qs) {
  const odd = qs.filter((q) => q.answer === 'no' && q.explains.some((e) => !isEmptyExplanation(e.value)));
  if (!odd.length) return null;
  const list = odd.map((q) => locator(q.code));
  return {
    rule: 'explainedButNo',
    topic: 'Explanation written for a "No" answer',
    section: list.join('; '),
    sectionRx: new RegExp(`(${odd.map((q) => q.code.replace(/(\d+)([A-Z])/, '$1\\s*$2')).join('|')})\\b`, 'i'),
    emailHeading: 'Answers that may need to be "Yes"',
    seller_wrote: 'No (with an explanation)',
    why: 'A seller writes an explanation only when the answer is Yes, so a No with an explanation reads as a mismarked box.',
    ask: `You answered "No" but wrote an explanation for ${odd.length === 1 ? 'this question' : 'these questions'}: ${odd.map((q) => `${locator(q.code)} (${short(q.text, 60)}): "${short(q.explains.map((e) => e.value).filter((v) => !isEmptyExplanation(v)).join(' '), 60)}"`).join('; ')}. Should ${odd.length === 1 ? 'it' : 'these'} be "Yes"?`,
    keyword: /may need to be "Yes"|but wrote an explanation/i,
  };
}

/**
 * Every rule that fires, as review mandates.
 *   ordered:  the form's fields in order with answers (explanations included)
 *   fields:   all answered fields (property information included), for the HOA flag
 *   address:  the property address
 */
function sellerAnswerMandates({ ordered, fields, address, prior = [] }) {
  const qs = questions(ordered);
  const first = [sharedWalls(qs, address), hoaConsistency(qs, fields)].filter(Boolean);
  // Shared walls already asks about C2/15D on a condo; otherwise a C2/15D
  // disagreement is its own question.
  const mirror = mirrorMismatch(qs.filter((q) => !first.some((m) => m.sectionRx.test(locatorOf(q.code)))));
  if (mirror) first.push(mirror);
  // A question a specific rule (or an existing mandate such as the fire-zone
  // 17G check, passed in `prior`) already asks about is not asked again under
  // the general rules.
  const covered = (q) => [...prior, ...first].some((m) => (m.sectionRx || /(?!)/).test(locatorOf(q.code)));
  const rest = qs.filter((q) => !covered(q));
  return [...first, yesNoExplanation(rest), explainedButNo(rest)].filter(Boolean);
}

module.exports = { sellerAnswerMandates, questions, codeOf, yesNo, sharedWalls, hoaConsistency, mirrorMismatch, yesNoExplanation, explainedButNo };
