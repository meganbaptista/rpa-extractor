// checks/addendum-sections.js
//
// A TDS overflow entry that names its own section ("1) II.B.") explains that
// section, not Section C.   node checks/addendum-sections.js
// 10423 Oletha (2026-10-22): four TDS Section B defects were chased as
// unexplained while TOA No. 1 entry "1) II.B. Explanation of Defects" covered them.

const { validateAddendumFlags } = require('../netlify/functions/disclosure-intake-check-background.js')._internal;

let failed = 0;
function ok(label, got, want) {
  if (got !== want) { failed++; console.error(`FAIL  ${label}\n      got  ${got}\n      want ${want}`); }
  else console.log(`pass  ${label}`);
}
const oletha = [
  { form: 'TDS', item: '1', text: 'II.B. Explanation of Defects: Foundation: I believe there are notes in the foundation report' },
  { form: 'TDS', item: 'C. 1', text: 'As per our reports, there is lead based paint in the kitchen sink' },
  { form: 'TDS', item: 'C. 2', text: 'Western driveway wall is shared in common' },
  { form: 'TDS', item: 'C', text: 'Much of our knowledge of the property comes from inspections' },
];
const fl = (form, item, cite) => validateAddendumFlags([{ form, item, issue: 'explanation_on_addendum', addendum_item: cite, reason: 'x' }], oletha)[0].issue;

ok('TDS B cited as "1" (entry labelled II.B.) is explained', fl('TDS', 'B Foundation', '1'), 'explanation_on_addendum');
ok('TDS B cited as "1)"', fl('TDS', 'B Walls/Fences', '1)'), 'explanation_on_addendum');
ok('TDS B cited as "II.B"', fl('TDS', 'B Electrical Systems', 'II.B'), 'explanation_on_addendum');
ok('TDS C1 cited "C. 1" still explained', fl('TDS', 'C1', 'C. 1'), 'explanation_on_addendum');
ok('TDS C9 cannot borrow C. 1 (Chautauqua line rule kept)', fl('TDS', 'C9', 'C. 1'), 'yes_no_explanation');
ok('TDS B cannot borrow a Section C entry', fl('TDS', 'B Roof', 'C. 2'), 'yes_no_explanation');

// 8 Willow Way: an SPQ sub-item may not borrow another item's entry.
const spq = validateAddendumFlags([{ form: 'SPQ', item: '6G', issue: 'explanation_on_addendum', addendum_item: '5', reason: 'x' }],
  [{ form: 'SPQ', item: '5', text: 'a' }, { form: 'SPQ', item: '7', text: 'b' }])[0].issue;
ok('SPQ 6G cannot borrow entry 5 (Willow Way rule kept)', spq, 'yes_no_explanation');
// A bare TDS number with no section in its text still means Section C (Chautauqua).
const chaut = validateAddendumFlags([{ form: 'TDS', item: 'C4', issue: 'explanation_on_addendum', addendum_item: 'Line 4 & 5', reason: 'x' }],
  [{ form: 'TDS', item: 'Line 4 & 5', text: 'water damage in 2019' }])[0].issue;
ok('TDS "Line 4 & 5" still explains C4 (Chautauqua rule kept)', chaut, 'explanation_on_addendum');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall addendum-sections checks pass');
process.exit(failed ? 1 : 0);
