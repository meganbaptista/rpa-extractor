// checks/counter-chain.js
//
// Pins the counter-chain consistency check without a PDF or a model.
//   node checks/counter-chain.js
//
// The first case is the shape of the packet that made this check exist
// (10724 Wilshire #803, 2026-09-30), with PLACEHOLDER names: an SMCO #1
// written to a different buyer's offer, dated a day before this RPA, and a
// BCO #1 countering an SMCO #1 dated days later - the right one, absent. The
// audit transcribed all of it and still called the packet signature-complete.
// All three must be caught; a clean chain must produce nothing.

const { checkCounterChain, applyCounterChain, _internal } = require('../netlify/functions/lib/counter-chain.js');
const { isoDate, sameParty, propertyKey, counterRef } = _internal;

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}
const issues = (r) => r.findings.map((f) => `${f.location}: ${f.issue}`);

// ---- pieces -------------------------------------------------------------
ok('date: 09/18/2026', isoDate('09/18/2026'), '2026-09-18');
ok('date: 9/18/26', isoDate('9/18/26'), '2026-09-18');
ok('date: September 19, 2026', isoDate('September 19, 2026'), '2026-09-19');
ok('date: Sept 23 2026', isoDate('Sept 23 2026'), '2026-09-23');
ok('date: BLANK', isoDate('BLANK'), null);

ok('party: same people, other order', sameParty('Alex Rivera, Jordan Kim', 'Jordan Kim and Alex Rivera'), true);
ok('party: trust vs trustee', sameParty('Robin Q. Doe Living Trust (2/8/2000)', 'Robin Q Doe, Trustee'), true);
ok('party: one of two buyers named', sameParty('Alex Rivera, Jordan Kim', 'Alex Rivera'), true);
ok('party: and/or assignee', sameParty('Alex Rivera', 'Alex Rivera and/or Assignee'), true);
ok('party: a stranger trust', sameParty('Alex Rivera, Jordan Kim', 'The Casey Stranger Living Trust'), false);
ok('party: "Living Trust" alone is not a match', sameParty('The Pat Q Living Trust', 'The Casey Stranger Living Trust'), false);

ok('property: Boulevard vs Blvd, unit', propertyKey('100 Example Boulevard, Los Angeles, CA 90024'), propertyKey('100 Example Blvd #803, Los Angeles'));
ok('property: different street', propertyKey('100 Example Blvd') === propertyKey('100 Other Ave'), false);

ok('ref: Purchase Agreement', counterRef('Purchase Agreement').form, 'RPA');
ok('ref: SMCO No. 1', counterRef('Seller Multiple Counter Offer No. 1'), { form: 'SMCO', number: '1' });
ok('ref: SCO #2', counterRef('Seller Counter Offer No. 2'), { form: 'SCO', number: '2' });
ok('ref: BCO No. 1', counterRef('Buyer Counter Offer No. 1'), { form: 'BCO', number: '1' });

// ---- the Wilshire shape -------------------------------------------------
const rpa = {
  date_prepared: 'September 19, 2026',
  buyer: 'Alex Rivera, Jordan Kim',
  seller: 'Sam Seller',
  property: '100 Example Boulevard, Los Angeles, CA 90024',
};
const wilshire = {
  rpa,
  counters: [
    {
      form: 'BCO', number: '1', packet_position: 1, date: 'September 24, 2026',
      counters: 'Seller Multiple Counter Offer No. 1', dated: 'September 23, 2026',
      property: '100 Example Boulevard, Los Angeles, CA 90024', buyer: 'Alex Rivera, Jordan Kim', seller: 'Sam Seller',
    },
    {
      form: 'SMCO', number: '1', packet_position: 2, date: '09/18/2026',
      counters: 'Purchase Agreement', dated: '09/18/2026',
      property: '100 Example Blvd 803, Los Angeles, CA 90024', buyer: 'The Casey Stranger Living Trust', seller: 'Sam Seller',
    },
  ],
};
const w = checkCounterChain(wilshire);
ok('wilshire: exactly three flags', w.findings.length, 3);
ok('wilshire: flags', issues(w).sort(), [
  "BCO #1 header: \"Dated\" does not match SMCO #1's date",
  "SMCO #1 header: \"Dated\" does not match the RPA's Date Prepared",
  "SMCO #1 header: Buyer on the counter is not the RPA's buyer",
].sort());
ok('wilshire: action lines match findings', w.actions.length, 3);
ok('wilshire: no em dashes in action lines', w.actions.some((a) => /[—–]/.test(a)), false);

// The run WITHOUT the SMCO: BCO #1 counters an SMCO that is not there.
const noSmco = checkCounterChain({ rpa, counters: [wilshire.counters[0]] });
ok('no smco: the missing counter is flagged', issues(noSmco), ['BCO #1 header: Counters SMCO #1, which is not in the packet']);

// A clean chain: SCO #1 counters the RPA, BCO #1 counters SCO #1, all agree.
const clean = checkCounterChain({
  rpa,
  counters: [
    { form: 'BCO', number: '1', date: '09/22/2026', counters: 'Seller Counter Offer No. 1', dated: '9/21/2026', property: '100 Example Blvd', buyer: 'Jordan Kim and Alex Rivera', seller: 'Sam Seller' },
    { form: 'SCO', number: '1', date: 'September 21, 2026', counters: 'Purchase Agreement', dated: '09/19/2026', property: '100 Example Boulevard', buyer: 'Alex Rivera, Jordan Kim', seller: 'Sam Seller' },
  ],
});
ok('clean chain: nothing flagged', clean.findings, []);

// A BLANK field is N2's finding already: not reported twice here.
const blanks = checkCounterChain({ rpa, counters: [{ form: 'SCO', number: '1', date: 'BLANK', counters: 'Purchase Agreement', dated: 'BLANK', property: 'BLANK', buyer: 'BLANK', seller: 'BLANK' }] });
ok('blank fields: left to N2', blanks.findings, []);

// Wrong property.
const wrongProperty = checkCounterChain({ rpa, counters: [{ form: 'SCO', number: '1', date: '9/20/2026', counters: 'Purchase Agreement', dated: '9/19/2026', property: '200 Other Avenue', buyer: 'Alex Rivera', seller: 'Sam Seller' }] });
ok('wrong property: flagged', issues(wrongProperty), ["SCO #1 header: Property on the counter is not the RPA's property"]);

// ---- folded into the audit ---------------------------------------------
const part = {
  prose: 'The packet is signature-complete.',
  structured: { overall_status: 'complete', summary: 'Signature-complete.', findings: [], action_items: [], transcription: wilshire },
};
applyCounterChain(part);
ok('applied: status is issues_found', part.structured.overall_status, 'issues_found');
ok('applied: summary leads with the chain problem', part.structured.summary.startsWith('Counter chain problem:'), true);
ok('applied: findings first', part.structured.findings.length, 3);
ok('applied: action items', part.structured.action_items.length, 3);
ok('applied: prose shows the check', part.prose.includes('## Counter chain check'), true);

const cleanPart = { prose: 'ok', structured: { overall_status: 'complete', summary: 'Clean.', findings: [], action_items: [], transcription: { rpa, counters: [] } } };
applyCounterChain(cleanPart);
ok('applied, no counters: untouched', [cleanPart.structured.overall_status, cleanPart.prose], ['complete', 'ok']);
ok('applied, unparsed audit: no crash', applyCounterChain({ prose: 'x', structured: null }).findings, []);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall counter-chain checks pass');
