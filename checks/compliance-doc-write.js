// checks/compliance-doc-write.js
//
// Proves the Doc writer's index arithmetic without touching a real document.
//   node checks/compliance-doc-write.js
//
// This is the only code in the pipeline that edits a document a client and a
// TC both read, and the Docs API edits by CHARACTER POSITION: every edit moves
// everything after it. So the central test here does not check the requests
// look plausible - it BUILDS a fake document with real Docs-style indices,
// applies the generated requests to it exactly as the API would, and compares
// the resulting text to what the list should say. If the index maths is wrong
// the document comes out mangled and the assertion fails.

const docs = require('../netlify/functions/lib/docs.js');
const { planDoc, fileKey, OUTSTANDING } = require('../netlify/functions/lib/compliance-doc.js');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

/**
 * A document shaped the way the Docs API returns one.
 *
 * Body content starts at index 1 and a paragraph's endIndex includes its own
 * newline, so endIndex = startIndex + text.length + 1. Getting this fake wrong
 * would make the whole check meaningless, so it mirrors the API's own rule
 * rather than an assumption about it.
 */
function fakeDoc(lines) {
  const content = [{ sectionBreak: {}, startIndex: 0, endIndex: 1 }];
  let at = 1;
  for (const l of lines) {
    const text = typeof l === 'string' ? l : l.text;
    const bulleted = typeof l === 'string' ? /^\s*[-*•]\s+/.test(l) : !!l.bulleted;
    const end = at + text.length + 1;
    content.push({
      startIndex: at,
      endIndex: end,
      paragraph: {
        ...(bulleted ? { bullet: { listId: 'x' } } : {}),
        elements: [{ startIndex: at, endIndex: end, textRun: { content: `${text}\n` } }],
      },
    });
    at = end;
  }
  return { body: { content } };
}

/** The document as one string, the way the API's own indices address it. */
function flatten(doc) {
  let s = '\n';   // the section break occupies index 0
  for (const el of doc.body.content) {
    if (!el.paragraph) continue;
    s += el.paragraph.elements.map((e) => e.textRun.content).join('');
  }
  return s;
}

/** Apply requests the way the API does: in the order given, each on the result of the last. */
function apply(text, requests) {
  let s = text;
  const struck = [];
  for (const r of requests) {
    if (r.deleteContentRange) {
      const { startIndex, endIndex } = r.deleteContentRange.range;
      s = s.slice(0, startIndex) + s.slice(endIndex);
    } else if (r.insertText) {
      const { index } = r.insertText.location;
      s = s.slice(0, index) + r.insertText.text + s.slice(index);
    } else if (r.updateTextStyle) {
      // Styling changes no characters; record what it covered so the range can
      // be checked against the line it was meant to strike.
      const { startIndex, endIndex } = r.updateTextStyle.range;
      struck.push(s.slice(startIndex, endIndex));
    }
  }
  return { text: s, struck };
}

/** Everything the writer needs, from a list and the filenames in the folder. */
function run(lines, filenames, mode) {
  const doc = fakeDoc(lines);
  const { rows } = docs.paragraphsOf(doc);
  const plan = planDoc(docs.textForPlan(rows), filenames);
  const { requests, applied, error } = docs.requestsFor(plan.lines, rows, mode);
  if (error) return { error };
  return { ...apply(flatten(doc), requests), applied, plan, rows };
}

// A list shaped like Megan's, as Docs stores it: the bullets carry no "- "
// characters of their own.
const LIST = [
  'SELLER DISCLOSURES',
  { text: 'TDS - NB', bulleted: true },
  { text: 'SPQ - NB', bulleted: true },
  { text: 'AVID - NeedLA', bulleted: true },
  { text: 'WHSD - NB', bulleted: true },
  'BUYER ITEMS',
  { text: 'AB - NB', bulleted: true },
];

// --- the structural read ----------------------------------------------------
{
  const { rows, skipped } = docs.paragraphsOf(fakeDoc(LIST));
  ok('one row per paragraph, no section break', rows.length, LIST.length);
  ok('nothing was skipped', skipped, 0);
  ok('a paragraph carries no trailing newline in its text', rows[1].text, 'TDS - NB');
  // A Docs bullet is formatting, not characters, so the reconcile has to be
  // handed a "- " it can recognise - and line N must still be paragraph N.
  ok('bullets are restored for the reconcile, headings left alone',
    docs.textForPlan(rows).split('\n'),
    ['SELLER DISCLOSURES', '- TDS - NB', '- SPQ - NB', '- AVID - NeedLA', '- WHSD - NB',
     'BUYER ITEMS', '- AB - NB']);
}

