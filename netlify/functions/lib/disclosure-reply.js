// netlify/functions/lib/disclosure-reply.js
//
// ============================================================================
// THE REPLY TO THE TC WHO SENT THE PACKAGE.
// ============================================================================
// Megan's original problem, and the reason this pipeline exists: "My employee
// is leaving emails from 5-days ago just unanswered so we need to automate
// it." The unanswered email is another coordinator sending disclosures back.
// What it is owed is an acknowledgement and a status.
//
// THE BODY IS HER COMPLIANCE CHECKLIST, NOT PROSE ABOUT IT. Two earlier
// attempts got this wrong. The first asked the other side for what they owed -
// which on both real deliveries was nothing, because everything outstanding
// was ours. The second recited what had arrived, which is a manifest of things
// the recipient already sent. Megan's answer: "what if we illustrate more of
// the google docs checklist... After my audit, here is where the file stands
// on my end", followed by the list itself.
//
// That is right for three reasons worth keeping:
//   IT IS HER VOCABULARY. "BA AVID - NeedSS+LA", "VP - once completed",
//     "Property Inspections or BIW" - the other coordinator reads the same
//     shorthand every day. Prose generated about those lines is a translation
//     nobody asked for.
//   IT IS ONE SOURCE OF TRUTH. The email and the Doc say the same thing
//     because they ARE the same thing: the lines the reconcile left standing.
//   IT IS A STATUS, NOT A DEMAND. "Where the file stands on my end" covers
//     items we owe and items they owe without having to attribute either -
//     which is what made the earlier versions so awkward.
//
// Pure: takes the reconcile's leftover lines and returns subject and body. No
// Gmail, no network, so the wording is reviewable without sending anything.
// ============================================================================

const OURS = new Set(['NeedSS', 'NeedLA']);
/**
 * A broker signature carries NO SIDE. The audit's BR token means "the broker
 * or office manager, in that capacity", and either brokerage can be the one
 * owing it - so it is asked about rather than assigned, on the same principle
 * as an unattributable signature line.
 */
const SIDELESS = new Set(['NeedBroker(s)']);

/** Who has to act on this status, from the audit's own vocabulary. */
function owedBy(status) {
  const s = String(status || '').trim();
  if (!s || s === 'FX') return 'done';
  if (s === 'NeedReview') return 'unclear';
  if (s.split('+').some((p, i) => SIDELESS.has(i === 0 ? p : `Need${p}`))) return 'unclear';
  // "NeedSS+LA" - every missing party is ours, so the item is ours.
  const parties = s.split('+').map((p, i) => (i === 0 ? p : `Need${p}`));
  const mine = parties.filter((p) => OURS.has(p)).length;
  if (mine === parties.length) return 'us';
  if (mine === 0) return 'them';
  return 'both';
}

/** "NeedSS+LA" -> "the seller and the listing agent". */
const PARTY_WORDS = {
  NEEDB: 'the buyer', NeedSS: 'the seller', NeedBA: "the buyer's agent",
  NeedLA: 'the listing agent', 'NeedBroker(s)': 'the broker',
};
/** The distinct parties a status names, e.g. "NeedSS+LA" -> ["the seller", "the listing agent"]. */
function partyWords(status) {
  return [...new Set(String(status || '').split('+')
    .map((x, i) => (i === 0 ? x : `Need${x}`))
    .map((x) => PARTY_WORDS[Object.keys(PARTY_WORDS).find((k) => k.toLowerCase() === x.toLowerCase())] || '')
    .filter(Boolean))];
}

function missingWords(status) {
  const parts = String(status || '').split('+')
    .map((p, i) => (i === 0 ? p : `Need${p}`))
    .map((p) => PARTY_WORDS[p] || PARTY_WORDS[Object.keys(PARTY_WORDS).find((k) => k.toLowerCase() === p.toLowerCase())] || '')
    .filter(Boolean);
  if (!parts.length) return 'a signature';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The document's name as a coordinator would write it, without the status. */
function docName(form) {
  const code = String(form.code || '').trim();
  const name = String(form.name || '').trim();
  if (code && name) return `${code} (${name})`;
  return code || name || 'an unnamed document';
}

/**
 * Group the delivery into the four things a reply has to say.
 *
 * `unclear` is deliberately separate from `us` and `them`: asserting who owes
 * a signature we could not attribute is how a coordinator gets sent to chase
 * the wrong side, so those are ASKED about instead.
 */
function groupForReply(forms) {
  const out = { done: [], us: [], them: [], unclear: [], both: [] };
  for (const f of forms || []) {
    const bucket = owedBy(f.status);
    (out[bucket] || out.unclear).push(f);
  }
  return out;
}

function esc(t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The reply, as subject + HTML body.
 *
 * HTML, with real apostrophes, because a plain-text body with tags in it is
 * what Gmail renders literally - a lesson already paid for elsewhere in this
 * codebase.
 */
/**
 * The reply, as subject + HTML body.
 *
 * `outstanding` is the reconcile's own output: every line it did NOT strike,
 * in Doc order, already carrying its status where one is known (a line the
 * reconcile would annotate arrives as "BA AVID - NeedSS"). Passed through
 * VERBATIM - reformatting her list is how it stops being her list.
 *
 * HTML with real apostrophes, because a plain-text body with tags in it is
 * what Gmail renders literally.
 */
function buildReply({ address, outstanding = [], senderName = '',
                      unsortedPages = [], outOfSequence = [] }) {
  const first = String(senderName || '').trim().split(/\s+/)[0];
  const lines = outstanding.map((o) => String(typeof o === 'string' ? o : (o && o.text) || '').trim())
    .filter(Boolean);
  const p = [];

  p.push(`<p>Hi${first ? ` ${esc(first)}` : ''},</p>`);

  if (!lines.length) {
    p.push(`<p>Thanks so much for these! After my audit, everything on my checklist for `
      + `${esc(address)} is accounted for - nothing outstanding on my end.</p>`);
    p.push('<p>Let me know if you need anything from us.</p>');
    return { subject: `${address} - disclosures received`, htmlBody: p.join('\n'), asks: 0 };
  }

  p.push('<p>Thanks so much for these! After my audit, here is where the file stands on my end:</p>');
  // A plain list in her own wording. No bullets-with-commentary, no regrouping
  // by who owes what: the list IS the message.
  p.push('<ul>');
  for (const l of lines) p.push(`<li>${esc(l)}</li>`);
  p.push('</ul>');

  if (unsortedPages.length) {
    const one = unsortedPages.length === 1;
    p.push(`<p>Also, ${one ? 'page' : 'pages'} ${unsortedPages.join(', ')} in the package I could not `
      + `identify - could you let me know what ${one ? 'that is' : 'those are'}?</p>`);
  }

  if (outOfSequence.length) {
    const one = outOfSequence.length === 1;
    p.push(`<p>One note for next time: ${one ? 'a document' : `${outOfSequence.length} documents`} in the `
      + `package had ${one ? 'its' : 'their'} pages split up rather than running together, which is easy `
      + `to miss. No action needed, I have put ${one ? 'it' : 'them'} back together on our side.</p>`);
  }

  p.push('<p>Let me know if any of those are already on their way, or if you need anything from us.</p>');

  return {
    subject: `${address} - disclosures received`,
    htmlBody: p.join('\n'),
    /** How many checklist lines are still open. 0 means the file is clear. */
    asks: lines.length,
  };
}

module.exports = { buildReply, groupForReply, owedBy, missingWords, partyWords, docName };
