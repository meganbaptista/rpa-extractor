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

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall buyer-email checks pass');
process.exit(failed ? 1 : 0);
