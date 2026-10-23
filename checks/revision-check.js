// checks/revision-check.js
//
// The revision check (lib/revision-check.js): reading Megan's sent corrections
// email, two reads agreeing, page numbers in the merged PDF, and the buyer
// email inputs. Cases from 8 Star Catcher (2026-10-22).
//   node checks/revision-check.js

const rc = require('../netlify/functions/lib/revision-check.js');
const { buildRevisionEmail } = require('../netlify/functions/lib/buyer-email.js');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

// Her sent corrections email (screenshot, 2026-10-22), with Gmail's quote below it.
const CORRECTIONS_HTML = '<div dir="ltr"><p>Hi Heather,</p><p>Thanks so much for sending these over! I went through the package, and here is what is still pending on my end:</p>'
  + '<p>A few answers need a quick update:</p><ul>'
  + '<li>TDS II A 220 Volt Wiring: the location is left blank. Could you fill that in, or mark it Unknown?</li>'
  + '<li>SPQ 17G: The property is marked as a high fire hazard area, would you please confirm if annual brush clearance is required?</li>'
  + '<li>SOLAR 3A: 3A (solar system provides power for only a portion of the property) is marked Yes but the item 3 Explanation line is blank. Could the seller add a short explanation as to what portion of the home it supplies?</li>'
  + '</ul><p>Whenever you get a chance, send these my way and we will be all set.</p><p>Thanks!</p><p>Megan</p></div>'
  + '<div class="gmail_quote"><ul><li>an item quoted from an older email</li></ul></div>';
const sent = (id, at, subject, html, text = '') => ({ id, internalDate: String(at), labelIds: ['SENT'], headers: { subject }, bodyHtml: html, bodyText: text, newestText: text || html.replace(/<[^>]+>/g, ' ') });
const corrections = sent('c1', 2000, '8 Star Catcher | Seller Disclosures Corrections', CORRECTIONS_HTML);
const revision = { id: 'r1', internalDate: '3000', labelIds: ['INBOX'], headers: { subject: 'RE: 8 Star Catcher | Seller Disclosures Corrections' } };

const items = rc.correctionItems(corrections);
ok('her 3 items, not the quoted one', items.length, 3);
ok('item text kept as she wrote it', items[1], 'SPQ 17G: The property is marked as a high fire hazard area, would you please confirm if annual brush clearance is required?');
ok('a 3-letter item ("LPD") is kept', rc.correctionItems({ bodyHtml: '<p>Still outstanding:</p><ul><li>NHD Statement</li><li>LPD</li><li>TA</li></ul>' }), ['NHD Statement', 'LPD', 'TA']);
ok('plain-text bullets when there is no HTML list', rc.correctionItems({ bodyHtml: '', newestText: 'Hi,\n- TDS C2 should be Yes\n• SPQ 15D should be Yes\nThanks' }), ['TDS C2 should be Yes', 'SPQ 15D should be Yes']);
ok('a CHECK BEFORE SENDING block left in is not a request',
  rc.correctionItems({ bodyHtml: '<p>CHECK BEFORE SENDING</p><ul><li>internal note</li></ul><p>---------- delete through here ----------</p><ul><li>SPQ 8B explanation</li></ul>' }), ['SPQ 8B explanation']);

const thread = [revision, corrections, sent('c0', 1000, 'Old', '<p>still pending on my end</p><ul><li>older ask</li></ul>')];
ok('finds the newest corrections email before the revision', rc.findCorrectionsEmail(thread, revision).msg.id, 'c1');
const chase = sent('k1', 1500, '8 Star Catcher | Seller Disclosures', '<p>Please send over the seller disclosures:</p><ul><li>TDS</li><li>SPQ</li></ul>');
ok('a request for the forms is NOT a corrections email (the delivery gets the full audit)', rc.findCorrectionsEmail([chase, revision], revision), null);
ok('an email from the other side is never the checklist', rc.findCorrectionsEmail([{ ...corrections, labelIds: ['INBOX'] }, revision], revision), null);
ok('an email sent AFTER the revision is not the checklist', rc.findCorrectionsEmail([{ ...corrections, internalDate: '4000' }, revision], revision), null);

ok('greeting from the package email', rc.greetingFrom({ newestText: 'Hello Omeed,\n\nAttached is a package...' }), 'Hello Omeed,');
ok('no greeting -> empty', rc.greetingFrom({ newestText: 'Attached is a package' }), '');

