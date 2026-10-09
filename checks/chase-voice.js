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

// --- greeting: the sender's first name, never our own team ------------------
ok('greets the agent', M.greetName('Amy Ross'), ' Amy');
ok('accented names', M.greetName('José Ruiz'), ' José');
ok('never Megan', M.greetName('Megan Baptista'), '');
ok('never a router teammate (Edelyn)', M.greetName('Edelyn Biñas'), '');
ok('never an email address', M.greetName('amy@x.com'), '');

// --- Chautauqua: blank questions off a scan are chased, as one line ---------
{
  const u = (item, extra = {}) => ({ form: 'SPQ', item, issue: 'unanswered', reason: 'neither Yes nor No is checked', from_scan: true, pass_count: 2, pass_total: 2, ...extra });
  ok('three blank questions, one line', M.groupReviseLines([u('6A'), u('6B'), u('6K')]),
    ['SPQ 6A, 6B and 6K were left unanswered. Could the seller mark Yes or No on those?']);
  ok('a blank APN is not a Yes/No question', M.groupReviseLines([u('6A'), u('6B'), u('APN', { reason: 'the APN is left blank' })]).length, 2);
  const r = M.routeUnconfirmedFlags([u('6A'), u('6B', { pass_count: 1 }),
    { form: 'SPQ', item: '7A', issue: 'yes_no_explanation', from_scan: true, pass_count: 2, pass_total: 2 }]);
  ok('agreed blank and agreed unexplained Yes are chased; one-pass blank goes to VERIFY', r.scanUnconfirmed.map((f) => f.item), ['6B']);
  ok('a one-pass unexplained Yes still goes to VERIFY', M.routeUnconfirmedFlags([{ form: 'TDS', item: 'C9', issue: 'yes_no_explanation',
    from_scan: true, pass_count: 1, pass_total: 2 }]).scanUnconfirmed.length, 1);
}

// --- VERIFY items open the draft in a box she deletes (2026-10-09) -----------
{
  const box = M.checkBeforeSending([
    { item: 'SPQ 6G', note: 'Read off a scanned page, so check the mark. Both passes saw it.' },
    { item: 'SPQ 7 explanation', note: 'explanation found on a separate addendum (Seller Explanations); verify it covers this sub-item' },
  ]);
  ok('box text names each item with its first sentence', box.text.split('\n').slice(1, 3),
    ['- SPQ 6G: Read off a scanned page, so check the mark.',
     '- SPQ 7 explanation: explanation found on a separate addendum (Seller Explanations); verify it covers this sub-item']);
  ok('red plain lines, no box, with an end marker', /#c62828/.test(box.html) && !/<div/.test(box.html) && /delete through here/.test(box.html), true);
  ok('no VERIFY items, no box', M.checkBeforeSending([]), { text: '', html: '' });
}

// --- TDS "Line N" citations match Section C (931 Chautauqua) ---------------
{
  const entries = [{ form: 'TDS', item: 'Line 1', text: 'radon' }, { form: 'TDS', item: 'Line 4 & 5', text: 'permits' },
    { form: 'TDS', item: 'Line 11', text: 'wildfire' }];
  const v = (item, addendum_item) => M.validateAddendumFlags([{ form: 'TDS', item, issue: 'explanation_on_addendum', addendum_item }], entries)[0].issue;
  ok('TDS C1 cited "Line 1" is explained', v('C1', 'Line 1'), 'explanation_on_addendum');
  ok('TDS C5 cited "Line 4 & 5" is explained', v('C5', 'Line 4 & 5'), 'explanation_on_addendum');
  ok('TDS C9 cannot borrow "Line 4 & 5"', v('C9', 'Line 4 & 5'), 'yes_no_explanation');
  ok('SPQ entry 5 still cannot explain 6G',
    M.validateAddendumFlags([{ form: 'SPQ', item: '6G', issue: 'explanation_on_addendum', addendum_item: '5' }],
      [{ form: 'SPQ', item: '5', text: 'x' }])[0].issue, 'yes_no_explanation');
}

// --- TDS Section III goes to the agent when both reads agree ---------------
{
  const f = { form: 'TDS', item: 'Section III', issue: 'verify_mismatch', from_scan: true, pass_count: 2, pass_total: 2,
    reason: "Section III has none of its three boxes checked; please have the listing agent complete it" };
  ok('agreed Section III is chased', M.routeUnconfirmedFlags([f]).scanUnconfirmed.length, 0);
  ok('one-pass Section III stays in the check list', M.routeUnconfirmedFlags([{ ...f, pass_count: 1 }]).scanUnconfirmed.length, 1);
  ok('Section III asks for a box', M.reviseLineFor(f),
    'TDS Section III (Agent\'s Inspection Disclosure): none of the boxes are checked. Could the listing agent check one (usually "See attached AVID")?');
  ok('and a signature when it is unsigned', /sign and date it\?$/.test(M.reviseLineFor({ ...f, reason: 'no box checked and the agent signature is blank' })), true);
}

// --- SPQ 7E (built before 1978) Yes is never chased for an explanation ------
ok('SPQ 7E Yes needs no explanation (Haynes wording)', M.isFactOnlyYes({ form: 'SPQ', item: '7E', issue: 'yes_no_explanation',
  reason: '7E (built before 1978) is marked Yes but no explanation is provided for it' }), true);
ok('SPQ 7E with 7E(1) Yes is still asked', M.isFactOnlyYes({ form: 'SPQ', item: '7E', issue: 'yes_no_explanation',
  reason: '7E is Yes and 7E(1) renovations is marked Yes, but no explanation is given' }), false);
ok('SPQ 7D still does', M.isFactOnlyYes({ form: 'SPQ', item: '7D', issue: 'yes_no_explanation' }), false);
ok('a blank 7E(1) is still asked', M.isFactOnlyYes({ form: 'SPQ', item: '7E(1)', issue: 'unanswered' }), false);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall chase-voice checks pass');
