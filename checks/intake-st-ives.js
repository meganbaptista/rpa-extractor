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

// 3. The deal's side: a deal closing next year is on next year's tab ("it wasnt syncing any deals that close in 2027").
const S = require('../netlify/functions/lib/deal-side.js')._internal;
const y = new Date().getFullYear();
ok("next year's tab is read", S.targetTabs([String(y - 1), String(y), String(y + 1)]).includes(String(y + 1)), true);
ok('this year and last still read', S.targetTabs([String(y - 1), String(y)]).length, 2);

// 4. Keeva answers the side first (2026-11-05: "should we move it somewhere else?").
(async () => {
  const KA = require('../netlify/functions/lib/keeva-audit.js');
  const store = { get: async () => ({ key: 'k', url: 'https://keeva.example/.netlify/functions/audit-result' }) };
  const realFetch = global.fetch;
  let asked = '';
  global.fetch = async (url, opts) => { asked = `${url} ${opts.headers['x-keeva-audit-key']}`; return { ok: true, json: async () => ({ side: 'buyer' }) }; };
  ok('Keeva says buyer', await KA.keevaSide(store, '8855 St. Ives Drive'), 'buyer');
  ok('asked deal-side with the key', asked, 'https://keeva.example/.netlify/functions/deal-side?address=8855%20St.%20Ives%20Drive k');
  global.fetch = async () => ({ ok: true, json: async () => ({ side: null }) });
  ok('Keeva has no deal: null (the sheet decides)', await KA.keevaSide(store, '1 Nowhere'), null);
  ok('no key: not asked', await KA.keevaSide({ get: async () => null }, '1 Main'), null);
  global.fetch = realFetch;
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall St. Ives checks pass');
  process.exit(failed ? 1 : 0);
})();
