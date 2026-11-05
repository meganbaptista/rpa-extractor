// checks/intake-st-ives.js
//
// 8855 St. Ives Drive (Megan, 2026-11-05):
//  1. "Homeowner's Guide to Earthquake Safety (form).pdf" was the Residential
//     Earthquake Risk Disclosure Statement, skipped unread by its booklet name,
//     then asked for. A "(form)" name, or a booklet-named file of a few pages,
//     is read; the real 40+ page booklets are still skipped.
//  2. "TDS C8: SPQ 10A discloses garage water intrusion. Recommend revising to
//     Yes." C8 asks about flooding, drainage or grading; a leak is not that.
//   node checks/intake-st-ives.js
const I = require('../netlify/functions/disclosure-intake-check-background.js')._internal;
let failed = 0;
const ok = (label, got, want) => { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); };

ok('the form under the booklet name is read', I.isBlockedName("Homeowner's Guide to Earthquake Safety (form).pdf", 0), false);
ok('a 2-page booklet-named file is read', I.isBlockedName("Homeowner's Guide to Earthquake Safety.pdf", 2), false);
ok('the real booklet is still skipped', I.isBlockedName("4 – Homeowner's Guide to Earthquake Safety (pamphlet).pdf", 48), true);
ok('booklet length unknown: skipped', I.isBlockedName('1 – Residential Environmental Hazards – 01_2011.pdf', 0), true);
ok('an inspection is still skipped', I.isBlockedName('Home Inspection Report.pdf', 3), true);

const c8 = (reason) => I.c8WithoutItsSubject({ form: 'TDS', item: 'C8', issue: 'answer_contradicts_package', reason });
ok('a leak is not C8', c8('SPQ 10A discloses garage water intrusion from the upper deck and an a/c unit leak'), true);
ok('flooding is C8', c8('SPQ 10A discloses flooding in the backyard'), false);
ok('drainage is C8', c8('SPQ 10A notes standing water and drainage toward the garage'), false);
ok('other items untouched', I.c8WithoutItsSubject({ form: 'TDS', item: 'C9', issue: 'answer_contradicts_package', reason: 'a leak' }), false);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall St. Ives checks pass');
process.exit(failed ? 1 : 0);
