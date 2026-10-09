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
// 2026-10-09 (Westshire re-run): all seven now fold into ONE question, first.
ok('seven HOA lines become one question, the blank keeps its own', lines.length, 2);
ok('the HOA question names every item, by form', lines[0],
  'Is the Example Hills Homeowners Association a mandatory HOA? If so, TDS C12 and C14, and SPQ 6G, 14A, 14C, 14D and 14F should be marked Yes.');
ok("the model's own trailing \"please ...\" is not doubled",
  lines[1], 'TDS II A 220 Volt Wiring: the location is left blank. Could you fill that in, or mark it Unknown?');
ok('a single HOA line stays a normal line', M.groupReviseLines([mk('SPQ', '6G', hoa)]).length, 1);
ok('explanation on the wrong line says where, and suggests the fix',
  M.reviseLineFor({ form: 'SPQ', item: '7A', issue: 'explanation_misplaced', found_on: 'the item 8 explanation line' }),
  'SPQ 7A: the explanation is there, but it is written on the item 8 explanation line. Could the seller update it so it sits with 7A?');
ok('explanation under the wrong letter',
  M.reviseLineFor({ form: 'SPQ', item: '15E', issue: 'explanation_misplaced', found_on: 'labeled 15D' }),
  'SPQ 15E: the explanation is there, but it is labeled 15D. Could the seller update it so it sits with 15E?');
ok('no robotic boilerplate anywhere', lines.some((l) => /however|should be revised/i.test(l)), false);
ok('a lone mismatch reads naturally',
  M.reviseLineFor(mk('SPQ', '6G', 'the property is a condominium')),
  'SPQ 6G is marked No, but the property is a condominium. Could you update it to Yes?');
ok('different requested answers never share a line',
  M.groupReviseLines([mk('SPQ', '1', 'x'), { ...mk('SPQ', '2', 'x'), should_be: 'Unknown' }]).length, 2);

// --- an explanation that says WHAT happened is an answer (Westshire 11D) ----
const u = (reason) => M.wantsDetailOnly({ form: 'SPQ', item: '11D', issue: 'explanation_unclear', reason });
ok('11D "does not state when or which exterminator" is dropped',
  u("the explanation reads only 'rodent extermination by exterminator' and does not state when it occurred or which exterminator performed it"), true);
ok('no date / no company is dropped', u('explanation gives no date for the repair'), true);
ok('a truly unclear explanation stays', u('the explanation is illegible'), false);
ok('a contradiction stays', u('the explanation says no leaks, which contradicts the Yes'), false);
ok('only explanation_unclear is ever dropped',
  M.wantsDetailOnly({ issue: 'detail_incomplete', reason: 'does not state when' }), false);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall chase-voice checks pass');
