// checks/schoolcraft-rules.js
//
// 20701 Schoolcraft (2026-10-23): two items were chased while they sat in the email.
//   - "6 of 6 - Homeowner's Guide - Signature.pdf" was skipped by name as the
//     booklet, so the Earthquake Booklet Receipt was never seen.
//   - "NHD_Stmnt.pdf" was identified as "NHD Receipt" (the signature page) and
//     her "NHD Statement" line did not count it.
//   node checks/schoolcraft-rules.js

const I = require('../netlify/functions/disclosure-intake-check-background.js')._internal;
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

ok('booklet signature page is read', I.isBlockedName("6 of 6 - Homeowner's Guide - Signature.pdf"), false);
ok('"6_of_6" spelling is read too', I.isBlockedName("6_of_6 Homeowners Guide.pdf"), false);
ok('the booklet itself is still skipped', I.isBlockedName("Homeowner's Guide to Earthquake Safety.pdf"), true);
ok('"1 of 6" booklet still skipped', I.isBlockedName('1 of 6 - Environmental Hazards Booklet.pdf'), true);

const r = () => ({ still_needed: ['NHD Statement', 'Earthquake Booklet Receipt', 'SBSA'], present: [] });
const a = r(); I.applyNhdStatementRule(a, [{ code: '', name: 'NHD Receipt' }]);
ok('NHD Receipt (signature page) satisfies "NHD Statement"', a.still_needed.join(), 'Earthquake Booklet Receipt,SBSA');
ok('and it is listed as present', a.present.join(), 'NHD Statement');
const b = r(); I.applyNhdStatementRule(b, [{ code: '', name: 'Natural Hazard Disclosure Statement' }]);
ok('a page titled Natural Hazard Disclosure Statement satisfies it', b.still_needed.includes('NHD Statement'), false);
const c = r(); I.applyNhdStatementRule(c, [{ code: 'NHD', name: 'Natural Hazard Disclosure Report' }]);
ok('the full NHD report alone does NOT satisfy it', c.still_needed.includes('NHD Statement'), true);
const d = r(); I.applyNhdStatementRule(d, [{ code: 'TDS', name: 'Real Estate Transfer Disclosure Statement' }]);
ok('no NHD page = still needed', d.still_needed.includes('NHD Statement'), true);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall schoolcraft-rules checks pass');
process.exit(failed ? 1 : 0);
