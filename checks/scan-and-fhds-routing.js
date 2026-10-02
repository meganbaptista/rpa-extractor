// checks/scan-and-fhds-routing.js
//
// What the intake cannot stand behind goes to VERIFY, not the chase email.
//   node checks/scan-and-fhds-routing.js
//
// 20371 Bluffside (2026-10-02): a wet-signed SPQ/TDS/FHDS scanned to PDF with no
// text layer. Of 7 chase lines, 3 were wrong: TDS Section III "not completed"
// (it was completed and signed), SPQ 7B "marked Yes" (7A was the Yes), and FHDS
// "no 3C option selected" (3C(1) has no checkbox and applies by default). The
// flags below are those lines as the review wrote them.

const M = require('../netlify/functions/disclosure-intake-check-background.js')._internal;

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

const scanned = (f) => ({ ...f, from_scan: true });
const bluffside = [
  scanned({ form: 'TDS', item: 'II A 220 Volt Wiring', issue: 'detail_incomplete', reason: 'the location is left blank' }),
  scanned({ form: 'TDS', item: 'II A Exhaust Fan(s)', issue: 'detail_incomplete', reason: 'the location is left blank' }),
  scanned({ form: 'TDS', item: 'Section III', issue: 'unanswered', reason: "the TDS is present but Section III (the listing agent's Inspection Disclosure) is not included or completed" }),
  scanned({ form: 'SPQ', item: '6G', marked: 'No', should_be: 'Yes', reason: 'the property is a condominium in a common interest development with an HOA' }),
  scanned({ form: 'SPQ', item: '6H', issue: 'yes_no_explanation', reason: 'insurance claims within the past 5 years is marked Yes but the explanation describes cosmetic updates' }),
  scanned({ form: 'SPQ', item: '7B', issue: 'yes_no_explanation', reason: '7B (energy or water efficiency improvements) is marked Yes but no explanation is provided' }),
  scanned({ form: 'FHDS', item: 'Section 3', issue: 'unanswered', reason: 'the FHDS is present and Section 3A is marked but no Section 3C responsibility option is selected; please complete Section 3B and select a Section 3C option' }),
];
const r = M.routeUnconfirmedFlags(bluffside);
const ref = (f) => `${f.form} ${f.item}`;
ok('bluffside: FHDS 3B/3C goes to VERIFY as a default option', r.fhdsDefault.map(ref), ['FHDS Section 3']);
ok('bluffside: every mark-reading flag off the scan goes to VERIFY',
  r.scanUnconfirmed.map(ref), ['TDS Section III', 'SPQ 6G', 'SPQ 6H', 'SPQ 7B']);
ok('bluffside: the two blank-location lines stay in the chase',
  bluffside.filter((f) => !['fhds_default_option', 'scan_unconfirmed'].includes(f.issue)).map(ref),
  ['TDS II A 220 Volt Wiring', 'TDS II A Exhaust Fan(s)']);
ok('the original issue is kept for the record', bluffside.find((f) => f.item === '7B').original_issue, 'yes_no_explanation');

// The same lines off a DIGITAL page are chased exactly as before.
const digital = bluffside.filter((f) => f.form === 'SPQ').map(({ from_scan, issue, original_issue, ...f }) => ({ ...f, issue: f.item === '6G' ? undefined : 'yes_no_explanation' }));
ok('digital: nothing is routed away', M.routeUnconfirmedFlags(digital).scanUnconfirmed.length, 0);

// An FHDS whose 3A itself is blank is a real defect and keeps its chase.
const blank3A = [{ form: 'FHDS', item: 'Section 3', issue: 'unanswered', reason: '3A is not checked (neither IS nor IS NOT), and no 3C option is selected' }];
ok('FHDS with 3A unmarked is still chased', M.routeUnconfirmedFlags(blank3A).fhdsDefault.length, 0);
const wholeSection = [{ form: 'FHDS', item: 'Section 3', issue: 'unanswered', reason: 'Section 3 is not completed' }];
ok('"Section 3 not completed" with no 3B/3C claim is still chased', M.routeUnconfirmedFlags(wholeSection).fhdsDefault.length, 0);
// Other tags are left alone.
const tagged = [scanned({ form: 'TDS', item: 'C1', issue: 'cited_attachment_unseen', reason: 'see attached' })];
ok('an already-routed flag is not double-routed', M.routeUnconfirmedFlags(tagged).scanUnconfirmed.length, 0);

// A blank WRITTEN field off a scan stays in the chase (1747 Haynes TDS date).
{
  const haynes = [
    scanned({ form: 'TDS', item: 'disclosure date', issue: 'unanswered', reason: 'the disclosure date near the top of page 1 is left blank' }),
    scanned({ form: 'SPQ', item: '7D', issue: 'yes_no_explanation', reason: '7D (painted within the past 12 months) is marked Yes but the item 7 explanation addresses only alterations and repairs, not painting' }),
    scanned({ form: 'SPQ', item: '13B(1)', issue: 'unanswered', reason: 'sprinklers are marked Yes but neither automatic nor manually operated is checked' }),
  ];
  const hr = M.routeUnconfirmedFlags(haynes);
  ok('haynes: the blank TDS date stays in the chase', hr.scanUnconfirmed.map(ref), ['SPQ 7D', 'SPQ 13B(1)']);
  const blankBox = [scanned({ form: 'SPQ', item: '9A', issue: 'unanswered', reason: 'neither Yes nor No is checked, the box is left blank' })];
  ok('a blank CHECKBOX on a scan still goes to VERIFY', M.routeUnconfirmedFlags(blankBox).scanUnconfirmed.length, 1);
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall scan/FHDS routing checks pass');
