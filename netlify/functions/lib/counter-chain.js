// netlify/functions/lib/counter-chain.js
//
// COUNTER-CHAIN CONSISTENCY: does every counter offer in the packet belong to
// THIS purchase agreement? Plain code over what the audit transcribed - the
// model reads, this compares.
//
// Why this exists (10724 Wilshire Blvd #803, 2026-09-30). The agent sent an
// SMCO #1 written to a DIFFERENT buyer's offer: "The Jonathan Brownleader
// Living Trust", countering a purchase agreement "dated 09/18/2026", while
// this RPA is from Taher Babapour and Masoumeh Taz, prepared 09/19/2026. The
// BCO #1 on top countered an SMCO #1 "dated September 23, 2026" - the right
// SMCO, which was not in the packet at all. The audit transcribed every one of
// those fields (N2), then called the packet "signature-complete": N2 only
// flagged BLANK fields, and nothing compared a counter to the RPA or to the
// document it counters. On the run without the SMCO it even wrote "SMCO #1 is
// not physically in the packet. I'm not flagging that here (out of scope)".
//
// So the judgment moved here, where it cannot be talked out of a mismatch:
//   C1  a counter's Buyer / Seller line is not the RPA's buyer / seller
//   C2  a counter's "dated" is not the date of the document it counters
//       (the RPA's Date Prepared, or the countered counter's own Date)
//   C3  a counter counters another counter that is not in the packet
//   C4  a counter's Property line is not the RPA's property
// Any hit makes the audit "issues_found" (Megan, 2026-09-30).
//
// Tolerant where a real chain varies: word order, middle initials, commas,
// "Trust"/"Trustee"/"Living", "and/or assignee", "St"/"Street". A field the
// model left BLANK is N2's finding already, so it is skipped here rather than
// reported twice.

'use strict';

const BLANK = /^\s*(blank|none|n\/a|—|-)?\s*$/i;
const isBlank = (v) => v == null || BLANK.test(String(v));

