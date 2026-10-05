// checks/router-completed-disclosures.js
//
// A DocuSign "Completed:" disclosure envelope routes by side, no model call.
//   node checks/router-completed-disclosures.js
//
// 11922 Sunshine (2026-10-04): "Completed: 11922 Sunshine MCA, SBSA", buyer
// side per the deal list, went to Needs Attention (classifier: Jill @0.55).

const C = require('../netlify/functions/lib/routing-config.js');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}
const who = (subject, side) => { const r = C.personForCompletedDisclosure(subject, side); return r ? r.person : null; };

ok('sunshine: buyer side -> Edelyn', who('Completed: 11922 Sunshine MCA, SBSA', 'buyer'), 'Edelyn');
ok('seller side -> Ethan', who('Completed: 11922 Sunshine MCA, SBSA', 'seller'), 'Ethan');
ok('unknown side -> classifier', who('Completed: 11922 Sunshine MCA, SBSA', null), null);
ok('forwarded still counts', who('Fwd: Completed: 4725 Vanalden TDS SPQ FHDS', 'buyer'), 'Edelyn');
ok('side-qualified codes', who('Completed: 123 Elm LA AVID, AVID-BA', 'seller'), 'Ethan');
ok('a repair request is NOT a disclosure', who('Completed: 123 Elm RR', 'buyer'), null);
ok('disclosures mixed with an addendum -> classifier', who('Completed: 123 Elm SBSA, ADM', 'buyer'), null);
ok('the RPA packet -> classifier', who('Completed: 123 Elm RPA, BIA, WFA', 'buyer'), null);
ok('RFR is ambiguous -> classifier', who('Completed: 123 Elm RFR', 'buyer'), null);
ok('an all-caps street word -> classifier (safe)', who('Completed: 123 MAIN ST TDS', 'buyer'), null);
ok('not a Completed: subject', who('11922 Sunshine MCA, SBSA', 'buyer'), null);
ok('a Voided envelope is not completed', who('Voided: 11922 Sunshine MCA, SBSA', 'buyer'), null);
ok('no codes at all', who('Completed: 11922 Sunshine Avenue documents', 'buyer'), null);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall completed-disclosure routing checks pass');
