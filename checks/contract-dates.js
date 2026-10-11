// checks/contract-dates.js
//
// Pins the contract-date counting (lib/contract-dates.js) to California's
// rules, the same as Keeva's date calculator:
//   node checks/contract-dates.js
// Days start the day after Acceptance; a deadline on a weekend or a federal
// holiday (observed) moves to the next business day; the deposit counts
// business days. A blank count leaves the model's date alone.

const { applyContractDates, _internal } = require('../netlify/functions/lib/contract-dates.js');
const { addDays, isBusinessDay } = _internal;

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

// Acceptance Thu 2026-10-08.
ok('17 calendar days lands on a Sunday -> Monday', addDays('2026-10-08', 17, 'calendar'), '2026-10-26');
ok('3 business days skips the weekend and Columbus Day (Fri 9, Tue 13, Wed 14)', addDays('2026-10-08', 3, 'business'), '2026-10-14');
ok('Columbus Day 2026-10-12 is not a business day', isBusinessDay('2026-10-12'), false);
ok('3 business days from Fri 2026-10-09 skips the weekend AND Columbus Day', addDays('2026-10-09', 3, 'business'), '2026-10-15');
ok('Thanksgiving rolls forward', addDays('2026-11-25', 1, 'calendar'), '2026-11-27');
ok('July 4 2026 is a Saturday, observed Friday July 3', isBusinessDay('2026-07-03'), false);

// The model's dates are replaced from its counts; a blank count leaves its date alone.
const fields = {
  date_of_acceptance: '2026-10-08',
  close_of_escrow_days: '30', close_of_escrow_date: '2026-11-06',
  emd_business_days: '', emd_due_date: '2026-10-11',
  inspection_contingency_days: '17', inspection_contingency_date: '2026-10-25',
  loan_contingency_days: '', loan_contingency_date: '',
  appraisal_contingency_days: '', appraisal_contingency_date: '2026-10-25',
  seller_disclosures_days: '7', seller_disclosures_due_date: '2026-10-15',
};
const changed = applyContractDates(fields);
ok('close: 30 days from 10/08 is Sat 11/07 -> Mon 11/09', fields.close_of_escrow_date, '2026-11-09');
ok('emd: blank count is the printed 3 business days', fields.emd_due_date, '2026-10-14');
ok('inspection: Sunday 10/25 -> Monday 10/26', fields.inspection_contingency_date, '2026-10-26');
ok('appraisal: no count read -> the model date stands', fields.appraisal_contingency_date, '2026-10-25');
ok('loan: no count, no date -> stays blank', fields.loan_contingency_date, '');
ok('disclosures: 7 days -> Thu 10/15', fields.seller_disclosures_due_date, '2026-10-15');
ok('what changed is reported', changed.map((c) => c.field).sort(), ['close_of_escrow_date', 'emd_due_date', 'inspection_contingency_date']);

// A specific close-of-escrow date stands as written.
const f2 = { date_of_acceptance: '2026-10-08', close_of_escrow_specific_date: '2026-12-15', close_of_escrow_days: '', close_of_escrow_date: '2026-12-14' };
applyContractDates(f2);
ok('specific close date wins', f2.close_of_escrow_date, '2026-12-15');

// No acceptance, nothing changes.
const f3 = { date_of_acceptance: '', close_of_escrow_days: '30', close_of_escrow_date: '2026-11-06' };
ok('no acceptance -> untouched', [applyContractDates(f3).length, f3.close_of_escrow_date], [0, '2026-11-06']);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\ncontract dates: all pass');
