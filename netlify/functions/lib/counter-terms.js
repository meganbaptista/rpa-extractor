// netlify/functions/lib/counter-terms.js
//
// COUNTER OFFERS, APPLIED IN CODE. The model COPIES each counter, term by
// term; this works out the final terms. The same split as counter-chain.js
// and contract-dates.js: the model reads, code reasons.
//
// Why (scoreboard, 2026-10-10). The extraction asked the model, in one go,
// for the price "from the LATEST counter offer" and each day count "as
// finally agreed": find every counter, order them, carry each change
// forward, all in its head. On live deals with counters the price was right
// 76% of the time, and the dates rarely.
//
// HOW THE CHAIN WORKS. A C.A.R. counter accepts the offer it answers
// "subject to" the changes it lists, so the final terms are the purchase
// agreement with each counter's changes laid on top, in order: RPA, SCO #1,
// BCO #1, SCO #2 ... The last word on each term wins.
//
// UNSIGNED IS NORMAL, NOT AN ERROR (Megan, 2026-10-10): a transaction is
// usually created from "Contract (NeedS)" or "Contract NeedB" - a packet
// still waiting on a signature, because agents are busy. So the latest
// counter's terms ARE applied, and the unsigned acceptance is reported
// ("SCO #2 is awaiting the buyer's signature") for a person to follow, never
// a reason to stop.
//
// NEVER GUESS SILENTLY. A term the model marked unsure (crossed out,
// handwritten over, unreadable) is still applied when it has a value, and
// always named for review.

'use strict';

/** The transcription tool: copy, never decide. */
const COUNTER_TOOL = {
  name: 'transcribe_counter_offers',
  description:
    'Copy every counter offer in this California purchase agreement packet: Seller Counter Offers (SCO), Buyer Counter Offers (BCO), Seller Multiple Counter Offers (SMCO), Buyer Multiple Counter Offers (BMCO). ' +
    'COPY, DO NOT DECIDE: for each counter, write down only what THAT counter itself says. Do not work out final terms, do not carry anything from one counter to another, do not fill a term the counter does not change. ' +
    'Leave a term empty when the counter does not mention it. One entry per counter document, in the order they appear.',
  input_schema: {
    type: 'object',
    properties: {
      counters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['SCO', 'BCO', 'SMCO', 'BMCO', 'OTHER'], description: 'Which counter form this is, from its title.' },
            number: { type: 'string', description: "The counter's own number ('Counter Offer No. 2' -> '2'). Empty if blank." },
            date: { type: 'string', description: 'The date at the top of the counter, as written.' },
            counters_what: { type: 'string', description: "What this counter answers, as written: 'Purchase Agreement', 'Seller Counter Offer No. 1', 'Buyer Counter Offer No. 1', etc." },
            price: { type: 'string', description: 'The purchase price THIS counter sets, as written (e.g. "$1,315,000"). Empty if it does not change the price.' },
            close_of_escrow: { type: 'string', description: 'Close of escrow as THIS counter sets it, as written: a number of days ("21 days after Acceptance") or a date ("12/15/2026"). Empty if unchanged.' },
            emd_amount: { type: 'string', description: 'Initial deposit amount THIS counter sets, as written. Empty if unchanged.' },
            emd_days: { type: 'string', description: 'Business days for the initial deposit if THIS counter changes them. Empty if unchanged.' },
            inspection: { type: 'string', description: 'Investigation / inspection contingency as THIS counter sets it: the number of days, or "waived"/"removed" if it removes it. Empty if unchanged.' },
            appraisal: { type: 'string', description: 'Appraisal contingency as THIS counter sets it: days, or "waived"/"removed". Empty if unchanged.' },
            loan: { type: 'string', description: 'Loan contingency as THIS counter sets it: days, or "waived"/"removed". Empty if unchanged.' },
            disclosures: { type: 'string', description: 'Days for the seller to deliver disclosures if THIS counter changes them. Empty if unchanged.' },
            other_terms: { type: 'string', description: 'Every other change THIS counter makes, word for word (credits, who pays what, leasebacks, "as-is", attachments). Empty if none.' },
            made_by_signed: { type: 'string', description: 'Date the party MAKING this counter signed it (paragraph 4 on SCO/BCO), as written. Empty if unsigned.' },
            accepted_signed: { type: 'string', description: 'Date the OTHER party signed ACCEPTANCE of this counter (paragraph 5 on SCO/BCO; on an SMCO also the seller\'s final re-signature, paragraph 7). Empty if not signed.' },
            unsure: { type: 'string', description: 'Anything in this counter you could not read with certainty: crossed-out or handwritten-over numbers, illegible values, boxes you cannot tell are checked. Name the term and what you saw. Empty if everything is clear.' },
          },
          required: ['kind', 'number', 'date', 'counters_what', 'price', 'close_of_escrow', 'emd_amount', 'emd_days', 'inspection', 'appraisal', 'loan', 'disclosures', 'other_terms', 'made_by_signed', 'accepted_signed', 'unsure'],
        },
      },
    },
    required: ['counters'],
  },
};