// The revision delivered TDS-R, SOLAR-R, SPQ-R (in that order); package order puts SOLAR last.
const files = [
  { n: 0, name: 'TDS-R.pdf', pages: 3, forms: ['Real Estate Transfer Disclosure Statement'] },
  { n: 1, name: 'SOLAR-R.pdf', pages: 3, forms: ['Solar Advisory and Questionnaire'] },
  { n: 2, name: 'SPQ-R.pdf', pages: 5, forms: ['Seller Property Questionnaire'] },
];
const ordered = rc.packageOrder(files);
ok('package order: TDS, SPQ, solar', ordered.map((f) => f.n), [0, 2, 1]);
ok('SPQ page 4 is page 7 of the merged PDF (her email said 8)', rc.mergedPage(ordered, 2, 4), 7);
ok('solar page 3 is page 11', rc.mergedPage(ordered, 1, 3), 11);
ok('a page past the end of its file is null', rc.mergedPage(ordered, 0, 4), null);

// Two reads: file numbers are 1-based in the order SENT to the model (TDS, SOLAR, SPQ).
const read = (spqPage) => ({
  property_address: '8 Star Catcher, Newport Coast, CA 92657',
  items: [
    { item: 1, status: 'fixed', file: 1, page: 1, evidence: '220 Volt Wiring in GARAGE', buyer_line: 'The seller filled in where the 220 volt wiring is located (the garage).' },
    { item: 2, status: 'fixed', file: 3, page: spqPage, evidence: '17G) HOA maintains on a regular basis vegetation setback clearance', buyer_line: 'The seller added a note that the HOA regularly maintains the vegetation clearance at the front of the property.' },
    { item: 3, status: 'fixed', file: 2, page: 3, evidence: '(3A) Solar system for pool only.', buyer_line: 'The seller explained that the solar system is for the pool only.' },
  ],
  files: [{ file: 1, forms: ['Transfer Disclosure Statement'] }, { file: 2, forms: ['Solar Advisory'] }, { file: 3, forms: ['Seller Property Questionnaire'] }],
});
const sendFiles = files.map((f) => ({ ...f, base64: 'AA==' }));
(async () => {
  let calls = 0;
  const same = await rc.checkRevisions({ items, files: sendFiles, callModel: async () => { calls++; return JSON.stringify(read(4)); } });
  ok('two reads are made', calls, 2);
  ok('reads agree -> all fixed', same.items.map((v) => v.status), ['fixed', 'fixed', 'fixed']);
  ok('merged pages computed by code: 1, 7, 11', same.items.map((v) => v.mergedPage), [1, 7, 11]);
  ok('address read', same.address, '8 Star Catcher, Newport Coast, CA 92657');

  let k = 0;
  const differ = await rc.checkRevisions({ items, files: sendFiles, callModel: async () => JSON.stringify(read(k++ === 0 ? 4 : 5)) });
  ok('reads disagree on the page -> to check, not fixed', differ.items[1].status, 'unclear');
  ok('the others are still fixed', [differ.items[0].status, differ.items[2].status], ['fixed', 'fixed']);

  const coded = await rc.checkRevisions({ items, files: sendFiles, callModel: async () => JSON.stringify({ ...read(4), items: read(4).items.map((x) => (x.item === 1 ? { ...x, buyer_line: 'The seller filled in TDS 220 volt wiring.' } : x)) }) });
  ok('a buyer sentence with a form code goes to Megan, not the buyer', coded.items[0].status, 'unclear');

  const open = { ...read(4), items: read(4).items.map((x) => (x.item === 3 ? { item: 3, status: 'open', evidence: 'explanation still blank', open_phrase: 'an explanation of what the solar system powers' } : x)) };
  const withOpen = await rc.checkRevisions({ items, files: sendFiles, callModel: async () => JSON.stringify(open) });
  const inputs = rc.emailInputs(withOpen.items, withOpen.ordered);
  ok('open item -> still to come, in plain English', inputs.stillToCome, ['an explanation of what the solar system powers']);
  ok('forms for the closing, package order', inputs.forms, ['Transfer Disclosure Statement', 'Seller Property Questionnaire', 'Solar Advisory']);
  const email = buildRevisionEmail({ greeting: 'Hello Omeed,', ...inputs, totalPages: 11 });
  ok('the buyer email builds, every item accounted for', email.warnings, []);
  ok('it says what is still to come', /Still to come from the seller:<\/b><ul><li>An explanation of what the solar system powers<\/li><\/ul>/.test(email.html), true);


  // 1222 N Kings Rd #8: the fix is there but a seller has not signed.
  const unsignedRead = () => ({ ...read(4), items: read(4).items.map((x) => (x.item === 2 ? { ...x, signed_by_all_sellers: false } : { ...x, signed_by_all_sellers: true })) });
  const unsigned = await rc.checkRevisions({ items, files: sendFiles, callModel: async () => JSON.stringify(unsignedRead()) });
  ok('a fix on a form not every seller signed -> check this one', [unsigned.items[1].status, /not every seller has signed/.test(unsigned.items[1].why)], ['unclear', true]);
  ok('signed fixes stay fixed', [unsigned.items[0].status, unsigned.items[2].status], ['fixed', 'fixed']);

  // 1222 N Kings Rd #8: the reply held the amendment plus buyer-side forms.
  const kFiles = [
    { n: 0, name: '[APD] Amendment to Prior Disclosure.pdf', pages: 1, forms: ['Amendment to Prior Disclosure'] },
    { n: 1, name: '[RFR] Receipt for Reports.pdf', pages: 2, forms: ['Receipt for Reports'] },
    { n: 2, name: "[BIE] Buyer's Investigation Elections.pdf", pages: 1, forms: ["Buyer's Investigation Elections"] },
  ];
  const kOrdered = rc.packageOrder(kFiles);
  const kVerdicts = [{ item: '5B', status: 'fixed', n: 0, page: 1, mergedPage: rc.mergedPage(kOrdered, 0, 1), buyerLine: 'The seller changed their answer to Yes.' }];
  const plan = rc.attachmentPlan(kVerdicts, kOrdered);
  ok('only the file with the fix is attached', plan.attached.map((f) => f.n), [0]);
  ok('the rest are listed for Megan', plan.left.map((f) => f.n).sort(), [1, 2]);
  ok('pages renumbered for the attachment', plan.verdicts[0].mergedPage, 1);
  const sc8Plan = rc.attachmentPlan(same.items, same.ordered);
  ok('Star Catcher: all three files carry a fix, pages unchanged', [sc8Plan.attached.length, sc8Plan.verdicts.map((v) => v.mergedPage)], [3, [1, 7, 11]]);
  ok('nothing fixed -> everything attached for Megan to look at', rc.attachmentPlan([{ item: 'x', status: 'open', n: null, mergedPage: null }], kOrdered).attached.length, 3);
  const amend = buildRevisionEmail({ greeting: 'Hello Dana,', changes: [{ page: 1, label: 'The seller changed their answer to Yes.' }], forms: ['Amendment to Prior Disclosure'], totalPages: 1 });
  ok('amendment closing (her wording)', /This amendment updates the seller's disclosures in the package I sent earlier\./.test(amend.html), true);
  ok('superseded banner sits above the items', /CHECK BEFORE SENDING[\s\S]*SUPERSEDED[\s\S]*asked for/.test(rc.checkNoteHtml({ verdicts: kVerdicts, banner: 'SUPERSEDED: a later reply arrived' })), true);
  const two = buildRevisionEmail({ greeting: 'Hello Dana,', changes: [{ page: 1, label: 'The seller changed 5B to Yes.' }, { page: 1, label: 'The seller checked 19B.' }], forms: ['Amendment to Prior Disclosure'], totalPages: 1 });
  ok('two changes on one page -> one "Pages 1:" line', (two.html.match(/Pages 1:/g) || []).length, 1);
  // 12273 Donald Reed: items she said she will add herself are not the seller's.
  const split = rc.splitOurs(['NHD Statement', 'Earthquake Booklet Receipt - I can add this on my end', 'Orange County Local Area Disclosures - I can add this on my end', 'TDS disclosure date is blank. Could the seller answer it?', 'We will add the AVID ourselves']);
  ok('"I can add this on my end" items are hers, not the seller\'s', [split.seller, split.ours.length], [['NHD Statement', 'TDS disclosure date is blank. Could the seller answer it?'], 3]);
  // 6051 Scenic (2026-10-23): open items -> a follow-up to the listing side, her voice.
  const fu = rc.followUpHtml({ greeting: 'Hi Fred,', open: ['NHD Statement', 'Trust Advisory', 'FHDS Section 3 is not completed; please mark Section 3A'] });
  ok('follow-up: forms under Still outstanding', /<u>Still outstanding:<\/u><\/p><ul><li>NHD Statement<\/li><li>Trust Advisory<\/li><\/ul>/.test(fu), true);
  ok('follow-up: answer fixes under A few answers', /<u>A few answers need a quick update:<\/u><\/p><ul><li>FHDS Section 3 is not completed; please mark Section 3A<\/li><\/ul>/.test(fu), true);
  ok('follow-up: her greeting and sign-off', [/^<p>Hi Fred,<\/p>/.test(fu), /<p>Thanks!<\/p>$/.test(fu)], [true, true]);
  ok('follow-up: no em dashes', /\u2014/.test(fu), false);
  const note = rc.checkNoteHtml({ verdicts: differ.items, correctionsDate: 'Thu, 22 Oct 2026 10:27', extra: ['Greeting copied from your package email ("Hello Omeed,"); add any other buyer.'] });
  ok('the red note lists every item and how it was judged',
    [/FIXED \(page 1 of the attachment\)/.test(note), /CHECK THIS ONE/.test(note), /two reads disagreed/.test(note), /delete through here/.test(note)], [true, true, true, true]);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall revision-check checks pass');
  process.exit(failed ? 1 : 0);
})();
