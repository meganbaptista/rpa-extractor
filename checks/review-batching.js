// checks/review-batching.js
//
// A form and its overflow pages are never split across review requests.
//   node checks/review-batching.js
// 10423 Oletha (2026-10-22): the TDS (pp81-83) and its Text Overflow Addenda
// (pp84-85) were reviewed in different requests, and five "See overflow
// paragraph" answers were chased as having no addendum.

const { reviewUnits, packReviewBatches } = require('../netlify/functions/disclosure-intake-check-background.js')._internal;

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}
const MB = 1024 * 1024;
const img = (n, text, mb = 1, doc = 'disclosures.pdf') => ({ name: `${doc} qa-p${n}`, text, base64: 'x'.repeat(Math.round(mb * MB)) });
const TDS = (m) => `REAL ESTATE TRANSFER DISCLOSURE STATEMENT TDS REVISED 6/24 (PAGE ${m} OF 3)`;
const SPQ = (m) => `SELLER PROPERTY QUESTIONNAIRE SPQ REVISED 6/26 (PAGE ${m} OF 5)`;
const TOA = 'TEXT OVERFLOW ADDENDUM No. ____ (C.A.R. Form TOA, Revised 6/23) (TOA PAGE 1 OF 1)';
const nums = (units) => units.map((u) => u.map((i) => Number(i.name.split('qa-p')[1])));

// Oletha's shape: SPQ 71-75 + its TOAs 76-80, TDS 81-83 + its TOAs 84-85.
const pages = [
  ...[1, 2, 3, 4, 5].map((m) => img(70 + m, SPQ(m))),
  ...[76, 77, 78, 79, 80].map((n) => img(n, TOA)),
  ...[1, 2, 3].map((m) => img(80 + m, TDS(m))),
  img(84, TOA), img(85, TOA),
];
ok('an overflow addendum stays with the form before it', nums(reviewUnits(pages)),
  [[71, 72, 73, 74, 75, 76, 77, 78, 79, 80], [81, 82, 83, 84, 85]]);

// Size pressure: the old packer cut after p83. Each page 1MB; force a cut near there.
const heavy = pages.map((p) => ({ ...p, base64: 'x'.repeat(Math.round(1.5 * MB)) }));
const batches = nums(packReviewBatches(heavy));
const together = batches.some((b) => [81, 82, 83, 84, 85].every((n) => b.includes(n)));
ok('under size pressure the TDS and its overflow land in one batch', together, true);
ok('no page is lost or duplicated', batches.flat().sort((a, b) => a - b), pages.map((p) => Number(p.name.split('qa-p')[1])));

// Different documents never join a unit, even with consecutive page numbers.
ok('different files are separate units', nums(reviewUnits([img(1, TDS(1), 1, 'a.pdf'), img(2, TOA, 1, 'b.pdf')])), [[1], [2]]);
// A gap in page numbers starts a new unit.
ok('a gap starts a new unit', nums(reviewUnits([img(3, TDS(3)), img(9, TOA)])), [[3], [9]]);
// Overflow pages that open a document stay together as one unit.
ok('leading overflow pages group together', nums(reviewUnits([img(7, TOA), img(8, TOA), img(9, TDS(1))])), [[7, 8], [9]]);
// Scanned pages are still batched apart from digital ones.
const mixed = packReviewBatches([img(1, TDS(1)), { ...img(2, ''), scanned: true }]);
ok('scanned pages are batched apart', mixed.length, 2);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall review-batching checks pass');
process.exit(failed ? 1 : 0);