const PROMPT =
  'Call transcribe_counter_offers with every counter offer in this packet (SCO, BCO, SMCO, BMCO). ' +
  'Copy what each counter says, term by term, exactly as written. Do not combine counters and do not work out final terms. ' +
  'If there are no counter offers, return an empty list.';

// ---------------------------------------------------------------- parsing ----

const blank = (v) => v == null || /^\s*(|none|n\/a|blank|unchanged|no change|—|-)\s*$/i.test(String(v));
const WAIVED = /\b(waive[ds]?|remov(e|ed|al)|eliminat|no (loan|appraisal|inspection|investigation)|not contingent|none)\b/i;

function money(v) {
  const m = /\$?\s*([\d,]+(?:\.\d+)?)/.exec(String(v || ''));
  if (!m) return '';
  const n = Math.round(Number(m[1].replace(/,/g, '')));
  return n >= 1000 ? String(n) : '';
}

function days(v) {
  const m = /(\d{1,3})\s*(?:\(|calendar|business|days?\b|$)/i.exec(String(v || '').trim());
  return m ? String(Number(m[1])) : '';
}

function isoDate(v) {
  const s = String(v || '').trim();
  // ISO first: "2026-10-01" also looks like a US date to the pattern below.
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = /([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s);
  if (m && MONTHS.includes(m[1].toLowerCase())) return `${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  return '';
}

const label = (c) => `${c.kind === 'OTHER' ? 'Counter' : c.kind} #${c.number || '?'}`;
const SIDE = { SCO: 'seller', SMCO: 'seller', BCO: 'buyer', BMCO: 'buyer' };
const OTHER_SIDE = { seller: 'buyer', buyer: 'seller' };

/**
 * The chain's order: by the date each was made, then seller before buyer on
 * the same day is NOT assumed - the counter's own number breaks a tie within
 * its kind, and the packet order (the model's list order) breaks the rest.
 */
function ordered(counters) {
  return counters
    .map((c, i) => ({ c, i, d: isoDate(c.date) || isoDate(c.made_by_signed) || '' }))
    .sort((a, b) => (a.d && b.d && a.d !== b.d ? a.d.localeCompare(b.d) : a.c.kind === b.c.kind && a.c.number !== b.c.number ? Number(a.c.number || 0) - Number(b.c.number || 0) : a.i - b.i))
    .map((x) => x.c);
}

/**
 * THE FINAL TERMS. `fields` is the extraction (the RPA's own terms are in it);
 * `counters` the transcription. Mutates `fields` and returns what it applied
 * and what a person should look at.
 */
function applyCounterTerms(fields, counters) {
  const applied = [];
  const review = [];
  const list = ordered((counters || []).filter((c) => c && c.kind));
  if (!list.length) return { applied, review };

  const set = (field, value, c, term) => {
    if (value === undefined) return;
    const before = String(fields[field] == null ? '' : fields[field]);
    if (before === value) return;
    fields[field] = value;
    applied.push({ counter: label(c), term, field, from: before, to: value });
  };

  for (const c of list) {
    if (!blank(c.price)) {
      const p = money(c.price);
      if (p) set('final_purchase_price', p, c, 'price');
      else review.push(`${label(c)} changes the price but it could not be read ("${c.price}")`);
    }
    if (!blank(c.close_of_escrow)) {
      const date = isoDate(c.close_of_escrow);
      const n = days(c.close_of_escrow);
      if (date) {
        set('close_of_escrow_specific_date', date, c, 'close of escrow');
        set('close_of_escrow_days', '', c, 'close of escrow');
      } else if (n) {
        set('close_of_escrow_days', n, c, 'close of escrow');
        set('close_of_escrow_specific_date', '', c, 'close of escrow');
      } else review.push(`${label(c)} changes close of escrow but it could not be read ("${c.close_of_escrow}")`);
    }
    if (!blank(c.emd_amount)) {
      const a = money(c.emd_amount);
      if (a) set('emd_amount', Number(a).toLocaleString('en-US'), c, 'deposit');
    }
    if (!blank(c.emd_days)) {
      const n = days(c.emd_days);
      if (n) set('emd_business_days', n, c, 'deposit days');
    }
    for (const [term, daysField, dateField] of [
      ['inspection', 'inspection_contingency_days', 'inspection_contingency_date'],
      ['appraisal', 'appraisal_contingency_days', 'appraisal_contingency_date'],
      ['loan', 'loan_contingency_days', 'loan_contingency_date'],
    ]) {
      const v = c[term];
      if (blank(v)) continue;
      const n = days(v);
      if (n && !WAIVED.test(v)) set(daysField, n, c, `${term} contingency`);
      else if (WAIVED.test(v)) {
        set(daysField, '', c, `${term} contingency waived`);
        set(dateField, '', c, `${term} contingency waived`);
      } else review.push(`${label(c)} changes the ${term} contingency but it could not be read ("${v}")`);
    }
    if (!blank(c.disclosures)) {
      const n = days(c.disclosures);
      if (n) set('seller_disclosures_days', n, c, 'disclosure days');
    }
    if (!blank(c.unsure)) review.push(`${label(c)}: ${c.unsure}`);
    if (!blank(c.other_terms)) review.push(`${label(c)} also says: ${String(c.other_terms).slice(0, 300)}`);
  }

  // The last counter decides acceptance: its acceptance signature is the Acceptance date.
  const last = list[list.length - 1];
  const accepted = isoDate(last.accepted_signed);
  // The extraction's own acceptance read is right ~90% of the time; a counter's
  // signature date only fills it when it is blank (1755 Ocean, 2026-10-10: the
  // counter's date moved a correct acceptance two days and every date with it).
  if (accepted && blank(fields.date_of_acceptance)) set('date_of_acceptance', accepted, last, 'acceptance');
  else if (!accepted) {
    const waitingOn = OTHER_SIDE[SIDE[last.kind]] || 'other party';
    review.unshift(`${label(last)} is awaiting the ${waitingOn}'s signature, so these terms are not final yet`);
  }
  return { applied, review };
}

/** One line a TC reads: "Applied 2 counters: price 1250000 -> 1224500 (SCO #1); ..." */
function summarize(applied, counters) {
  if (!applied.length) return counters && counters.length ? `${counters.length} counter offer(s) found; none changed the terms Keeva fills` : '';
  const parts = applied
    .filter((a) => a.to !== '' || /waived/.test(a.term))
    .map((a) => `${a.term} ${a.from || '(blank)'} -> ${a.to || 'none'} (${a.counter})`);
  return `Applied ${new Set(applied.map((a) => a.counter)).size} counter offer(s): ${parts.join('; ')}`;
}

module.exports = { COUNTER_TOOL, PROMPT, applyCounterTerms, summarize, _internal: { money, days, isoDate, ordered } };
