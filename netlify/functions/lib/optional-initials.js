// netlify/functions/lib/optional-initials.js
//
// LIQUIDATED DAMAGES (RPA paragraph 29) AND ARBITRATION OF DISPUTES
// (paragraph 31): ALL OR NONE. Each is an optional election - nobody has to
// initial it - but once ANY party initials one, every party must, or the
// paragraph is one-sided. Neither side initialing is fine; everyone
// initialing is fine; anything in between is flagged as missing initials so
// the team gets it initialed (or the stray initials struck).
//
// Why (3131 Michelson Dr #406, 2026-11-21): the seller initialed paragraph 31
// and both buyer boxes were blank. One audit flagged it; a second audit of
// the same contract read the same blanks ("Buyer boxes empty, Seller MEM")
// and excused them: "Buyer declining to initial arbitration is a valid
// election ... (and per SCO paragraph 1A). Not a defect." True of the law -
// the un-initialed paragraph simply drops out - but Megan flags the mismatch
// (her file code "NB - Arbitration"), so the model's judgment is not trusted
// here: it transcribes the boxes, this code judges them.
//
// Input: structured.transcription.rpa.optional_initials, the model's literal
// copy of each box:
//   { liquidated_damages: { buyer: ["FF", "FF"], seller: ["MEM"] },
//     arbitration:        { buyer: ["BLANK", "BLANK"], seller: ["MEM"] } }
// Only the first <party count> boxes of a side are judged, so a second box
// left empty on a one-buyer deal is never a finding.

'use strict';

const BLANK = /^\s*(blank|empty|none|n\/?a|-+|_+|\[\s*\])?\s*$/i;
const isBlank = (v) => v == null || BLANK.test(String(v));

const CLAUSES = [
  { key: 'liquidated_damages', para: 29, name: 'Liquidated Damages', match: /liquidated|\b(para(graph)?|¶|§)\s*29\b/i },
  { key: 'arbitration', para: 31, name: 'Arbitration of Disputes', match: /arbitrat|\b(para(graph)?|¶|§)\s*31\b/i },
];

function boxes(side, count) {
  const list = Array.isArray(side) ? side : side == null ? [] : [side];
  const n = Math.max(1, Number(count) || 1);
  return list.slice(0, n);
}

/**
 * Judge the transcribed boxes. Returns { findings, actions } in the audit's
 * own shapes; empty when every clause is all-or-none (or not transcribed).
 */
function checkOptionalInitials(transcription, counts = {}) {
  const out = { findings: [], actions: [] };
  const oi = transcription && transcription.rpa && transcription.rpa.optional_initials;
  if (!oi || typeof oi !== 'object') return out;
  for (const c of CLAUSES) {
    const clause = oi[c.key];
    if (!clause || typeof clause !== 'object') continue;
    const buyer = boxes(clause.buyer, counts.buyerCount);
    const seller = boxes(clause.seller, counts.sellerCount);
    const all = [...buyer, ...seller];
    if (!all.length) continue;
    const initialed = all.filter((v) => !isBlank(v));
    if (!initialed.length || initialed.length === all.length) continue;
    const buyerBlank = buyer.some(isBlank) || !buyer.length;
    const sellerBlank = seller.some(isBlank) || !seller.length;
    const who = buyerBlank && sellerBlank ? 'Buyer and Seller' : buyerBlank ? 'Buyer' : 'Seller';
    const show = (side) => (side.length ? side.map((v) => (isBlank(v) ? 'BLANK' : String(v).trim())).join(' / ') : 'BLANK');
    out.findings.push({
      location: `RPA paragraph ${c.para} ${c.name}`,
      issue: `${who} initials missing while another party initialed`,
      severity: 'missing',
      detail: `Buyer ${show(buyer)}, Seller ${show(seller)}: once one party initials ${c.name}, every party must initial it (or the initials are struck), otherwise it is one-sided.`,
    });
    out.actions.push(`${c.name} (RPA paragraph ${c.para}) was initialed by only one side. Please have the ${who.toLowerCase()} initial it, or strike the existing initials so both sides match.`);
  }
  return out;
}

/**
 * Fold the check into a parsed audit, in place. A finding the model already
 * made for the same paragraph is kept as-is (no duplicate); otherwise the
 * code's finding is added and the status becomes "issues_found".
 */
function applyOptionalInitials(auditPart, counts = {}) {
  const structured = auditPart && auditPart.structured;
  if (!structured || typeof structured !== 'object') return { findings: [], actions: [] };
  const result = checkOptionalInitials(structured.transcription, counts);
  if (!result.findings.length) return result;
  const existing = Array.isArray(structured.findings) ? structured.findings : [];
  const added = { findings: [], actions: [] };
  result.findings.forEach((f, i) => {
    const clause = CLAUSES.find((c) => f.location.includes(c.name));
    const dup = existing.some((e) => clause.match.test(`${e.location || ''} ${e.issue || ''}`) && e.severity === 'missing');
    if (dup) return;
    added.findings.push(f);
    added.actions.push(result.actions[i]);
  });
  if (!added.findings.length) return added;
  structured.findings = [...existing, ...added.findings];
  structured.action_items = [...(Array.isArray(structured.action_items) ? structured.action_items : []), ...added.actions];
  structured.overall_status = 'issues_found';
  const lead = added.findings.map((f) => `${f.location}: ${f.issue.charAt(0).toLowerCase()}${f.issue.slice(1)}`).join('; ');
  structured.summary = `${lead}. ${structured.summary || ''}`.trim();
  auditPart.prose = `${auditPart.prose || ''}\n\n## Liquidated damages / arbitration initials check\n\n${added.findings
    .map((f) => `- ${f.location}: ${f.issue}. ${f.detail}`)
    .join('\n')}`;
  return added;
}

module.exports = { checkOptionalInitials, applyOptionalInitials };
