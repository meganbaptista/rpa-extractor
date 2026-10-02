// checks/chase-voice.js
//
// The intake's chase lines read like a coordinator wrote them, and one fact is
// one line.   node checks/chase-voice.js
//
// 2781 Westshire (2026-10-02): seven lines each read "Marked No; however, the
// property is in a homeowners association (...). The response should be revised
// to Yes." and the listing agent replied "Is she putting this through AI or
// something?". Placeholder association name below.

const M = require('../netlify/functions/disclosure-intake-check-background.js')._internal;

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

const hoa = 'the property is in a homeowners association (Example Hills Homeowners Association)';
const auth = 'the HOA has authority over the property so governing documents exist';
const mk = (form, item, reason) => ({ form, item, marked: 'No', should_be: 'Yes', reason });
const flags = [
  { form: 'TDS', item: 'II A 220 Volt Wiring', issue: 'detail_incomplete', reason: 'the location is left blank; please specify it or mark Unknown.' },
  mk('TDS', 'C12', hoa), mk('TDS', 'C14', hoa), mk('SPQ', '6G', hoa), mk('SPQ', '14A', hoa), mk('SPQ', '14C', hoa),
  mk('SPQ', '14D', auth), mk('SPQ', '14F', auth),
];
const lines = M.groupReviseLines(flags);
ok('seven HOA lines become two, the blank keeps its own', lines.length, 3);
ok('the grouped line names every item, by form',
  lines[1].startsWith('TDS C12 and C14, and SPQ 6G, 14A and 14C are marked No, but the property is in a homeowners association'), true);
ok('it asks, in one sentence', lines[1].endsWith('Could you update those to Yes?'), true);
ok("the model's own trailing \"please ...\" is not doubled",
  lines[0], 'TDS II A 220 Volt Wiring: the location is left blank. Could you fill that in, or mark it Unknown?');
ok('no robotic boilerplate anywhere', lines.some((l) => /however|should be revised/i.test(l)), false);
ok('a lone mismatch reads naturally',
  M.reviseLineFor(mk('SPQ', '6G', 'the property is a condominium')),
  'SPQ 6G is marked No, but the property is a condominium. Could you update it to Yes?');
ok('different requested answers never share a line',
  M.groupReviseLines([mk('SPQ', '1', 'x'), { ...mk('SPQ', '2', 'x'), should_be: 'Unknown' }]).length, 2);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall chase-voice checks pass');
