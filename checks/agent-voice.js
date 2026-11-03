// The agent email's answer lines in Megan's voice (2026-11-03, 533 Lincoln:
// "it needs to stop reading so AI"). Placeholder flags, no real deal data,
// no model call: the writer is replaced by a fake.
const assert = require('node:assert');
const V = require('../netlify/functions/lib/agent-voice');

const flags = [
  { form: 'SPQ', item: '5B', issue: 'answer_contradicts_package', marked: 'No', should_be: 'Yes', reason: 'reports in the package' },
  { form: 'SPQ', item: '5B', issue: 'answer_contradicts_package', marked: 'No', should_be: 'Yes', reason: 'the overflow addendum' },
  { form: 'SPQ', item: '15D', issue: 'answer_contradicts_package', marked: 'No', other_form: 'TDS C2', reason: 'shared walls' },
  { form: 'SPQ', item: '15D', issue: 'answer_contradicts_package', marked: 'No', reason: 'shared walls' },
  { form: 'TDS', item: 'C1', issue: 'yes_no_explanation', marked: 'Yes', reason: 'no explanation' },
  { form: 'NHD', item: '', issue: 'seller_signature_missing', reason: 'no signature' },
];
const one = V.onePerQuestion(flags);
assert.deepStrictEqual(one.map((f) => `${f.form} ${f.item}`.trim()), ['SPQ 5B', 'SPQ 15D', 'TDS C1', 'NHD'], 'one line per question');
assert.strictEqual(one[1].other_form, 'TDS C2', 'the TDS-vs-SPQ version is the one kept');

const fake = (reply) => async () => JSON.stringify(reply);
(async () => {
  const good = { lines: [
    { ids: ['q1'], text: 'SPQ 5B: Receipt for Reports received. Change to Yes.' },
    { ids: ['q2'], text: 'SPQ 15D: TDS C2 says shared walls. Change to Yes.' },
    { ids: ['q3'], text: 'TDS C1: add an explanation since the response was marked "Yes".' },
    { ids: ['q4'], text: 'NHD: seller signature missing. Sign and date.' },
  ] };
  assert.deepStrictEqual(await V.writeAsks(one, { call: fake(good) }), good.lines.map((l) => l.text));

  // A dropped question, a dash, a line that does not name its question: never used.
  const dropped = { lines: good.lines.slice(0, 3) };
  assert.strictEqual(await V.writeAsks(one, { call: fake(dropped) }), null, 'a question left out falls back');
  const dash = { lines: [{ ...good.lines[0], text: 'SPQ 5B — should be Yes.' }, ...good.lines.slice(1)] };
  assert.strictEqual(await V.writeAsks(one, { call: fake(dash) }), null, 'a dash falls back');
  const unnamed = { lines: [{ ids: ['q1'], text: 'That one should be Yes.' }, ...good.lines.slice(1)] };
  assert.strictEqual(await V.writeAsks(one, { call: fake(unnamed) }), null, 'every line names its questions');

  // Second try fixes the first: used.
  let n = 0;
  const flaky = async () => JSON.stringify(n++ ? good : dropped);
  assert.ok(await V.writeAsks(one, { call: flaky }), 'a corrected second answer is used');
  // Her line shape (2026-11-03): "SPQ 5B-C: we received ...". A range names its questions,
  // and may not reach a question that was never asked.
  const pair = [{ id: 'q1', question: 'SPQ 5B' }, { id: 'q2', question: 'SPQ 5C' }];
  assert.strictEqual(V.checkLines([{ ids: ['q1', 'q2'], text: 'SPQ 5B-C: Receipt for Reports received. Change to Yes.' }], pair), '');
  assert.ok(/5A, which was not asked/.test(V.checkLines([{ ids: ['q1', 'q2'], text: 'SPQ 5A-C: Receipt for Reports received. Change to Yes.' }], pair)));
  const tds = [{ id: 'q1', question: 'TDS C1', kind: 'yes_no_explanation' }];
  assert.ok(/must end/.test(V.checkLines([{ ids: ['q1'], text: 'TDS C1: add explanation.' }], tds)), 'the Yes reason is required');
  console.log('agent-voice: one line per question, every question kept, a bad answer never used');
})().catch((e) => { console.error(e); process.exit(1); });
