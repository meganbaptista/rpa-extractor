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
const gmail = { getAttachment: async () => Buffer.from('%PDF') };
const pdf = (filename) => ({ filename, mimeType: 'application/pdf', attachmentId: `a-${filename}` });
const msg = (subject, files, text = '') => ({ id: 'm1', headers: { subject }, attachments: files.map(pdf), newestText: text });
const run = async (m, drive, decision = {}) => F.fileInspectionReports(m, decision, { drive, gmail });

(async () => {
  // ---- files when certain ---------------------------------------------------
  let d = fakeDrive();
  let r = await run(msg('Inspection Reports | 410 N Crescent Heights', ['Home Inspection.pdf', 'Sewer Scope.pdf']), d);
  ok('subject address -> its escrow folder, both reports', d.uploads, ['p1:Home Inspection.pdf', 'p1:Sewer Scope.pdf']);

  d = fakeDrive();
  r = await run(msg('RE: 5340 Calvin Termite Report', ['WDO 5340 Calvin.pdf']), d);
  ok('termite report filed', d.uploads, ['p2:WDO 5340 Calvin.pdf']);

  d = fakeDrive();
  r = await run(msg('Home inspection reports', ['Report.pdf', 'Sewerline.pdf'], 'Hi! Attached are the reports for 1459 N Avenue 57.'), d);
  ok('no address in the subject: found in the email text', d.uploads, ['p3:Report.pdf', 'p3:Sewerline.pdf']);

  d = fakeDrive();
  r = await run(msg('Fwd: Your Report', ['304 W Juanita Ave - Termite.pdf']), d);
  ok('address only in the PDF name', d.uploads, ['p4:304 W Juanita Ave - Termite.pdf']);

  d = fakeDrive();
  r = await run(msg('Re: NEW DEAL - 1707 S STANLEY', ['Roof Inspection.pdf']), d);
  ok('same house number on two deals: the street word picks Stanley', d.uploads, ['p5:Roof Inspection.pdf']);

  d = fakeDrive({ p2: ['WDO 5340 Calvin.pdf'] });
  r = await run(msg('RE: 5340 Calvin Termite Report', ['WDO 5340 Calvin.pdf']), d);
  ok('already in the folder: not filed twice', [d.uploads, F.summary(r)], [[], 'INSPECTION already in "5340 Calvin Ave": WDO 5340 Calvin.pdf']);

  d = fakeDrive();
  r = await run(msg('Termite clearance I 304 W Juanita Ave', ['Section 1 clearance.pdf', 'Invoice 3321.pdf', 'Receipt for Funds Received in Escrow.pdf', 'RR signed.pdf']), d);
  ok('invoice + clearance filed; an escrow funds receipt and the RR are not',
    d.uploads, ['p4:Section 1 clearance.pdf', 'p4:Invoice 3321.pdf']);

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
  r = await run({ id: 'm', headers: { subject: 'Inspection Report | 410 N Crescent Heights' }, attachments: [], newestText: 'Here is the Spectora link' }, d,
    { classifier: { reason: 'Inspection report linked via Spectora routes to Belle' } });
  ok('a link with no PDF: logged, nothing filed', [d.uploads, /no PDF attached/.test(F.summary(r))], [[], true]);

  process.env.INSPECTION_FILING = 'off';
  d = fakeDrive();
  r = await run(msg('Inspection Reports | 410 N Crescent Heights', ['Home Inspection.pdf']), d);
  ok('off switch', [d.uploads, r], [[], null]);
  delete process.env.INSPECTION_FILING;

  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nall inspection-filer checks pass');
})();
