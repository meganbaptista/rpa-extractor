// checks/earthquake-booklet.js
//
// The earthquake guide booklet is not a seller's form.   node checks/earthquake-booklet.js
//
// 10323 Dunkirk (2026-10-02): the 39-page "Homeowner's Guide to Earthquake
// Safety" prints a BLANK Residential Earthquake Risk Disclosure Statement and a
// chapter per item. The picker took pages 13-24, the review chased all 11 items
// "left unanswered" under the label "ESD", and the filled statement delivered as
// its own file had 0 flags. Page text below is a stand-in; the booklet's layout
// (running header on most pages, statement on page 14) is the real one.

const M = require('../netlify/functions/disclosure-intake-check-background.js')._internal;

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

const HDR = "HOMEOWNER'S GUIDE TO EARTHQUAKE SAFETY";
const STATEMENT = 'Residential Earthquake Risk Disclosure Statement (2020 Edition) Name APN Answer these questions to the best of your knowledge. '
  + '1. Is the water heater braced to resist falling during an earthquake? Yes No Doesn\'t Apply Don\'t Know EXECUTED BY Seller Buyer';
const filler = 'Earthquakes are inevitable in California and this guide explains the risks to a home in some detail for the reader. '.repeat(4);
const chapter = (n) => `${HDR} Earthquake Risk Disclosure Statement Item ${n} Is your water heater braced? Are you aware of any work done? ${filler}`;

// The booklet: header from page 3, statement on 14, chapters 15-23.
const booklet = Array.from({ length: 39 }, (_, i) => {
  const num = i + 1;
  let text = `${HDR} ${filler}`;
  if (num <= 2) text = `Attention zipForm users ${filler}`;
  if (num === 13) text = `Residential Earthquake Risks & the Disclosure Statement ${filler}`;
  if (num === 14) text = `${HDR} ${STATEMENT} ${filler}`;
  if (num >= 15 && num <= 23) text = chapter(num - 14);
  return { num, text };
});
// The filled statement on its own: header on page 1 only, addendum on page 2.
const filled = [
  { num: 1, text: `Docusign Envelope ID ${HDR} ${STATEMENT} X X X ${filler}` },
  { num: 2, text: `Residential Earthquake Risk Disclosure Statement Addendum If you corrected one or more earthquake weaknesses ${filler}` },
];

const lb = M.eqStatementLayout(booklet);
ok('booklet: recognised as one run', lb.runs.length, 1);
ok('booklet: its statement is the booklet copy', [lb.bookletStatementPages, lb.standaloneStatementPages], [[14], []]);
const lf = M.eqStatementLayout(filled);
ok('filled statement: not a booklet', lf.runs.length, 0);
ok('filled statement: a standalone copy', lf.standaloneStatementPages, [1]);

const alone = M.selectQAPagesFromText(booklet, booklet.length);
ok('booklet alone: only the statement page is reviewed', alone.pages, [14]);
const skipped = M.selectQAPagesFromText(booklet, booklet.length, { skipBookletStatement: true });
ok('booklet with a separate copy delivered: nothing reviewed', skipped.pages, []);
ok('the selection line says why', /earthquake guide booklet/.test(skipped.selection), true);
ok('the filled statement is still reviewed', M.selectQAPagesFromText(filled, filled.length).pages.includes(1), true);

// A seller packet with the booklet bundled in: only the booklet's pages go.
const packet = [
  { num: 1, text: `SELLER PROPERTY QUESTIONNAIRE (C.A.R. Form SPQ) Are you (Seller) aware of ${filler}` },
  ...booklet.map((p) => ({ num: p.num + 1, text: p.text })),
];
const pk = M.selectQAPagesFromText(packet, packet.length);
ok('bundled booklet: the SPQ page survives', pk.pages.includes(1), true);
ok('bundled booklet: no chapter page survives', pk.pages.some((n) => n >= 16 && n <= 24), false);

const flags = [
  { form: 'ESD', item: '1', reason: 'the water heater bracing question is left unanswered' },
  { form: 'ESD', item: '5a', reason: 'the exterior tall foundation walls braced question' },
  { form: 'ESD', item: 'signature', reason: 'the seller did not sign the exempt seller disclosure' },
  { form: 'TDS', item: 'A', reason: 'water heater marked No with no explanation' },
];
ok('relabel: earthquake questions under "ESD" only',
  M.relabelEarthquakeFlags(flags).map((f) => f.form),
  ['Earthquake Risk Disclosure Statement', 'Earthquake Risk Disclosure Statement', 'ESD', 'TDS']);

// ---- the free seller-signature check (Dunkirk's statement was unsigned) ----
{
  const forms = [
    { code: 'ESD', name: 'Exempt Seller Disclosure', signed: '9/30/2026' },
    { code: '', name: "Residential Earthquake Risk Disclosure Statement (Homeowner's Guide to Earthquake Safety)", signed: '' },
    { code: '', name: "Residential Earthquake Risk Disclosure Statement (Homeowner's Guide to Earthquake Safety, 2020 Edition)", signed: '' },
    { code: 'LPD', name: 'Lead-Based Paint Disclosure', signed: '9/30/2026' },
    { code: 'SBSA', name: 'Statewide Buyer and Seller Advisory', signed: '' },
    { code: 'DIA', name: 'Disclosure Information Advisory', signed: '' },
    { code: '', name: 'Earthquake/Environmental Hazards Booklet Receipt', signed: '' },
    { code: '', name: 'TruLine Mold Disclosure', signed: '' },
  ];
  const got = M.unsignedSellerForms(forms).map((f) => f.code || f.name);
  ok('unsigned: the statement once (two copies, one family), and the SBSA', got,
    ["Residential Earthquake Risk Disclosure Statement (Homeowner's Guide to Earthquake Safety)", 'SBSA']);
  // A signed copy anywhere clears the family: the booklet's blank cannot raise it.
  const withSigned = forms.map((f) => (/2020 Edition/.test(f.name) ? { ...f, signed: '9/30/2026' } : f));
  ok('unsigned: any signed copy clears the family', M.unsignedSellerForms(withSigned).map((f) => f.code || f.name), ['SBSA']);
  ok('a receipt is not the statement', M.requiresSellerSignature({ name: 'NHD Receipt' }), false);
  ok('a brokerage form with no known seller line is never accused', M.requiresSellerSignature({ name: 'TruLine Mold Disclosure' }), false);
  ok('AVID-LA counts as AVID', M.requiresSellerSignature({ code: 'AVID-LA' }), true);
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall earthquake-booklet checks pass');
