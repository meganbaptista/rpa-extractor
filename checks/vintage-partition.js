// checks/vintage-partition.js
//
// Proves the prior-sale quarantine without deploying or emailing a package at it.
//   node checks/vintage-partition.js
//
// The case this exists for is the 2026-09-17 delivery: current disclosures
// attached, a Dropbox link to the property's PREVIOUS sale, and that prior sale
// being exempt, so its ESD put a regular sale on the exempt path.

const intake = require('../netlify/functions/disclosure-intake-check-background.js');
const { parseSignedDate, vintageOf, partitionByVintage, mergeForms, vintageLabel, applyExemptSellerRules } = intake._internal;
const { inPriorTransactionFolder } = require('../netlify/functions/lib/unzip.js');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

// A fixed "now" so these assertions do not rot: 2026-09-17, the day of the deal.
const NOW = Date.UTC(2026, 8, 17);
const band = (signed) => vintageOf({ signed }, NOW).band;

// --- date reading -----------------------------------------------------------
ok('M/D/YYYY', parseSignedDate('4/12/2024'), Date.UTC(2024, 3, 12));
ok('M/D/YY', parseSignedDate('4/12/24'), Date.UTC(2024, 3, 12));
ok('ISO', parseSignedDate('2024-04-12'), Date.UTC(2024, 3, 12));
ok('dashed', parseSignedDate('4-12-2024'), Date.UTC(2024, 3, 12));
ok('month name', parseSignedDate('April 12, 2024'), Date.UTC(2024, 3, 12));
ok('abbrev month', parseSignedDate('Sept 3 2026'), Date.UTC(2026, 8, 3));
ok('empty', parseSignedDate(''), null);
ok('unreadable', parseSignedDate('n/a'), null);
ok('a revision stamp is not a date', parseSignedDate('6/26'), null);
ok('impossible month', parseSignedDate('13/12/2024'), null);

// --- the bands --------------------------------------------------------------
ok('signed last week is current', band('9/10/2026'), 'current');
ok('four months is current', band('5/20/2026'), 'current');
ok('eight months is aging', band('1/15/2026'), 'aging');
ok('two years is historical', band('4/12/2024'), 'historical');
ok('thirteen months is historical', band('8/1/2025'), 'historical');
// Absence of evidence never quarantines a live disclosure.
ok('no date reads as current', band(''), 'current');
// A mistyped year must not read as very old, and must not read as aging either.
ok('a future date is not old', band('4/12/2027'), 'current');

// --- the actual delivery ----------------------------------------------------
// Attachments: this seller's package. Dropbox link: the prior exempt trust sale.
const received = [
  { code: 'TDS', name: 'Real Estate Transfer Disclosure Statement', signed: '8/28/2026', seller: 'Maria Delgado' },
  { code: 'SPQ', name: 'Seller Property Questionnaire', signed: '8/28/2026', seller: 'Maria Delgado' },
  { code: 'ESD', name: 'Exempt Seller Disclosure', signed: '4/12/2024', seller: 'Hollis Family Trust' },
  { code: 'WHSD', name: 'Water Heater and Smoke Detector Statement', signed: '4/12/2024', seller: 'Hollis Family Trust' },
];
const { current, historical, aging } = partitionByVintage(received, NOW);
ok('current keeps this sale only', current.map((f) => f.code), ['TDS', 'SPQ']);
ok('prior sale is quarantined', historical.map((f) => f.code), ['ESD', 'WHSD']);
ok('nothing is merely aging here', aging.length, 0);

// The whole point: the ESD rule must not see it. receivedHas is not exported, so
// assert the property the rule keys on - no ESD among the forms it is handed.
ok('no ESD reaches the exempt rule', current.some((f) => /esd/i.test(f.code)), false);

ok('the label reads for a human',
  vintageLabel(historical[0]),
  'ESD Exempt Seller Disclosure, signed 4/12/2024, seller Hollis Family Trust');

