// netlify/functions/lib/contract-dates.js
//
// THE CONTRACT'S DATES, COUNTED IN CODE. The model reads the day counts; this
// turns them into dates. Plain code over what the extraction read - the same
// split as counter-chain.js: the model reads, code reasons.
//
// Why this exists (scoreboard, 2026-10-10). Scored against 184 live deals,
// the model's own dates were right 30-46% of the time (close of escrow 36%,
// inspection 32%, EMD 39%), and the team's dates were almost always 1 to 3
// days LATER: the model miscounts California's rules - Days start the day
// after Acceptance, and a deadline on a Saturday, Sunday or holiday moves to
// the next business day. Computing the same deals' dates from the model's own
// day counts with these rules: close 86%, EMD 92%, inspection 82%, appraisal
// 81%, loan 78%, disclosures 76%. Same model, same documents.
//
// THE RULES ARE KEEVA'S (Keeva src/lib/date-calc.ts, Megan 2026-09-28): US
// federal holidays on their observed days; calendar Days with the weekend roll
// for contingencies, close of escrow and disclosures; business days for the
// deposit. Kept identical on purpose - the extractor and Keeva must never
// disagree about a deadline. A change to one is a change to both.
//
// ONLY WHERE A COUNT WAS READ. A blank count (no loan contingency, unreadable)
// leaves the model's date as it was, so nothing it found is lost.

'use strict';

const DAY = 86400000;

function parse(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}
const iso = (d) => d.toISOString().slice(0, 10);

function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month, 1));
    const offset = (weekday - first.getUTCDay() + 7) % 7;
    return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
  }
  const last = new Date(Date.UTC(year, month + 1, 0));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, last.getUTCDate() - back));
}

function observed(d) {
  const day = d.getUTCDay();
  if (day === 6) return new Date(d.getTime() - DAY);
  if (day === 0) return new Date(d.getTime() + DAY);
  return d;
}

/** US federal holidays of one year, on their observed days (Keeva date-calc). */
function federalHolidays(year) {
  const fixed = (m, d) => iso(observed(new Date(Date.UTC(year, m, d))));
  const floating = (m, wd, n) => iso(nthWeekday(year, m, wd, n));
  return [
    fixed(0, 1), floating(0, 1, 3), floating(1, 1, 3), floating(4, 1, -1), fixed(5, 19), fixed(6, 4),
    floating(8, 1, 1), floating(9, 1, 2), fixed(10, 11), floating(10, 4, 4), fixed(11, 25),
  ];
}

function isHoliday(date) {
  const year = Number(date.slice(0, 4));
  return federalHolidays(year).includes(date) || federalHolidays(year + 1).includes(date);
}

function isBusinessDay(date) {
  const d = parse(date);
  if (!d) return false;
  const day = d.getUTCDay();
  return day !== 0 && day !== 6 && !isHoliday(date);
}

/** Start plus N days, 'calendar' or 'business', then rolled to a business day. */
function addDays(start, amount, mode) {
  const s = parse(start);
  if (!s || !Number.isFinite(amount)) return '';
  let landed = s;
  if (mode === 'business') {
    let left = Math.abs(Math.trunc(amount));
    while (left > 0) {
      landed = new Date(landed.getTime() + DAY);
      if (isBusinessDay(iso(landed))) left--;
    }
  } else {
    landed = new Date(s.getTime() + Math.trunc(amount) * DAY);
  }
  let answer = landed;
  while (!isBusinessDay(iso(answer))) answer = new Date(answer.getTime() + DAY);
  return iso(answer);
}

/** A count as read: "17", " 21 " -> 17; blank or words -> null. */
function count(v) {
  const m = /^\s*(\d{1,3})\s*$/.exec(String(v == null ? '' : v));
  return m ? Number(m[1]) : null;
}

// Each date the model also gives, and the count it is computed from.
const DERIVED = [
  { field: 'emd_due_date', days: 'emd_business_days', mode: 'business', fallback: 3 },
  { field: 'seller_disclosures_due_date', days: 'seller_disclosures_days', mode: 'calendar' },
  { field: 'inspection_contingency_date', days: 'inspection_contingency_days', mode: 'calendar' },
  { field: 'appraisal_contingency_date', days: 'appraisal_contingency_days', mode: 'calendar' },
  { field: 'loan_contingency_date', days: 'loan_contingency_days', mode: 'calendar' },
];

/**
 * Overwrite the model's dates with dates counted from Acceptance. Returns
 * what changed ({ field, model, code }) so the caller can log it. Mutates
 * `fields`. Acceptance missing or unreadable: nothing changes.
 */
function applyContractDates(fields) {
  const changed = [];
  const acceptance = parse(fields && fields.date_of_acceptance) ? iso(parse(fields.date_of_acceptance)) : '';
  if (!acceptance) return changed;
  const set = (field, value) => {
    if (!value) return;
    const before = String(fields[field] || '');
    if (before !== value) changed.push({ field, model: before, code: value });
    fields[field] = value;
  };

  // Close of escrow: a specific date stands as written; otherwise Days after Acceptance.
  const specific = parse(fields.close_of_escrow_specific_date);
  if (specific) set('close_of_escrow_date', iso(specific));
  else {
    const n = count(fields.close_of_escrow_days);
    if (n != null) set('close_of_escrow_date', addDays(acceptance, n, 'calendar'));
  }

  for (const d of DERIVED) {
    const n = count(fields[d.days]);
    const days = n != null ? n : d.fallback;
    if (days == null) continue;
    set(d.field, addDays(acceptance, days, d.mode));
  }
  if (changed.length) fields._dates_counted_by = 'code';
  return changed;
}

module.exports = { applyContractDates, _internal: { addDays, isBusinessDay, federalHolidays, count } };
