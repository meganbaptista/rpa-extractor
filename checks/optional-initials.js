// checks/optional-initials.js
//
// Pins the paragraph 29 / 31 all-or-none initials check without a PDF or a
// model.   node checks/optional-initials.js
//
// The first case is the shape of 3131 Michelson Dr #406 (2026-11-21), with
// placeholder initials: the seller initialed Arbitration of Disputes, both
// buyer boxes blank, and the second audit called it "a valid election".

const { checkOptionalInitials, applyOptionalInitials } = require('../netlify/functions/lib/optional-initials.js');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}
const t = (ld, arb) => ({ rpa: { optional_initials: { liquidated_damages: ld, arbitration: arb } } });
const two = { buyerCount: 2, sellerCount: 1 };
const issues = (r) => r.findings.map((f) => `${f.location}: ${f.issue}`);

// Michelson: LD all initialed, arbitration seller only.
const michelson = t({ buyer: ['AB', 'AB'], seller: ['CD'] }, { buyer: ['BLANK', 'BLANK'], seller: ['CD'] });
ok('seller-only arbitration is flagged', issues(checkOptionalInitials(michelson, two)),
  ['RPA paragraph 31 Arbitration of Disputes: Buyer initials missing while another party initialed']);

ok('nobody initialed either: nothing', issues(checkOptionalInitials(t({ buyer: ['BLANK', 'BLANK'], seller: ['BLANK'] }, { buyer: ['', ''], seller: ['[ ]'] }), two)), []);
ok('everyone initialed both: nothing', issues(checkOptionalInitials(t({ buyer: ['AB', 'EF'], seller: ['CD'] }, { buyer: ['AB', 'EF'], seller: ['CD'] }), two)), []);
ok('one of two buyers initialed LD: flagged', issues(checkOptionalInitials(t({ buyer: ['AB', 'BLANK'], seller: ['CD'] }, { buyer: ['BLANK', 'BLANK'], seller: ['BLANK'] }), two)),
  ['RPA paragraph 29 Liquidated Damages: Buyer initials missing while another party initialed']);
ok('buyers only, seller blank: flagged as Seller', issues(checkOptionalInitials(t(null, { buyer: ['AB', 'EF'], seller: ['BLANK'] }), two)),
  ['RPA paragraph 31 Arbitration of Disputes: Seller initials missing while another party initialed']);
ok('one buyer: the unused second box is not judged', issues(checkOptionalInitials(t({ buyer: ['AB', 'BLANK'], seller: ['CD'] }, null), { buyerCount: 1, sellerCount: 1 })), []);
ok('no transcription: nothing', issues(checkOptionalInitials({ rpa: {} }, two)), []);

// apply: adds when the model said nothing, sets issues_found, no duplicate.
const quiet = { prose: 'p', structured: { overall_status: 'complete', summary: 'Packet is fully signed.', findings: [], action_items: [], transcription: michelson } };
applyOptionalInitials(quiet, two);
ok('apply: status issues_found', quiet.structured.overall_status, 'issues_found');
ok('apply: one finding, one action', [quiet.structured.findings.length, quiet.structured.action_items.length], [1, 1]);
ok('apply: summary leads with it', quiet.structured.summary.startsWith('RPA paragraph 31 Arbitration of Disputes'), true);

const flagged = { prose: 'p', structured: { overall_status: 'issues_found', summary: 's', transcription: michelson,
  findings: [{ location: 'RPA p15, paragraph 31 Arbitration of Disputes', issue: 'Buyer initials missing while Seller has initialed', severity: 'missing', detail: 'd' }], action_items: ['a'] } };
applyOptionalInitials(flagged, two);
ok('apply: model already flagged it, no duplicate', [flagged.structured.findings.length, flagged.structured.action_items.length, flagged.structured.summary], [1, 1, 's']);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
