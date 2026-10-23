// checks/revise-wording.js
//
// The agent-facing correction lines (reviseLineFor). 2647 E Wilson (2026-10-23)
// produced "SOLAR 1C is marked Yes ... Could you update it to Yes?", "SOLAR
// 3B(1) is marked 5/2018 ... update it to Yes?" and "SPQ 7F is marked No, but
// 7F is marked No, yet ...". checks/lib/wilson-flags.json holds those three
// findings as the review returned them (form wording only, no seller data).
//   node checks/revise-wording.js

const I = require('../netlify/functions/disclosure-intake-check-background.js')._internal;
const [c1, f7, b31] = require('./lib/wilson-flags.json');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}
const line = (f) => I.reviseLineFor(f);

ok('SOLAR 1C (an age, not a Yes/No) asks to confirm, never "update it to Yes"', [/update it to Yes/.test(line(c1)), /confirm or correct/.test(line(c1))], [false, true]);
ok('SOLAR 1C does not claim a mark the field cannot have', /is marked Yes/.test(line(c1)), false);
ok('SOLAR 3B(1) (a date) asks to confirm', [/update it to Yes/.test(line(b31)), /confirm or correct/.test(line(b31))], [false, true]);
ok('SPQ 7F does not repeat "7F is marked No"', (line(f7).match(/marked No/g) || []).length <= 1, true);
ok('SPQ 7F (follow-up under a No) is routed to CHECK BEFORE SENDING', I.isOrphanFollowUp(f7), true);
ok('1C and 3B(1) are not orphan follow-ups', [I.isOrphanFollowUp(c1), I.isOrphanFollowUp(b31)], [false, false]);

const f = (o) => ({ issue: 'answer_contradicts_package', form: 'SPQ', ...o });
ok('a real Yes fix still names it (7E, built 1960)', line(f({ item: '7E', discrepancy_type: 'incorrect', marked: 'No', should_be: 'Yes', reason: 'the property was built in 1960' })), 'SPQ 7E is marked No, but the property was built in 1960. Could you update it to Yes?');
ok('a document in the package still means Yes (6K + WBSA)', /Could you update it to Yes\?$/.test(line(f({ item: '6K', discrepancy_type: 'document', marked: 'No', should_be: '', document: 'a WBSA', reason: 'a WBSA was provided' }))), true);
ok('a No fix is named too', /update it to No\?$/.test(line(f({ item: '7E', discrepancy_type: 'incorrect', marked: 'Yes', should_be: 'No', reason: 'the property was built in 1985' }))), true);
ok('no fix named -> confirm, not a guessed Yes', /confirm or correct it\?$/.test(line(f({ item: '13E', discrepancy_type: 'incorrect', marked: 'No', should_be: '', reason: 'the inspection notes a cracked pool tile' }))), true);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall revise-wording checks pass');
process.exit(failed ? 1 : 0);