// --- merge prefers the newer copy ------------------------------------------
const old = { code: 'TDS', name: 'Transfer Disclosure Statement', signed: '4/12/2024' };
const now_ = { code: 'TDS', name: 'Transfer Disclosure Statement', signed: '8/28/2026' };
ok('historical first, current wins', mergeForms([old], [now_])[0].signed, '8/28/2026');
ok('current first, still wins', mergeForms([now_], [old])[0].signed, '8/28/2026');
ok('a dated copy beats an undated one', mergeForms([{ code: 'TDS', signed: '' }], [old])[0].signed, '4/12/2024');
ok('one form, one slot', mergeForms([old], [now_]).length, 1);

// --- the cheap first pass, before a page is inflated ------------------------
ok('previous sale folder', inPriorTransactionFolder('Previous Sale Disclosures/TDS.pdf'), true);
ok('prior escrow folder', inPriorTransactionFolder('937 Granada/Prior Escrow/SPQ.pdf'), true);
ok('year-labelled folder', inPriorTransactionFolder('2019 Sale/TDS.pdf'), true);
ok('archive folder', inPriorTransactionFolder('Archived/ESD.pdf'), true);
ok('this sale is untouched', inPriorTransactionFolder('Seller Disclosures/TDS.pdf'), false);
// A street number in a folder name must not read as a year.
ok('a street number is not a year', inPriorTransactionFolder('2019 Maple Ave/TDS.pdf'), false);
ok('a bare old year is an archive', inPriorTransactionFolder('2019/TDS.pdf'), true);
ok('this year is not an archive', inPriorTransactionFolder(new Date().getFullYear() + '/TDS.pdf'), false);
ok('last year is not an archive', inPriorTransactionFolder((new Date().getFullYear() - 1) + '/TDS.pdf'), false);
ok('the filename is never matched', inPriorTransactionFolder('Disclosures/Previous Sale TDS.pdf'), false);


// --- the bug itself, end to end --------------------------------------------
// A regular sale whose compliance list wants the TDS, SPQ and FHDS. Run the REAL
// exempt rule twice: once over everything received, which is what shipped on
// 2026-09-17 and what put this deal on the exempt path off a 2024 document, and
// once over the partitioned current forms, which is what happens now.
const listBefore = () => ({ still_needed: ['TDS', 'SPQ', 'FHDS'], present: [], not_applicable: [], verify: [] });

const unpartitioned = listBefore();
ok('the old behaviour, reproduced', applyExemptSellerRules(unpartitioned, received).exempt, true);
// NOTHING outstanding, not even the WHSD the exempt path adds: the prior sale's
// package happened to contain one, so the rule read it as received too. Every
// required disclosure on a regular sale, satisfied or retired by documents from a
// transaction that closed in 2024. This is the quiet half of the bug, and it is
// worse than the exempt flip it was noticed by.
ok('the old behaviour left NOTHING outstanding', unpartitioned.still_needed, []);
ok('and credited a 2024 WHSD as received', unpartitioned.present, ['WHSD']);

const partitioned = listBefore();
ok('a prior sale ESD no longer flips the deal', applyExemptSellerRules(partitioned, current).exempt, false);
ok('this seller still owes the TDS, SPQ and FHDS', partitioned.still_needed, ['TDS', 'SPQ', 'FHDS']);

// The rule is not disabled, only fed the right forms: a CURRENT ESD must still
// behave exactly as it always has.
const realExempt = listBefore();
const nowsEsd = partitionByVintage(
  [{ code: 'ESD', name: 'Exempt Seller Disclosure', signed: '8/28/2026', seller: 'Hollis Family Trust' }], NOW).current;
ok('a current ESD still flips the deal', applyExemptSellerRules(realExempt, nowsEsd).exempt, true);
ok('and still retires the TDS/SPQ/FHDS', realExempt.still_needed, ['WHSD']);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
