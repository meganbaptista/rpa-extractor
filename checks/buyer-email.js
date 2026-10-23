// checks/buyer-email.js
//
// Filling Megan's pre-made "Seller Disclosure Package" draft.
//   node checks/buyer-email.js
// The template below is her Zap's body (26701 Quail Creek draft, 2026-10-22),
// with the highlight spans Gmail puts around the placeholders.

const { fillBuyerEmail, buildRevisionEmail } = require('../netlify/functions/lib/buyer-email.js');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}
const hl = (s) => `<span style="background-color:rgb(255,255,0)"><b>${s}</b></span>`;
const TEMPLATE = '<div>Hello Christopher,</div><br>'
  + '<div>Attached is a package of important disclosures that have been filled out by the seller and require your review and signature.</div><br>'
  + `<div>${hl('Pages 1 - X')}&nbsp;have been filled out by the seller disclosing the condition of the property.</div><br>`
  + `<div>${hl('Pages X - X')}&nbsp;is the Agent Visual Inspection. Both the listing agent and buyer's agent are required to walk the property.</div><br>`
  + `<div>${hl('The remainder of the PDF package')}&nbsp;are the California Association of Realtor standard disclosures.</div><br>`
  + '<div>I am also including the California combined hazards booklets below for your review:</div>'
  + '<ul><li><a href="https://fidelitynationalnhd.com/downloads/HomeEnergyRating.pdf">Home Energy Rating Guide (click link to view)</a></li></ul>'
  + '<div>Please let us know if you have any questions.</div><div>--</div><div>Megan Baptista</div>';
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