// --- the whole write, simulated ---------------------------------------------
// Three complete forms and one still short the listing agent.
const FILES = ['TDS - Real Estate Transfer Disclosure Statement - FX.pdf',
               'SPQ - Seller Property Questionnaire - FX.pdf',
               'AVID-BA - Agent Visual Inspection Disclosure - NeedLA.pdf',
               'AB - Buyer\'s Affidavit - FX.pdf'];
{
  const r = run(LIST, FILES, 'delete');
  ok('delete mode removes exactly the received lines',
    r.text.split('\n').filter(Boolean),
    ['SELLER DISCLOSURES', 'AVID - NeedLA', 'WHSD - NB', 'BUYER ITEMS']);
  ok('and reports them in document order',
    r.applied.map((a) => `${a.text} ${a.action}`),
    ['TDS - NB deleted', 'SPQ - NB deleted', 'AB - NB deleted']);
}
{
  const r = run(LIST, FILES, 'strike');
  ok('strike mode changes no text at all',
    r.text, flatten(fakeDoc(LIST)));
  // The ranges must cover each line's own text and NOT its newline, or the
  // strike bleeds into the following line.
  ok('and strikes exactly the received lines',
    r.struck.sort(), ['AB - NB', 'SPQ - NB', 'TDS - NB'].sort());
  ok('reported as struck through',
    r.applied.map((a) => a.action), ['struck through', 'struck through', 'struck through']);
}

// A heading, a still-needed line and a line the reconcile could not judge are
// all left untouched - the writer only ever acts on delete and annotate.
{
  const r = run(LIST, [], 'delete');
  ok('nothing in the folder means nothing is changed',
    r.text, flatten(fakeDoc(LIST)));
  ok('and nothing is reported', r.applied, []);
}

// --- the refusals -----------------------------------------------------------
// The plan is derived from these very paragraphs, so a disagreement means the
// document moved under us - someone editing it between the read and the write.
// Writing into a moving document with stale indices is how you mangle it.
{
  const doc = fakeDoc(LIST);
  const { rows } = docs.paragraphsOf(doc);
  const plan = planDoc(docs.textForPlan(rows), FILES);
  ok('a plan that is a different length than the document refuses',
    docs.requestsFor(plan.lines.slice(0, 3), rows, 'delete').error,
    'the plan has 3 line(s) but the document has 7 paragraph(s)');
  ok('an empty document plans nothing',
    docs.requestsFor([], [], 'delete').requests, []);
}

// --- annotating a line that arrived short a signature -----------------------
// The reconcile's `to` is the whole rewritten line, but rewriting means
// deleting and re-inserting, which throws away the line's formatting. Only the
// tail is appended, and only when it IS a tail.
ok('the tail is appended', docs.suffixFor('AVID -', 'AVID - NeedSS'), ' NeedSS');
ok('a bullet marker does not block the match',
  docs.suffixFor('- AVID -', 'AVID - NeedSS'), ' NeedSS');
// Idempotence: a second run over an unchanged folder must append nothing, or
// the line grows a status every ten minutes.
ok('an unchanged line appends nothing', docs.suffixFor('AVID - NeedSS', 'AVID - NeedSS'), '');
// If the reconcile rewrote more than the tail, appending would leave the old
// AND the new status on one line. Better to say nothing and let a person look.
ok('a rewrite that is not a tail is refused',
  docs.suffixFor('AVID - NeedLA', 'AVID - NeedSS'), '');

// --- HER SPACING IS A STATUS TOO -------------------------------------------
// Megan hand-names files with a space: `BA AVID - need SS.pdf`. The trailing
// token read as just "SS", which matches no status, so the line fell through
// to "a file exists but Keeva cannot tell if it is complete" and was left
// untouched on her list - when it should have annotated the BA AVID line to
// NeedSS. Her spelling is the correct one; the parser has to accept both.
const status = (f) => fileKey(f).status;
ok('a space after "need" is still a status', status('BA AVID - need SS.pdf'), 'NeedSS');
ok('and is normalised to the closed-up form the splitter writes',
  ['LA AVID - need B.pdf', 'TDS - need SS+LA.pdf', 'AVID - Need Broker(s).pdf'].map(status),
  ['NeedB', 'NeedSS+LA', 'NeedBroker(s)']);
ok('the closed-up form is unchanged',
  ['AVID-BA - Agent Visual Inspection Disclosure - NeedSS.pdf',
   'TDS - Real Estate Transfer Disclosure Statement - FX.pdf'].map(status),
  ['NeedSS', 'FX']);
// The four punctuations that a real folder actually contains.
ok('and so are the hand-named shapes',
  ['Eq Booklet Receipt- FX.pdf', 'CR 2 FX.pdf', 'Prelim - BSIGNED-FX.pdf'].map(status),
  ['FX', 'FX', 'FX']);
// The label must survive intact, or the file stops matching its line.
ok('the label is unaffected by the spacing', fileKey('BA AVID - need SS.pdf').key, 'avid-ba');
ok('a normalised status still reads as outstanding', OUTSTANDING.test(status('BA AVID - need SS.pdf')), true);

// End to end: that one file, against her real BA AVID line.
{
  const plan = planDoc('- BA AVID', ['BA AVID - need SS.pdf']);
  ok('the BA AVID line is annotated rather than left for review',
    [plan.lines[0].action, plan.lines[0].to], ['annotate', 'BA AVID - NeedSS']);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
