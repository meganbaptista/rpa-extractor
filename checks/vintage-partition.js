// checks/vintage-partition.js
//
// Proves the prior-sale quarantine without deploying or emailing a package at it.
//   node checks/vintage-partition.js
//
// The case this exists for is the 2026-09-17 delivery: current disclosures
// attached, a Dropbox link to the property's PREVIOUS sale, and that prior sale
// being exempt, so its ESD put a regular sale on the exempt path.

const intake = require('../netlify/functions/disclosure-intake-check-background.js');
const { parseSignedDate, vintageOf, partitionByVintage, mergeForms, vintageLabel, applyExemptSellerRules, nameTokens, dealSellerTokens, isDifferentParty } = intake._internal;
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


// --- 28935 PALOS VERDES DR E, the delivery that got through ---------------
// Every current form named "Lindsay Mclain, Ryan Mclain" and was signed in 2026.
// The prior sale's ESD named "Wood Family Trust" and carried NO signature date,
// so a date-only test had nothing to judge and passed it as current. The exempt
// rule then fired and asked for a WHSD on a regular sale.
const pv = [
  { code: 'SBSA', name: 'Statewide Buyer and Seller Advisory', signed: '8/12/2026', seller: 'Lindsay Mclain, Ryan Mclain' },
  { code: 'TDS', name: 'Real Estate Transfer Disclosure Statement', signed: '8/12/2026', seller: 'Lindsay Mclain, Ryan Mclain' },
  { code: 'SPQ', name: 'Seller Property Questionnaire', signed: '8/12/2026', seller: 'Lindsay Mclain, Ryan Mclain' },
  { code: 'RPA', name: 'Residential Purchase Agreement', signed: '9/9/2026', seller: 'Lindsay McLain, Ryan McLain' },
  { code: 'AD', name: 'Agency Disclosure', signed: '', seller: '' },
  { code: 'AVID', name: 'Agent Visual Inspection Disclosure', signed: '', seller: '' },
  { code: 'ESD', name: 'Exempt Seller Disclosure', signed: '', seller: 'Wood Family Trust' },
];

const pvNow = Date.UTC(2026, 8, 17);
const pvTokens = dealSellerTokens(pv, pvNow);
ok('the deal seller is read off the dated forms', [...pvTokens].sort(), ['lindsay', 'mclain', 'ryan']);
ok('the trust is a different party', isDifferentParty(pv[6], pvTokens), true);
ok('an unnamed form is never a different party', isDifferentParty(pv[4], pvTokens), false);

const pvPart = partitionByVintage(pv, pvNow);
ok('the undated prior-sale ESD is quarantined', pvPart.historical.map((f) => f.code), ['ESD']);
ok('undated current-sale forms are untouched', pvPart.current.map((f) => f.code), ['SBSA', 'TDS', 'SPQ', 'RPA', 'AD', 'AVID']);
ok('quarantined for the right reason', pvPart.historical[0].vintage.reason, 'party');
ok('and the label says why',
  vintageLabel(pvPart.historical[0]),
  'ESD Exempt Seller Disclosure, seller Wood Family Trust, no signature date on it');

const pvList = { still_needed: ['TDS', 'SPQ', 'FHDS', 'Earthquake Hazard Report 1960'], present: [], not_applicable: [], verify: [] };
ok('the exempt rule no longer fires', applyExemptSellerRules(pvList, pvPart.current).exempt, false);
ok('no WHSD is invented, and the FHDS survives', pvList.still_needed, ['TDS', 'SPQ', 'FHDS', 'Earthquake Hazard Report 1960']);
// And the old behaviour, for the record.
const pvOld = { still_needed: ['TDS', 'SPQ', 'FHDS', 'Earthquake Hazard Report 1960'], present: [], not_applicable: [], verify: [] };
applyExemptSellerRules(pvOld, pv);
ok('the old behaviour asked for a WHSD instead', pvOld.still_needed, ['WHSD']);

// --- the false positive this was feared to cause --------------------------
// Sellers who hold title in a trust sign some forms as trustees. The trust name
// and the trustee's name must NOT read as two different parties.
const trustee = [
  { code: 'TDS', name: 'Transfer Disclosure', signed: '8/12/2026', seller: 'Lindsay Mclain, Ryan Mclain' },
  { code: 'SPQ', name: 'Seller Questionnaire', signed: '8/12/2026', seller: 'Lindsay Mclain, Ryan Mclain' },
  { code: 'ESD', name: 'Exempt Seller Disclosure', signed: '', seller: 'McLain Family Trust dated June 3, 1998' },
];
const tPart = partitionByVintage(trustee, pvNow);
ok('a trust sharing the surname is NOT quarantined', tPart.historical.length, 0);
ok('and it still counts', tPart.current.map((f) => f.code), ['TDS', 'SPQ', 'ESD']);

// A mismatched name WITH a current date is a question, not a verdict: an AVID
// signed by the listing agent must not be thrown out of the package.
const agent = [
  { code: 'TDS', name: 'Transfer Disclosure', signed: '8/12/2026', seller: 'Lindsay Mclain, Ryan Mclain' },
  { code: 'SPQ', name: 'Seller Questionnaire', signed: '8/12/2026', seller: 'Lindsay Mclain, Ryan Mclain' },
  { code: 'AVID', name: 'Agent Visual Inspection', signed: '9/2/2026', seller: 'Dana Whitfield' },
];
const aPart = partitionByVintage(agent, pvNow);
ok('a current-dated mismatch is not quarantined', aPart.historical.length, 0);
ok('it is raised for a human instead', aPart.aging.map((f) => f.code), ['AVID']);
ok('with the party reason', aPart.aging[0].vintage.reason, 'party');

// No dated forms at all = no baseline = no opinion.
const noBase = [
  { code: 'ESD', name: 'Exempt Seller Disclosure', signed: '', seller: 'Wood Family Trust' },
  { code: 'TDS', name: 'Transfer Disclosure', signed: '', seller: '' },
];
ok('no baseline means no quarantine', partitionByVintage(noBase, pvNow).historical.length, 0);

// Stopwords: a trust name must not reduce to nothing but boilerplate.
ok('trust boilerplate is dropped', [...nameTokens('The Wood Family Revocable Living Trust')].sort(), ['wood']);
ok('a two-surname couple survives', [...nameTokens('Jose Molina; Laure Molina')].sort(), ['jose', 'laure', 'molina']);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
