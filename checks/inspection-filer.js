// checks/inspection-filer.js
//
// Inspection reports file into the deal's escrow folder, and ONLY when the
// folder is certain.   node checks/inspection-filer.js
//
// Megan, 2026-10-09: "let's auto fill them into the google drive escrow folder,
// but not the sub-folder ... agents can be messy." Subjects below are from the
// router log of Oct 7-9.

const F = require('../netlify/functions/lib/inspection-filer');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

// A fake Drive: 00 ESCROW folders per agent, plus decoys.
const FOLDERS = [
  { id: 'esc1', name: '00 ESCROW' }, { id: 'esc2', name: '00 ESCROW' }, { id: 'list1', name: '01 LISTINGS' },
  { id: 'p1', name: '410 N Crescent Heights Blvd', parents: ['esc1'] },
  { id: 'p2', name: '5340 Calvin Ave', parents: ['esc1'] },
  { id: 'p3', name: '1459 N Avenue 57', parents: ['esc2'] },
  { id: 'p4', name: '304 W Juanita Ave', parents: ['esc2'] },
  { id: 'p5', name: '1707 S Stanley Ave', parents: ['esc1'] },
  { id: 'p6', name: '1707 Rose Ave', parents: ['esc2'] },          // same number, other street
  { id: 'p7', name: '3637 Loadstone Dr', parents: ['list1'] },      // not under an ESCROW folder
  { id: 'p8', name: '22 Ocean View Dr', parents: ['esc1'] },
  { id: 'p9', name: '22 Ocean View Dr Unit B', parents: ['esc2'] }, // ambiguous twin
];
function fakeDrive(existing = {}) {
  const uploads = [];
  return {
    uploads,
    findFoldersNameContains: async (t) => FOLDERS.filter((f) => f.parents && f.name.includes(t)),
    getFileMeta: async (id) => FOLDERS.find((f) => f.id === id) || { name: '' },
    listChildren: async (id) => (existing[id] || []).map((name) => ({ name })),
    uploadMultipart: async ({ name, parents }) => { uploads.push(`${parents[0]}:${name}`); return { id: 'x' }; },
  };
}
const TEXT = {};   // attachmentId -> first-page text
const gmail = { getAttachment: async (mid, aid) => Buffer.from(`%PDF ${aid}`) };
const pdfHeadText = async (bytes) => TEXT[String(bytes).slice(5)] || '';
const pdf = (filename) => ({ filename, mimeType: 'application/pdf', attachmentId: `a-${filename}` });
const msg = (subject, files, text = '') => ({ id: 'm1', headers: { subject }, attachments: files.map(pdf), newestText: text });
const run = async (m, drive, decision = {}) => F.fileInspectionReports(m, decision, { drive, gmail, pdfHeadText });
const up = (d) => d.uploads.map((u) => u.replace(/ \(was .*\)$/, ''));

