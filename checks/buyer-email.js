// checks/buyer-email.js
//
// Filling Megan's pre-made "Seller Disclosure Package" draft.
//   node checks/buyer-email.js
// The template below is her Zap's body (26701 Quail Creek draft, 2026-10-22),
// with the highlight spans Gmail puts around the placeholders.

const { fillBuyerEmail } = require('../netlify/functions/lib/buyer-email.js');

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

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall buyer-email checks pass');
process.exit(failed ? 1 : 0);
