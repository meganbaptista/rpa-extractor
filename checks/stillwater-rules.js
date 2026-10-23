// checks/stillwater-rules.js
//
// Two of Megan's standing rules that slipped through on 5733 E Stillwater Ave
// #2 (2026-10-23) because the review worded the finding differently:
//   - TDS Section II B vs SPQ 8A is never chased ("a bit too nit picky"); the
//     review wrote "TDS B", without "II".
//   - 17F/17G brush clearance on a condo is never chased; the review compared
//     17G with the FHDS instead of the fire-zone map.
//   node checks/stillwater-rules.js

const I = require('../netlify/functions/disclosure-intake-check-background.js')._internal;
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

const tdsB = { form: 'TDS', item: 'B', issue: 'answer_contradicts_package', discrepancy_type: 'inconsistent', marked: 'No', other_form: 'SPQ', reason: 'On SPQ 8A the seller discloses an exterior crack near the balcony door frame and a leak from the master bedroom shower pan' };
ok('"TDS B" vs SPQ 8A is not chased', I.isMirrorDefectMismatch(tdsB), true);
ok('"TDS II B" vs SPQ 8A still not chased', I.isMirrorDefectMismatch({ ...tdsB, item: 'II B' }), true);
ok('"TDS Section B" vs SPQ 8A not chased', I.isMirrorDefectMismatch({ ...tdsB, item: 'Section B' }), true);
ok('TDS C2 vs SPQ 15D IS still chased', I.isMirrorDefectMismatch({ ...tdsB, item: 'C2', reason: 'On SPQ 15D shared walls' }), false);

const g17 = { form: 'SPQ', item: '17G', issue: 'answer_contradicts_package', discrepancy_type: 'inconsistent', marked: 'No', other_form: 'FHDS', reason: 'On FHDS Section 3A the seller indicates the property IS subject to a local vegetation management ordinance' };
ok('17G vs FHDS on a condo -> CHECK BEFORE SENDING', I.isCondoBrushFlag(g17, true), true);
ok('17F (12/24 SPQ) on a condo too', I.isCondoBrushFlag({ ...g17, item: '17F' }, true), true);
ok('17G on a house is still chased', I.isCondoBrushFlag(g17, false), false);
ok('another SPQ item on a condo is untouched', I.isCondoBrushFlag({ ...g17, item: '14F' }, true), false);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall stillwater-rules checks pass');
process.exit(failed ? 1 : 0);
