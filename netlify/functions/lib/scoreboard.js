// netlify/functions/lib/scoreboard.js
//
// HOW RIGHT IS THE EXTRACTOR, ON THE DAY THE DEAL OPENS? Each of Megan's
// escrow introduction emails (lib/timeline-email.js) is paired with the
// extraction that created that deal, and each date is scored two ways:
//
//   sent      the dates exactly as the extraction delivered them then
//   counted   the same extraction with the dates counted in code from its
//             day counts (lib/contract-dates.js) - what the extractor does
//             now. Only extractions since 2026-10-01 kept the counts.
//
// Pure: the background function fetches, this pairs and counts.

'use strict';

const { applyContractDates } = require('./contract-dates');

const FIELD = {
  acceptance: 'date_of_acceptance',
  emd: 'emd_due_date',
  disclosures: 'seller_disclosures_due_date',
  inspection: 'inspection_contingency_date',
  appraisal: 'appraisal_contingency_date',
  loan: 'loan_contingency_date',
  close: 'close_of_escrow_date',
};

const day = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
};

/** A property, for pairing: house number, street words, unit. */
function propertyKey(address) {
  const street = String(address || '').split(',')[0].toLowerCase();
  const unit = (/(?:#|\bunit\b|\bapt\b|\bste\b|\bsuite\b)\s*([a-z0-9-]+)/.exec(street) || [])[1] || '';
  const words = street
    .replace(/(?:#|\bunit\b|\bapt\b|\bste\b|\bsuite\b)\s*[a-z0-9-]+/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !/^(st|street|ave|avenue|dr|drive|rd|road|blvd|boulevard|ln|lane|ct|court|pl|place|way|ter|terrace|cir|circle|pkwy|parkway|hwy|highway|n|s|e|w)$/.test(w));
  return words.length ? `${words.join(' ')}${unit ? '#' + unit : ''}` : '';
}

/**
 * The extraction that made the deal: the latest one for the property that
 * finished BEFORE the email went out (a later run is a re-read, not what the
 * deal was opened from).
 */
function pickExtraction(extractions, key, sentIso) {
  const sent = String(sentIso || '');
  return extractions
    .filter((x) => x.key === key && (!sent || String(x.at) <= sent))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
}

/** One email scored against one extraction: per field, the email's date, what was sent, what code counts. */
function scorePair(email, fields) {
  const counted = { ...fields };
  const hadCounts = 'inspection_contingency_days' in fields;
  if (hadCounts) applyContractDates(counted);
  const out = {};
  for (const [k, f] of Object.entries(FIELD)) {
    const truth = email.dates[k];
    if (truth === undefined || truth === '') continue;
    const want = truth === 'none' ? '' : truth;
    const sent = day(fields[f]);
    const cnt = hadCounts ? day(counted[f]) : null;
    out[k] = { email: want, sent, sentOk: sent === want, counted: cnt, countedOk: cnt === null ? null : cnt === want };
  }
  return out;
}

/** The whole board: per-field totals both ways, and every miss to look at. */
function buildBoard(pairs) {
  const fields = {};
  const misses = [];
  for (const p of pairs) {
    for (const [k, r] of Object.entries(p.score)) {
      const t = (fields[k] = fields[k] || { sentRight: 0, sentOf: 0, countedRight: 0, countedOf: 0 });
      t.sentOf++;
      if (r.sentOk) t.sentRight++;
      if (r.countedOk !== null) {
        t.countedOf++;
        if (r.countedOk) t.countedRight++;
      }
      const wrongNow = r.countedOk === null ? !r.sentOk : !r.countedOk;
      // `method`: 'counted' is today's extractor; 'sent' an older run that kept no day counts.
      if (wrongNow) misses.push({ address: p.address, side: p.side, field: k, email: r.email, extractor: r.countedOk === null ? r.sent : r.counted, emailedOn: p.sentAt.slice(0, 10), method: r.countedOk === null ? 'sent' : 'counted' });
    }
  }
  return { fields, misses };
}

module.exports = { FIELD, propertyKey, pickExtraction, scorePair, buildBoard };
