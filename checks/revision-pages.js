// checks/revision-pages.js
//
// 6051 Scenic (2026-10-26): the buyer's revision email attached the whole
// 31-page NHD report (its only fix: the seller's signature on the statement
// page) and the FHDS file's Defensible Space Decision Tree, and its closing
// paragraph listed every section title of the NHD report. Megan: "this last
// paragraph seems a little wild".
//   node checks/revision-pages.js

const rc = require('../netlify/functions/lib/revision-check.js');
const { buildRevisionEmail } = require('../netlify/functions/lib/buyer-email.js');
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

const nhd = { n: 8, name: '[reply Oct 26, 3:49 PM] NHD Report  (83).pdf', pages: 31, forms: ['Flood, Fire & Tax Upfront', 'Natural Hazard Disclosure Statement', 'Mello-Roos Community Facilities District(s)', 'Radon Gas Advisory'] };
const r1 = rc.pagesToSend(nhd, [], [3]);
ok('NHD report: only the signed statement page goes', r1.pages.join(), '3');
ok('and it says the buyer has the full report', /only the page with the change; the buyer has the full report/.test(r1.dropped.join()), true);

const fhds = { n: 6, name: 'FHDS completed Scenic.pdf', pages: 4, forms: ['Fire Hardening and Defensible Space Disclosure and Addendum', 'Defensible Space Decision Tree'] };
const texts = [1, 2].map((num) => ({ num, text: 'FIRE HARDENING AND DEFENSIBLE SPACE DISCLOSURE AND ADDENDUM' })).concat([3, 4].map((num) => ({ num, text: 'Docusign Envelope ID: 1234-ABCD DEFENSIBLE SPACE DECISION TREE (C.A.R. Form DSDT)' })));
const r2 = rc.pagesToSend(fhds, texts, [2]);
ok('FHDS file: the decision tree pages are left out', r2.pages.join(), '1,2');
ok('and named', r2.dropped.join(), 'the defensible space decision tree');

const bie = { n: 1, name: 'x.pdf', pages: 2, forms: [] };
ok('BIE / BIW pages never go', rc.pagesToSend(bie, [{ num: 1, text: "BUYER'S INVESTIGATION ELECTIONS No. ONE" }, { num: 2, text: 'SPQ page' }], [2]).pages.join(), '2');
ok('a short file with nothing to drop goes whole', rc.pagesToSend({ n: 2, name: 'SPQ revised.pdf', pages: 5, forms: ['Seller Property Questionnaire'] }, [], [1]).pages.join(), '1,2,3,4,5');

const inputs = rc.emailInputs([{ status: 'fixed', n: 6, page: 2, mergedPage: 2, buyerLine: 'The seller confirmed the brush clearance rule.' }], [fhds]);
ok('the decision tree is never named in the closing line', inputs.forms.some((f) => /decision tree/i.test(f)), false);

const many = buildRevisionEmail({ greeting: 'Hello Alexandria,', changes: [{ page: 1, label: 'x' }], forms: ['Seller Property Questionnaire', 'Addendum', 'Natural Hazard Disclosure Statement', 'Mello-Roos Community Facilities District(s)', 'Radon Gas Advisory'], totalPages: 3, stillToCome: [] });
ok('more than two documents: the plain closing sentence', /These replace the matching pages in the package I sent earlier\./.test(many.html), true);
ok('no section titles listed', /Mello-Roos|Radon/.test(many.html), false);
const two = buildRevisionEmail({ greeting: 'Hello Alexandria,', changes: [{ page: 1, label: 'x' }], forms: ['Seller Property Questionnaire', 'Trust Advisory'], totalPages: 3, stillToCome: [] });
ok('two documents are still named', /These replace the matching Seller Property Questionnaire and Trust Advisory pages/.test(two.html), true);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall revision-pages checks pass');
process.exit(failed ? 1 : 0);