(async () => {
  // ---- files when certain ---------------------------------------------------
  let d = fakeDrive();
  let r = await run(msg('Inspection Reports | 410 N Crescent Heights', ['Home Inspection.pdf', 'Sewer Scope.pdf']), d);
  ok('subject address -> its escrow folder, named the team way', up(d), ['p1:Buyer Report - General.pdf', 'p1:Buyer Report - Sewer.pdf']);

  d = fakeDrive();
  r = await run(msg('RE: 5340 Calvin Termite Report', ['WDO 5340 Calvin.pdf']), d);
  ok('termite report filed', up(d), ['p2:Buyer Report - Termite.pdf']);

  d = fakeDrive();
  r = await run(msg('Home inspection reports', ['Report.pdf', 'Sewerline.pdf'], 'Hi! Attached are the reports for 1459 N Avenue 57.'), d);
  ok('no address in the subject: found in the email text', up(d), ['p3:Buyer Report - General.pdf', 'p3:Buyer Report - Sewer.pdf']);

  d = fakeDrive();
  r = await run(msg('Fwd: Your Report', ['304 W Juanita Ave - Termite.pdf']), d);
  ok('address only in the PDF name', up(d), ['p4:Buyer Report - Termite.pdf']);

  d = fakeDrive();
  r = await run(msg('Re: NEW DEAL - 1707 S STANLEY', ['Roof Inspection.pdf']), d);
  ok('same house number on two deals: the street word picks Stanley', up(d), ['p5:Buyer Report - Roof.pdf']);

  d = fakeDrive();
  d.listChildren = async () => [{ name: 'Buyer Report - Termite.pdf', size: String(Buffer.from('%PDF a-WDO 5340 Calvin.pdf').length) }];
  r = await run(msg('RE: 5340 Calvin Termite Report', ['WDO 5340 Calvin.pdf']), d);
  ok('the same report forwarded again: not filed twice', [d.uploads, F.summary(r)], [[], 'INSPECTION already in "5340 Calvin Ave": Buyer Report - Termite.pdf']);

  // Same name, different file -> "(2)"; same name and size -> already there.
  d = fakeDrive();
  d.listChildren = async () => [{ name: 'Buyer Report - Termite.pdf', size: '1' }];
  TEXT.t2 = 'WOOD DESTROYING PESTS AND ORGANISMS INSPECTION REPORT Branch 3';
  r = await run({ id: 'm', headers: { subject: 'Inspection Reports | 410 N Crescent Heights' }, newestText: '',
    attachments: [{ filename: 'WHKDNAKJFNCSk.PDF', attachmentId: 't2' }] }, d);
  ok('a second, different termite report becomes "(2)"', up(d), ['p1:Buyer Report - Termite (2).pdf']);

  d = fakeDrive();
  r = await run(msg('Termite clearance I 304 W Juanita Ave', ['Section 1 clearance.pdf', 'Invoice 3321.pdf', 'Receipt for Funds Received in Escrow.pdf', 'RR signed.pdf']), d);
  ok('invoice + clearance filed; an escrow funds receipt and the RR are not',
    up(d), ['p4:Buyer Report - Termite.pdf', 'p4:Buyer Report - Termite Invoice.pdf']);

  // ---- does NOT file when unsure --------------------------------------------
  d = fakeDrive();
  r = await run(msg('Receipt for Funds Received In Escrow | 410 N Crescent Heights', ['Receipt for Funds.pdf']), d);
  ok('escrow receipt email: not an inspection, nothing filed', [d.uploads, r], [[], null]);

  d = fakeDrive();
  r = await run(msg('WILDFIRE REPORT & NHD FOR 5340 Calvin', ['NHD Report.pdf', 'Wildfire Report.pdf']), d);
  ok('NHD / wildfire report: not filed', d.uploads, []);

  d = fakeDrive();
  r = await run(msg('Geology and Soil Report - 3637 Loadstone Dr', ['Geology Report.pdf']), d);
  ok('a folder outside 00 ESCROW is never used', [d.uploads, /no address that matches/.test(F.summary(r))], [[], true]);

  d = fakeDrive();
  r = await run(msg('Inspection - 22 Ocean View Dr', ['Home Inspection.pdf']), d);
  ok('two possible folders: files nothing and says so', [d.uploads, /2 possible deal folders/.test(F.summary(r))], [[], true]);

  d = fakeDrive();
  r = await run(msg('Inspection Report', ['inspection.pdf'], 'see attached'), d);
  ok('no address anywhere: nothing filed, reason logged', [d.uploads, F.summary(r)], [[], 'INSPECTION not filed: no address that matches a deal folder']);

  d = fakeDrive();
  r = await run({ id: 'm', headers: { subject: 'Inspection Report | 410 N Crescent Heights' }, attachments: [],
    newestText: 'Here is the report: https://app.spectora.com/home-inspectors/x/sample_report' }, d);
  ok('a Spectora link: logged as a link to download, nothing filed', [d.uploads, /came as a link \(spectora\)/.test(F.summary(r))], [[], true]);
  r = await run({ id: 'm', headers: { subject: 'Re: 1643 Carmelina Ave' }, attachments: [],
    newestText: 'Margie, are the attached notes the sewer report or is there a separate one?' }, d,
    { classifier: { reason: 'question about whether the notes are the sewer report' } });
  ok('a question about a report, no PDF, no link: no filing note', r, null);

  // ---- naming from the PDF's own text (the "WHKDNAKJFNCSk.PDF" case) -------
  const T = F._internal.teamName;
  ok('gibberish name, termite report inside', T({ filename: 'WHKDNAKJFNCSk.PDF', subject: 'reports',
    text: 'WOOD DESTROYING PESTS AND ORGANISMS INSPECTION REPORT ... Section 1 ... Section 2' }), 'Buyer Report - Termite.pdf');
  ok('gibberish name, home inspection inside', T({ filename: 'A8F2.pdf', subject: '',
    text: 'Inspection Report 123 Main St. Roof, Exterior, Plumbing, Electrical, Heating, Attic, Kitchen, Garage' }), 'Buyer Report - General.pdf');
  ok('a home inspection that mentions the roof is still General', T({ filename: 'Report.pdf', subject: 'Home inspection',
    text: 'HOME INSPECTION REPORT. Roof: composition shingle. Plumbing: copper. Electrical: 200 amp.' }), 'Buyer Report - General.pdf');
  ok('sewer from the text', T({ filename: 'x.pdf', subject: '', text: 'Sewer Lateral Video Inspection' }), 'Buyer Report - Sewer.pdf');
  ok('roof invoice', T({ filename: 'Invoice 4471.pdf', subject: 'roof', text: 'INVOICE Roof inspection and certification' }), 'Buyer Report - Roof Invoice.pdf');
  ok('a scan with no text and no clue', T({ filename: 'scan0001.pdf', subject: 'see attached', text: '' }), 'Buyer Report - Inspection.pdf');
  ok("our seller's own report", T({ filename: 'termite.pdf', subject: '', text: '', sellerSent: true }), 'Seller Report - Termite.pdf');

  process.env.INSPECTION_FILING = 'off';
  d = fakeDrive();
  r = await run(msg('Inspection Reports | 410 N Crescent Heights', ['Home Inspection.pdf']), d);
  ok('off switch', [d.uploads, r], [[], null]);
  delete process.env.INSPECTION_FILING;

  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nall inspection-filer checks pass');
})();