// ---------------------------------------------------------------- dates ----

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "09/18/2026", "9/18/26", "September 19, 2026", "Sept 19 2026" -> "2026-09-19". */
function isoDate(value) {
  const s = String(value || '').trim().toLowerCase();
  let m = /(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return iso(y, Number(m[1]), Number(m[2]));
  }
  m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s);
  if (m) {
    const month = MONTHS.findIndex((name) => name.startsWith(m[1].slice(0, 3)));
    if (month >= 0) return iso(Number(m[3]), month + 1, Number(m[2]));
  }
  return null;
}
function iso(y, mo, d) {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** 09/18/2026, for a finding a person reads. */
function printed(isoValue) {
  const [y, m, d] = isoValue.split('-');
  return `${m}/${d}/${y}`;
}

// ---------------------------------------------------------------- names ----

// Words that say what KIND of party, not WHO: never enough to match on.
const FILLER = new Set([
  'the', 'and', 'or', 'of', 'a', 'an', 'as', 'dated', 'dtd', 'u', 'a', 'd',
  'trust', 'trustee', 'trustees', 'living', 'revocable', 'irrevocable', 'family', 'survivors', 'survivor',
  'successor', 'co', 'estate', 'llc', 'l', 'c', 'inc', 'corp', 'corporation', 'company', 'lp', 'llp',
  'partnership', 'holdings', 'properties', 'assignee', 'assigns', 'nominee', 'husband', 'wife', 'married',
  'single', 'man', 'woman', 'joint', 'tenants', 'community', 'property', 'mr', 'mrs', 'ms', 'dr', 'jr', 'sr',
  'ii', 'iii', 'iv', 'et', 'al', 'agreement', 'declaration', 'administrator', 'executor', 'executrix',
  'manager', 'member', 'managing', 'separate', 'sole', 'owner',
]);

/** The words that identify a party: names, not "Living Trust", not initials, not dates. */
function nameTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // "(2/8/2000)"
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/[\s'-]+/)
    .filter((w) => w.length >= 2 && !FILLER.has(w));
}

/**
 * THE SAME PARTY: at least one identifying name in common. "Robert S. Lee
 * Living Trust" and "Robert S Lee, Trustee" share "robert" and "lee";
 * "The Jonathan Brownleader Living Trust" and "Taher Babapour, Masoumeh Taz"
 * share nothing. Deliberately loose - a counter naming one of two buyers, or
 * the trust instead of the trustee, still passes; only a stranger fails.
 */
function sameParty(a, b) {
  const left = new Set(nameTokens(a));
  if (!left.size) return true; // nothing to compare on: not this check's call
  return nameTokens(b).some((w) => left.has(w));
}

// ------------------------------------------------------------- property ----

const STREET_WORDS = {
  street: 'st', st: 'st', avenue: 'ave', ave: 'ave', boulevard: 'blvd', blvd: 'blvd', drive: 'dr', dr: 'dr',
  road: 'rd', rd: 'rd', lane: 'ln', ln: 'ln', place: 'pl', pl: 'pl', court: 'ct', ct: 'ct', way: 'way',
  circle: 'cir', cir: 'cir', terrace: 'ter', ter: 'ter', north: 'n', n: 'n', south: 's', s: 's', east: 'e',
  e: 'e', west: 'w', w: 'w', unit: '', apt: '', suite: '', ste: '', no: '',
};

/** The street number and street name, which is what makes it this property. */
function propertyKey(value) {
  const words = String(value || '')
    .toLowerCase()
    .split(',')[0] // the street line; city/state/zip vary in how they are written
    .replace(/#/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w in STREET_WORDS ? STREET_WORDS[w] : w))
    .filter(Boolean);
  const number = words.find((w) => /^\d+$/.test(w));
  const name = words.find((w) => /^[a-z]{3,}$/.test(w) && !['st', 'ave', 'blvd', 'way'].includes(w));
  return number && name ? `${number} ${name}` : null;
}

// --------------------------------------------------------------- forms -----

/** "SMCO", "Seller Multiple Counter Offer No. 1" -> { form: 'SMCO', number: '1' }. */
function counterRef(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim() || /purchase agreement|\brpa\b|original offer|the offer/.test(s)) return { form: 'RPA' };
  const form = /multiple|smco/.test(s) ? 'SMCO' : /seller|sco/.test(s) ? 'SCO' : /buyer|bco/.test(s) ? 'BCO' : null;
  const number = (/(?:no\.?|#|number)\s*(\d+)/.exec(s) || /\b(\d+)\b/.exec(s) || [])[1] || null;
  return form ? { form, number } : { form: 'OTHER', text };
}

function formOf(counter) {
  const f = String(counter.form || '').toUpperCase();
  if (/SMCO|MULTIPLE/.test(f)) return 'SMCO';
  if (/BCO|BUYER/.test(f)) return 'BCO';
  if (/SCO|SELLER/.test(f)) return 'SCO';
  return f || 'COUNTER';
}

const label = (c) => `${formOf(c)} #${c.number || '?'}`;

// ---------------------------------------------------------------- check ----

/**
 * The findings for one packet, in the audit's own finding shape, plus a
 * send-ready action line for each. `rpa` and `counters` are the model's
 * literal transcription (see the TRANSCRIPTION block in the audit prompt).
 */
function checkCounterChain(transcription) {
  const rpa = (transcription && transcription.rpa) || {};
  const counters = Array.isArray(transcription && transcription.counters) ? transcription.counters : [];
  const findings = [];
  const actions = [];
  const add = (location, issue, detail, action) => {
    findings.push({ location, issue, severity: 'review', detail, check: 'counter_chain' });
    actions.push(action);
  };

  for (const c of counters) {
    const where = `${label(c)} header`;

    // C1 - the parties.
    for (const side of ['buyer', 'seller']) {
      const theirs = c[side];
      const ours = rpa[side];
      if (isBlank(theirs) || isBlank(ours)) continue;
      if (!sameParty(ours, theirs)) {
        const Side = side === 'buyer' ? 'Buyer' : 'Seller';
        add(
          where,
          `${Side} on the counter is not the RPA's ${side}`,
          `${label(c)} names the ${side} as "${theirs}", but the RPA (paragraph 1A) is ${side === 'buyer' ? 'from' : 'with'} "${ours}". This counter may belong to a different offer.`,
          `${label(c)} names a different ${side} ("${theirs}") than the purchase agreement ("${ours}"). Please confirm this is the correct counter offer for this transaction and send the correct one if not.`,
        );
      }
    }

    // C4 - the property.
    if (!isBlank(c.property) && !isBlank(rpa.property)) {
      const a = propertyKey(rpa.property);
      const b = propertyKey(c.property);
      if (a && b && a !== b) {
        add(
          where,
          "Property on the counter is not the RPA's property",
          `${label(c)} is for "${c.property}", but the RPA is for "${rpa.property}".`,
          `${label(c)} is written for a different property ("${c.property}"). Please confirm and send the correct counter offer.`,
        );
      }
    }

    // C2 / C3 - what it counters, and when that was dated.
    const ref = counterRef(c.counters);
    const dated = isoDate(c.dated);
    if (ref.form === 'RPA') {
      const prepared = isoDate(rpa.date_prepared);
      if (dated && prepared && dated !== prepared) {
        add(
          where,
          "\"Dated\" does not match the RPA's Date Prepared",
          `${label(c)} counters a purchase agreement dated ${printed(dated)}, but this RPA was prepared ${printed(prepared)}.`,
          `${label(c)} refers to a purchase agreement dated ${printed(dated)}, but the purchase agreement in this transaction is dated ${printed(prepared)}. Please confirm the counter offer is for this offer.`,
        );
      }
    } else if (ref.form === 'SCO' || ref.form === 'SMCO' || ref.form === 'BCO') {
      const target = counters.find((o) => o !== c && formOf(o) === ref.form && (!ref.number || String(o.number) === String(ref.number)));
      const name = `${ref.form} #${ref.number || '?'}`;
      if (!target) {
        add(
          where,
          `Counters ${name}, which is not in the packet`,
          `${label(c)} is a counter to ${name}${dated ? ` dated ${printed(dated)}` : ''}, but no ${name} is in this packet.`,
          `${label(c)} responds to ${name}${dated ? ` dated ${printed(dated)}` : ''}, which we have not received. Please send a copy of ${name}.`,
        );
      } else {
        const targetDate = isoDate(target.date);
        if (dated && targetDate && dated !== targetDate) {
          add(
            where,
            `"Dated" does not match ${name}'s date`,
            `${label(c)} counters ${name} dated ${printed(dated)}, but the ${name} in this packet is dated ${printed(targetDate)}. The ${name} in the packet may be the wrong one, and the correct one may be missing.`,
            `${label(c)} responds to ${name} dated ${printed(dated)}, but the ${name} we received is dated ${printed(targetDate)}. Please send the ${name} dated ${printed(dated)}.`,
          );
        }
      }
    }
  }
  return { findings, actions };
}

/**
 * Fold the chain check into a parsed audit, in place: its findings and action
 * lines go FIRST (they are the most serious), the status becomes
 * "issues_found", and the summary leads with it - a packet with a stranger's
 * counter must not open on "signature-complete". A section is appended to the
 * prose so the full report shows the check ran either way.
 */
function applyCounterChain(auditPart) {
  const structured = auditPart && auditPart.structured;
  if (!structured || typeof structured !== 'object') return { findings: [], actions: [] };
  const transcription = structured.transcription;
  if (!transcription || (!Array.isArray(transcription.counters) || !transcription.counters.length)) {
    return { findings: [], actions: [] };
  }
  const result = checkCounterChain(transcription);
  const lines = result.findings.map((f) => `- ${f.location}: ${f.issue}. ${f.detail}`);
  auditPart.prose = `${auditPart.prose || ''}\n\n## Counter chain check\n\n${
    lines.length ? lines.join('\n') : 'Every counter names this RPA\'s buyer, seller and property, and each "dated" matches the document it counters.'
  }`;
  if (!result.findings.length) return result;

  structured.findings = [...result.findings, ...(Array.isArray(structured.findings) ? structured.findings : [])];
  structured.action_items = [...result.actions, ...(Array.isArray(structured.action_items) ? structured.action_items : [])];
  structured.overall_status = 'issues_found';
  const lead = `Counter chain problem: ${result.findings.map((f) => `${f.location.replace(/ header$/, '')} ${f.issue.charAt(0).toLowerCase()}${f.issue.slice(1)}`).join('; ')}.`;
  structured.summary = structured.summary ? `${lead} ${structured.summary}` : lead;
  return result;
}

module.exports = { checkCounterChain, applyCounterChain, _internal: { isoDate, sameParty, nameTokens, propertyKey, counterRef } };
