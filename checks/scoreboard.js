// checks/scoreboard.js
//
// Pins the day-0 scoreboard (lib/timeline-email.js + lib/scoreboard.js):
//   node checks/scoreboard.js
// Megan's introduction email for 3627 Cody's second escrow is the model case:
// the extraction plus the counted dates matched it exactly.

const { parseSubject, parseTimeline, _internal } = require('../netlify/functions/lib/timeline-email.js');
const { propertyKey, pickExtraction, scorePair, buildBoard } = require('../netlify/functions/lib/scoreboard.js');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

ok('seller subject', parseSubject('3627 Cody Rd, Los Angeles, CA 91403 | Seller Escrow Introductions'), { address: '3627 Cody Rd, Los Angeles, CA 91403', side: 'Seller' });
ok('buyer subject, with a reply prefix', parseSubject('Re: 1150 Iliff St | Buyer Escrow Introductions'), { address: '1150 Iliff St', side: 'Buyer' });
ok('other subjects are not intros', parseSubject('1150 Iliff St | Transaction Update'), null);
ok('a December email naming January means next year', _internal.parseDay('Friday, January 8th', '2026-12-20T00:00:00Z'), '2027-01-08');

const body = `Hi everyone,

Introducing everyone on this transaction.

IMPORTANT DATES/TIMELINE OF ESCROW:

  • Acceptance Date: Wednesday, September 16th
  • Buyer Deposit Due: Monday, September 21st
  • Buyer Inspection Contingency Release: Monday, September 21st
  • Buyer Loan Contingency Release: Waived
  • Close of Escrow: Wednesday, October 7th

Please let me know if you have any questions, and thank you all for a smooth close on September 30th.`;
const dates = parseTimeline(body, '2026-09-17T18:00:00Z');
ok('the timeline block, read', dates, { acceptance: '2026-09-16', emd: '2026-09-21', inspection: '2026-09-21', loan: 'none', close: '2026-10-07' });
ok('no block, nothing', parseTimeline('Hi, just checking in. Close of Escrow: October 7th', '2026-09-17'), null);

ok('property key ignores suffix, city and case', propertyKey('3627 Cody Road, Los Angeles'), propertyKey('3627 CODY RD, LA, CA 91403'));
ok('a unit is part of it', propertyKey('1755 Ocean Ave #412') === propertyKey('1755 Ocean Ave #411'), false);

const runs = [
  { key: 'k', at: '2026-09-03T00:00:00Z', fields: { a: 1 } },
  { key: 'k', at: '2026-09-17T09:00:00Z', fields: { a: 2 } },
  { key: 'k', at: '2026-09-25T00:00:00Z', fields: { a: 3 } },
];
ok('the extraction that made the deal: latest before the email', pickExtraction(runs, 'k', '2026-09-17T18:00:00Z').fields.a, 2);

// Cody's second contract, as extracted: counts present, the model's own dates off.
const fields = {
  date_of_acceptance: '2026-09-16', close_of_escrow_days: '21', close_of_escrow_specific_date: '', close_of_escrow_date: '2026-10-06',
  emd_business_days: '3', emd_due_date: '2026-09-19', inspection_contingency_days: '3', inspection_contingency_date: '2026-09-19',
  loan_contingency_days: '', loan_contingency_date: '', seller_disclosures_days: '1', seller_disclosures_due_date: '2026-09-17',
};
const score = scorePair({ dates }, fields);
ok('as sent: the model\'s own dates miss', [score.close.sentOk, score.emd.sentOk, score.inspection.sentOk], [false, false, false]);
ok('counted in code: every one matches her email', Object.values(score).every((r) => r.countedOk), true);
const board = buildBoard([{ address: '3627 Cody Rd', side: 'Seller', sentAt: '2026-09-17T18:00:00Z', score }]);
ok('board totals', board.fields.close, { sentRight: 0, sentOf: 1, countedRight: 1, countedOf: 1 });
ok('no misses once counted', board.misses.length, 0);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nscoreboard: all pass');