const r = fillBuyerEmail(TEMPLATE, { seller: { from: 4, to: 35 }, avid: { from: 36, to: 54 }, stillToCome: ['the NHD report', 'a few updated answers'] });
ok('seller range filled', /Pages 4 - 35 have been filled out by the seller/.test(text(r.html)), true);
ok('AVID range filled', /Pages 36 - 54 is the Agent Visual Inspection/.test(text(r.html)), true);
ok('no placeholder left', /\bX\b/.test(text(r.html).replace(/Christopher/, '')), false);
ok('still-to-come after the remainder line', /standard disclosures\. Still to come from the seller's side: the NHD report and a few updated answers\. I will send/.test(text(r.html)), true);
ok('no seller reports link when none was delivered', /SELLER REPORTS/.test(r.html), false);
ok('greeting, links and signature untouched', [/Hello Christopher,/.test(r.html), /HomeEnergyRating\.pdf/.test(r.html), /Megan Baptista/.test(r.html)], [true, true, true]);
ok('highlight kept on the filled range', /background-color:rgb\(255,255,0\)"><b>Pages 4 - 35<\/b>/.test(r.html), true);
ok('no warnings', r.warnings, []);

const r2 = fillBuyerEmail(TEMPLATE, { seller: { from: 1, to: 27 }, avid: { from: 28, to: 30 }, reportsLink: 'https://www.dropbox.com/scl/fo/abc' });
ok('reports link added only when delivered', /<a href="https:\/\/www.dropbox.com\/scl\/fo\/abc">CLICK HERE FOR SELLER REPORTS<\/a>/.test(r2.html), true);
ok('no still-to-come line when nothing is outstanding', /Still to come/.test(r2.html), false);

const r3 = fillBuyerEmail('<div>Hello,</div><div>Here you go.</div>', { seller: { from: 1, to: 5 }, avid: { from: 6, to: 8 } });
ok('a draft without placeholders is untouched and says why', [r3.html, r3.warnings.length], ['<div>Hello,</div><div>Here you go.</div>', 2]);

ok('a single page reads "Page n"', /Page 7 is the Agent/.test(text(fillBuyerEmail(TEMPLATE, { seller: { from: 1, to: 6 }, avid: { from: 7, to: 7 } }).html)), true);

// Her REAL Zap draft (8 Star Catcher, 2026-10-22): <br></br> lines, </span></b> misnested.
const REAL = 'Hello Shahrokh and Omeed,\n<br></br><br></br>\n'
  + '<span style="background-color:yellow"><b>Pages 1 - X </span></b>have been filled out by the seller disclosing the condition of the property. \n<br></br><br></br>\n'
  + '<span style="background-color:yellow"><b>Pages X - X </span></b>is the Agent Visual Inspection. Both the listing agent and buyer\u2019s agent are required to walk the property.\n<br></br><br></br>\n'
  + '<span style="background-color:yellow"><b>The remainder of the PDF package</span></b> are the California Association of Realtor standard disclosures. \n\n<br></br><br></br>\n'
  + 'I am also including the California combined hazards booklets below for your review: \n<ul>\n  <li><a href="https://www.disclosuresource.com/downloads/HomeEnergyRating.pdf">Home Energy Rating Guide (click link to view)</a></li></ul>';
const rr = fillBuyerEmail(REAL, { seller: { from: 1, to: 23 }, avid: { from: 24, to: 30 }, reportsLink: 'https://drive.google.com/drive/folders/X1' });
ok('real draft: both ranges filled', [/Pages 1 - 23/.test(rr.html), /Pages 24 - 30/.test(rr.html)], [true, true]);
ok('real draft: reports link after the remainder sentence', /standard disclosures\.\s*<br><br><a href="https:\/\/drive\.google\.com\/drive\/folders\/X1">CLICK HERE FOR SELLER REPORTS<\/a>\s*<br><\/br>/.test(rr.html), true);
ok('real draft: no warnings', rr.warnings, []);
ok('real draft: booklet list still follows', rr.html.indexOf('CLICK HERE') < rr.html.indexOf('I am also including'), true);

const rp = fillBuyerEmail(REAL, { seller: { from: 1, to: 17 }, avid: { pending: true }, stillToCome: ["the listing agent's AVID", 'a few updated answers'] });
ok('pending AVID: the AVID line is removed', /Agent Visual Inspection|Pages X/.test(rp.html), false);
ok('pending AVID: seller range still filled', /Pages 1 - 17/.test(rp.html), true);
ok('pending AVID: remainder line still there, still-to-come after it', rp.html.indexOf('remainder') < rp.html.indexOf('Still to come'), true);
ok('pending AVID: no warnings', rp.warnings, []);
const tp = fillBuyerEmail(TEMPLATE, { seller: { from: 1, to: 17 }, avid: { pending: true } });
ok('pending AVID (div layout): line removed', /Agent Visual Inspection|Pages X/.test(tp.html), false);

// 12273 Donald Reed's draft: <br> lines inside ONE outer <div>.
const WRAPPED = '<div dir="ltr">Hello Armando,\n<br>\n<br>\n<span style="background-color:yellow"><b>Pages 1 - X </b></span>have been filled out by the seller. \n<br><br>\n'
  + '<span style="background-color:yellow"><b>Pages X - X </b></span>is the Agent Visual Inspection. Both agents walk it.\n<br><br>\n'
  + '<span style="background-color:yellow"><b>The remainder of the PDF package</b></span> are the California Association of Realtor standard disclosures. \n<br><br>\n'
  + 'I am also including the booklets: \n<ul><li>x</li></ul>\nPlease let us know if you have any questions as I will send this out via Docusign. \n</div><div>-- Megan</div>';
const rw = fillBuyerEmail(WRAPPED, { seller: { from: 1, to: 17 }, avid: { pending: true }, stillToCome: ['the NHD report'] });
ok('wrapped draft: still-to-come right after the remainder sentence', rw.html.indexOf('Still to come') < rw.html.indexOf('I am also including'), true);
ok('wrapped draft: AVID line removed, no warnings', [/Agent Visual/.test(rw.html), rw.warnings], [false, []]);

const again = fillBuyerEmail(rw.html, { seller: { from: 1, to: 8 } });
ok('re-run corrects an already-filled seller range', [/Pages 1 - 8 /.test(again.html), /Pages 1 - 17/.test(again.html)], [true, false]);

// --- page guide mode (Megan, 2026-10-22) --------------------------------------------
const { guideProblems } = require('../netlify/functions/lib/buyer-email.js');
const DR_GUIDE = [
  { from: 1, to: 8, label: "The seller's disclosures about the condition of the property" },
  { from: 9, to: 17, label: 'Property details and additional seller disclosures (square footage, property profile, MLS listing, trust advisory, water heater and smoke alarms, plumbing fixtures)' },
  { from: 18, to: 43, label: 'Standard California Association of Realtors advisories and brokerage disclosures' },
  { from: 44, to: 49, label: "Additional documents provided by the seller's agent" },
];
const DR_TODO = ['the natural hazard disclosure report', "the listing agent's visual inspection", 'a few updated answers'];
for (const [name, draft] of [['Donald Reed layout', WRAPPED], ['Star Catcher layout', REAL], ['div layout', TEMPLATE]]) {
  const g = fillBuyerEmail(draft, { guide: DR_GUIDE, totalPages: 49, stillToCome: DR_TODO });
  const t = text(g.html);
  ok(`${name}: guide written`, /Here is how the package is organized: Pages 1 - 8: The seller's disclosures about the condition of the property Pages 9 - 17:/.test(t), true);
  ok(`${name}: placeholders and old lines gone`, /Pages 1 - X|Pages X - X|remainder of the PDF|Agent Visual Inspection/.test(g.html), false);
  ok(`${name}: still-to-come in plain English after the guide`, /Pages 44 - 49: Additional documents provided by the seller's agent Still to come from the seller's side: the natural hazard disclosure report, the listing agent's visual inspection and a few updated answers\./.test(t), true);
  ok(`${name}: what follows is untouched`, /I am also including/.test(g.html) && g.html.indexOf('Still to come') < g.html.indexOf('I am also including'), true);
  ok(`${name}: no warnings`, g.warnings, []);
}
ok('greeting kept', /^Hello Armando,/.test(fillBuyerEmail(WRAPPED, { guide: DR_GUIDE, totalPages: 49 }).html.replace(/<div dir="ltr">/, '')), true);

// The guards: refuse, change nothing.
const codeLabel = fillBuyerEmail(WRAPPED, { guide: [{ from: 1, to: 8, label: 'TDS and SPQ' }, { from: 9, to: 49, label: 'Advisories' }], totalPages: 49 });
ok('a form code in a label is refused', [codeLabel.html === WRAPPED, /form code TDS/.test(codeLabel.warnings.join(' '))], [true, true]);
const codeTodo = fillBuyerEmail(WRAPPED, { guide: DR_GUIDE, totalPages: 49, stillToCome: ["the listing agent's AVID"] });
ok('a form code in still-to-come is refused', /form code AVID/.test(codeTodo.warnings.join(' ')), true);
ok('a gap is refused', /missing from the guide/.test(guideProblems([{ from: 1, to: 8, label: 'a' }, { from: 10, to: 49, label: 'b' }], 49).join(' ')), true);
ok('a guide that does not reach the last page is refused (stale ranges)', /the PDF has 70 pages/.test(guideProblems(DR_GUIDE, 70).join(' ')), true);
ok('the Donald Reed guide passes', guideProblems(DR_GUIDE, 49, DR_TODO), []);


// THE REVISION EMAIL: her edited 8 Star Catcher reply (2026-10-22) is the template.
const SC8 = {
  greeting: 'Hello Shahrokh and Omeed,',
  changes: [
    { page: 8, label: 'The seller added a note that the HOA regularly maintains the vegetation clearance at the front of the property.' },
    { page: 1, label: 'The seller filled in where the 220 volt wiring is located (the garage).' },
    { page: 11, label: "The seller's solar questionnaire section 3A explanation section. The seller explained that the solar system is for the pool only." },
  ],
  forms: ['Transfer Disclosure Statement', 'Seller Property Questionnaire', 'Solar Advisory'],
  totalPages: 11,
  requested: 3,
};
const rev = buildRevisionEmail(SC8);
ok('revision: no warnings', rev.warnings, []);
ok('revision: her text, lines in page order', text(rev.html), 'Hello Shahrokh and Omeed, '
  + 'The seller has sent over a few updates to their disclosures. The revised pages are attached: '
  + 'Pages 1: The seller filled in where the 220 volt wiring is located (the garage). '
  + 'Pages 8: The seller added a note that the HOA regularly maintains the vegetation clearance at the front of the property. '
  + "Pages 11: The seller's solar questionnaire section 3A explanation section. The seller explained that the solar system is for the pool only. "
  + 'These replace the matching Transfer Disclosure Statement, Seller Property Questionnaire, and Solar Advisory pages in the package I sent earlier.'.replace(/'/g, "'"));
ok('revision: no DocuSign line', /DocuSign/i.test(rev.html), false);
ok('revision: no still-to-come line when nothing is open', /Still to come/.test(rev.html), false);
ok('revision: still-to-come when something is open',
  /Still to come from the seller's side:<\/b> the trust advisory\./.test(buildRevisionEmail({ ...SC8, stillToCome: ['the trust advisory'] }).html.replace(/&#39;/g, "'")), true);
const refuse = (label, opts, rx) => { const r2 = buildRevisionEmail({ ...SC8, ...opts }); ok(`revision refuses: ${label}`, [r2.html, rx.test(r2.warnings.join(' '))], ['', true]); };
refuse('a form code in a change line', { changes: [{ page: 1, label: 'TDS 220 volt wiring filled in' }] }, /form code TDS/);
refuse('a form code as a form name', { forms: ['TDS', 'SPQ'] }, /form code TDS/);
refuse('a page past the end of the PDF', { totalPages: 10 }, /page 11 is not in the attached PDF/);
refuse('fewer lines than she asked for', { requested: 4 }, /asked for 4 item/);
refuse('no greeting', { greeting: '' }, /no greeting/);

// Greeting (10600 Eastborne, 2026-10-23: "Hello Jesse," on an email to Jesse and Gayle).
const greeted = fillBuyerEmail(TEMPLATE, { guide: [{ from: 1, to: 9, label: "The seller's disclosures" }, { from: 10, to: 20, label: 'Advisories' }], totalPages: 20, greeting: 'Hello Christopher and Dana,' });
ok('greeting replaced, guide still filled', [/^<div>Hello Christopher and Dana,<\/div>/.test(greeted.html), greeted.filled.guide, greeted.filled.greeting, greeted.warnings], [true, true, true, []]);
ok('a non-greeting is refused, draft untouched', fillBuyerEmail(TEMPLATE, { guide: [{ from: 1, to: 20, label: 'x' }], totalPages: 20, greeting: 'Jesse and Gayle' }).html, TEMPLATE);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall buyer-email checks pass');
process.exit(failed ? 1 : 0);
