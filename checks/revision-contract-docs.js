// checks/revision-contract-docs.js
//
// 20701 Schoolcraft (2026-10-26): the FHDA came back with the seller's
// signature in a revision reply and went to the buyers inside the revised
// disclosures. Purchase-agreement documents are filed FX, never sent as a
// disclosure update; counter offers are never attached.
//   node checks/revision-contract-docs.js

const rc = require('../netlify/functions/lib/revision-check.js');
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

ok('FHDA file is a contract document', rc.contractCode({ name: 'FHDA.pdf', forms: [] }), 'FHDA');
ok('by its form title too', rc.contractCode({ name: 'scan.pdf', forms: ['FAIR HOUSING AND DISCRIMINATION ADVISORY'] }), 'FHDA');
ok('wire fraud advisory', rc.contractCode({ name: 'x.pdf', forms: ['WIRE FRAUD AND ELECTRONIC FUNDS TRANSFER ADVISORY'] }), 'WFA');
ok('a counter offer', rc.contractCode({ name: 'SMCO2 need B signature.pdf', forms: [] }), 'COUNTER');
ok('buyer counter offer by title', rc.contractCode({ name: 'x.pdf', forms: ['BUYER COUNTER OFFER No. 2'] }), 'COUNTER');
ok('TDS is not', rc.contractCode({ name: 'Real_Estate_Transfer_Disclosure_Statement__1.pdf', forms: ['TDS'] }), '');
ok('local area disclosure is not', rc.contractCode({ name: 'San_Fernando_Valley_Local_Area_Disclosure_and_Advisory_-_6_26.pdf', forms: [] }), '');
ok('"CO detector" is not a counter offer', rc.contractCode({ name: 'Water-Conserving Plumbing Fixtures and CO Detector Notice.pdf', forms: ['WCMD'] }), '');
ok('SPQ is not', rc.contractCode({ name: 'Seller_Property_Questionnaire__1.pdf', forms: ['SPQ'] }), '');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall revision-contract-docs checks pass');
process.exit(failed ? 1 : 0);
