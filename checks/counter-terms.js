// checks/counter-terms.js
//
// Pins how counter offers become the final terms (lib/counter-terms.js),
// without a PDF or a model:
//   node checks/counter-terms.js
// The model copies each counter; code lays them on the RPA in order, the
// last word on each term winning. An unsigned last counter is applied and
// reported, never refused (Megan, 2026-10-10: transactions are created from
// "Contract NeedB" packets all the time).

const { applyCounterTerms, summarize, _internal } = require('../netlify/functions/lib/counter-terms.js');
const { money, days, isoDate } = _internal;

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}
const counter = (o) => ({ kind: 'SCO', number: '1', date: '', counters_what: '', price: '', close_of_escrow: '', emd_amount: '', emd_days: '', inspection: '', appraisal: '', loan: '', disclosures: '', other_terms: '', made_by_signed: '', accepted_signed: '', unsure: '', ...o });

ok('money', [money('$1,315,000'), money('1315000.00'), money('17 days')], ['1315000', '1315000', ''])
ok('days', [days('21 days after Acceptance'), days('10 (ten) days'), days('waived')], ['21', '10', ''])
ok('dates', [isoDate('12/15/2026'), isoDate('September 23, 2026'), isoDate('2026-10-01')], ['2026-12-15', '2026-09-23', '2026-10-01'])

// RPA -> SCO #1 (price, COE) -> BCO #1 (price back down, inspection) -> SCO #2 (accepted).
const f = { final_purchase_price: '1200000', close_of_escrow_days: '30', close_of_escrow_specific_date: '', inspection_contingency_days: '17', loan_contingency_days: '21', loan_contingency_date: '2026-10-29', date_of_acceptance: '2026-10-08' }
const { applied, review } = applyCounterTerms(f, [
  counter({ kind: 'SCO', number: '1', date: '10/03/2026', price: '$1,275,000', close_of_escrow: '21 days', accepted_signed: '' , made_by_signed: '10/03/2026' }),
  counter({ kind: 'BCO', number: '1', date: '10/04/2026', price: '$1,250,000', inspection: '10 days', made_by_signed: '10/04/2026', counters_what: 'Seller Counter Offer No. 1' }),
  counter({ kind: 'SCO', number: '2', date: '10/05/2026', loan: 'Buyer waives the loan contingency', accepted_signed: '10/06/2026', other_terms: 'Seller to credit $5,000 toward closing costs' }),
])
ok('last word on price wins (BCO #1)', f.final_purchase_price, '1250000')
ok('close of escrow from SCO #1', f.close_of_escrow_days, '21')
ok('inspection from BCO #1', f.inspection_contingency_days, '10')
ok('loan waived by SCO #2', [f.loan_contingency_days, f.loan_contingency_date], ['', ''])
ok('acceptance: the extraction\'s own read stands', f.date_of_acceptance, '2026-10-08')
ok('other terms go to review, word for word', review.some((r) => /credit \$5,000/.test(r)), true)
ok('nothing awaiting a signature', review.some((r) => /awaiting/.test(r)), false)
ok('summary names the counters', /Applied 3 counter offer\(s\)/.test(summarize(applied, [1, 2, 3])), true)

// Out of order in the packet: the chain is by date, not by page.
const g = { final_purchase_price: '900000' }
applyCounterTerms(g, [
  counter({ kind: 'BCO', number: '1', date: '09/12/2026', price: '$880,000' }),
  counter({ kind: 'SCO', number: '1', date: '09/10/2026', price: '$920,000' }),
])
ok('the later counter wins even when it comes first in the packet', g.final_purchase_price, '880000')

// Unsigned last counter: applied, and reported.
const h = { final_purchase_price: '700000', date_of_acceptance: '2026-10-08' }
const r2 = applyCounterTerms(h, [counter({ kind: 'SCO', number: '1', price: '$725,000', accepted_signed: '' })])
ok('unsigned counter still applies its terms', h.final_purchase_price, '725000')
ok('and says who it waits on', r2.review[0], "SCO #1 is awaiting the buyer's signature, so these terms are not final yet")
ok('acceptance left as it was', h.date_of_acceptance, '2026-10-08')

// A specific close date replaces days; an unreadable price goes to review.
const k = { close_of_escrow_days: '30', close_of_escrow_specific_date: '', final_purchase_price: '500000' }
const r3 = applyCounterTerms(k, [counter({ close_of_escrow: 'on or before 12/15/2026', price: 'see attached', unsure: 'price is handwritten over', accepted_signed: '10/01/2026' })])
ok('specific close date', [k.close_of_escrow_specific_date, k.close_of_escrow_days], ['2026-12-15', ''])
ok('unreadable price kept, flagged', [k.final_purchase_price, r3.review.some((r) => /could not be read/.test(r)), r3.review.some((r) => /handwritten/.test(r))], ['500000', true, true])

ok('no counters, nothing happens', applyCounterTerms({ a: 1 }, []), { applied: [], review: [] })

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\ncounter terms: all pass');
