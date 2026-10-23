// checks/package-assemble.js
//
// Stage 2 of the automatic buyer package: the assembler's text checks
// (duplicates, wrong property, signature-only tails, FX contract documents),
// the PDF build (order, damaged-file fallback, blank pages), filing (never
// overwrite her package, TRASH only after saving) and the drop-in rules.
// Made-up text and PDFs only; the real runs (2647 E Wilson, 5733 E Stillwater
// #2) are in ~/Code/rpkg-tools/assemble-run.js.
//   node checks/package-assemble.js

const { PDFDocument } = require('pdf-lib');
const A = require('../netlify/functions/lib/package-assemble.js');
const D = require('../netlify/functions/lib/package-dropins.js');
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

const lorem = (seed, n = 60) => Array.from({ length: n }, (_, i) => `word${seed}x${i} alpha${(seed * 7 + i) % 13} beta${i % 5}`).join(' ');

(async () => {
  // ---- duplicates ----
  const combined = { n: 0, name: 'Disclosures.pdf', texts: [1, 2, 3, 4, 5, 6].map((p) => ({ num: p, text: lorem(p) })) };
  const permits = { n: 1, name: 'Permits.pdf', texts: [{ num: 1, text: lorem(4) }, { num: 2, text: lorem(5) }] };
  const other = { n: 2, name: 'Roof.pdf', texts: [{ num: 1, text: lorem(99) }] };
  const scan = { n: 3, name: 'Scan.pdf', texts: [{ num: 1, text: '' }] };
  const dealCopy = { key: 'd:abc', name: 'Roof copy.pdf', texts: [{ num: 1, text: lorem(99) }] };
  const dups = A.findDuplicates([combined, permits, other, scan, dealCopy]);
  ok('a file whose pages are inside the combined PDF is a duplicate', JSON.stringify(dups.find((d) => d.n === 1) && dups.find((d) => d.n === 1).pages), '[4,5]');
  ok('the duplicate names where it already is', dups.find((d) => d.n === 1).of, 'Disclosures.pdf pages 4-5');
  ok('a different report is not a duplicate', dups.some((d) => d.n === 2), false);
  ok('an image-only file is never called a duplicate', dups.some((d) => d.n === 3), false);
  ok('same-size copy: the deal-folder copy goes, the delivered one stays', dups.some((d) => d.key === 'd:abc') && !dups.some((d) => d.n === 2), true);

  // ---- wrong property ----
  const nhd = { n: 4, name: 'NHD Report.pdf', texts: [{ num: 1, text: 'Natural hazard disclosure for 5722 E Stillwater Ave Orange' }, { num: 2, text: 'more about 5722 Stillwater' }] };
  const pkgPage = { n: 0, name: 'Disclosures.pdf', texts: [{ num: 1, text: 'TDS for 5733 E Stillwater Ave #2' }, { num: 71, text: 'NHD statement 5722 E. Stillwater Ave' }] };
  const neighbour = { n: 5, name: 'HOA.pdf', texts: [{ num: 1, text: 'Units 5733 Stillwater and 5722 Stillwater share a wall' }] };
  const wp = A.findWrongProperty([nhd, pkgPage, neighbour], '5733 E Stillwater Ave #2, Orange, CA 92869');
  ok('a report all about another house number is wrong property (whole file)', JSON.stringify(wp.find((w) => w.n === 4)), JSON.stringify({ n: 4, why: 'it is for 5722 Stillwater, not 5733 Stillwater' }));
  ok('one wrong page inside the combined PDF is flagged by page', JSON.stringify(wp.find((w) => w.n === 0).pages), '[71]');
  ok('a page naming our number too is fine', wp.some((w) => w.n === 5), false);

  // ---- signature-only tails ----
  const tailSrc = [{ n: 0, texts: [{ num: 100, text: 'X_________ BUYER x_________ BUYER x_______ BUYER' }, { num: 101, text: lorem(1) }, { num: 102, text: 'Date' }] }];
  ok('a page of only buyer signature words is a tail candidate', JSON.stringify(A.findTailCandidates(tailSrc)), '[{"n":0,"page":100}]');
  const fakeRender = async (buf, nums) => nums.map((n) => ({ pageNumber: n, base64: 'x' }));
  ok('a near-empty signature page moves', JSON.stringify(await A.findTails(tailSrc, { getBytes: async () => null, render: fakeRender, ink: async () => 0.01 })), '[{"n":0,"page":100}]');
  ok('a SCANNED page with stamped signature tags does not (Stillwater p100)', (await A.findTails(tailSrc, { getBytes: async () => null, render: fakeRender, ink: async () => 0.14 })).length, 0);
  ok('without a renderer nothing moves', (await A.findTails(tailSrc)).length, 0);

  // ---- FX contract documents ----
  const files = [{ n: 0, forms: [
    { code: 'FHDA', name: 'FAIR HOUSING AND DISCRIMINATION ADVISORY', pages: [1, 2] },
    { code: '', name: 'AFFILIATED BUSINESS ARRANGEMENT DISCLOSURE STATEMENT', pages: [4] },
    { code: '', name: 'Affiliated Business Arrangement Disclosure Statement', pages: [88] },
    { code: 'SBSA', name: 'STATEWIDE BUYER AND SELLER ADVISORY', pages: [11] },
  ] }];
  const fxTexts = [{ n: 0, texts: [{ num: 4, text: 'AFFILIATED BUSINESS ARRANGEMENT Notice To: From: Side, Inc. ("Side")' }, { num: 88, text: 'Seven Gables Real Estate Affiliated Business Arrangement' }] }];
  const fx = A.findContractDocs(files, fxTexts, [{ code: 'FHDA' }, { code: 'ABA', brokerage: 'Side', name: 'FX - SIDE ABA' }]);
  ok('FHDA the contract audit wanted is FX', fx.some((f) => f.name === 'FX - FHDA' && f.pages.join() === '1,2'), true);
  ok('our brokerage ABA is FX', fx.some((f) => f.name === 'FX - SIDE ABA' && f.pages.join() === '4'), true);
  ok("the listing brokerage's ABA stays a disclosure", fx.some((f) => f.pages.includes(88)), false);
  ok('no contract items = nothing is FX', A.findContractDocs(files, fxTexts, []).length, 0);

  // ---- building ----
  const mk = async (sizes) => { const d = await PDFDocument.create(); for (const w of sizes) d.addPage([w, 792]); return Buffer.from(await d.save()); };
  const bufs = { f0: await mk([601, 602, 603, 604]), f1: await mk([611, 612]) };
  const deps = {
    getBytes: async (src) => (src.type === 'file' ? bufs[`f${src.n}`] : Buffer.from('not a pdf')),
    pageCount: async () => 2,
    render: async (buf, nums, scale) => {
      const c = require('@napi-rs/canvas').createCanvas(Math.round(612 * scale), Math.round(792 * scale));
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      return nums.map((n) => ({ pageNumber: n, base64: c.toBuffer('image/png').toString('base64') }));
    },
    pageTexts: async () => [],
  };
  const built = await A.buildPdf([
    { src: { type: 'file', n: 1 }, pages: [2], label: 'b2' },
    { src: { type: 'file', n: 0 }, pages: [3, 4], label: 'a34' },
    { src: { type: 'file', n: 0 }, pages: null, label: 'a-all' },
  ], deps);
  const doc = await PDFDocument.load(built.bytes);
  ok('pages come out in plan order', doc.getPages().map((p) => Math.round(p.getWidth())).join(), '612,603,604,601,602,603,604');
  ok('ranges per part', JSON.stringify(built.ranges), '[[1,1],[2,3],[4,7]]');
  const broken = await A.buildPdf([{ src: { type: 'extra', key: 'x0' }, pages: [1, 2], label: 'damaged report' }], deps);
  ok('a damaged file is rebuilt from images, not dropped', `${broken.pages}:${broken.rebuilt.join()}`, '2:damaged report');
  ok('asking for a page the file does not have refuses', await A.buildPdf([{ src: { type: 'file', n: 1 }, pages: [5], label: 'x' }], deps).then(() => 'built', (e) => (/not all in/.test(e.message) ? 'refused' : e.message)), 'refused');

  // blank check: a white render of a page whose source has words is a problem
  const blank = await A.blankPages({ bytes: bufs.f1, pages: 2, sources: [{ src: { type: 'file', n: 1 }, page: 1, label: 'TDS' }, { src: { type: 'file', n: 1 }, page: 2, label: 'blank in the original' }] },
    { ...deps, ink: undefined }, async (src, page) => (page === 1 ? 'the seller answered every question here' : ''));
  ok('blank check flags a page that lost its text', blank.problems.map((p) => p.page).join(), '1');

  // ---- filing ----
  const calls = [];
  const drive = {
    uploadMultipart: async ({ name }) => { calls.push(`up:${name}`); },
    ensureFolder: async (name) => { calls.push(`folder:${name}`); return { id: 'trash' }; },
    moveFile: async (id, o) => { calls.push(`move:${id}->${o.addParents[0]}`); },
  };
  const pkg = { name: 'Disclosures - 1 Main St.pdf', pkg: { bytes: Buffer.from('x') }, attachments: [{ name: 'Preliminary Title Report.pdf', bytes: Buffer.from('y') }], fx: [{ name: 'FX - FHDA.pdf', bytes: Buffer.from('z') }] };
  const kept = await A.fileToDealFolder(drive, { folder: { id: 'deal' }, files: [{ name: 'Disclosures - 1 Main St.pdf' }] }, pkg, { trash: [{ id: 's1', name: 'src.pdf' }] });
  ok("her package already there: nothing saved, nothing trashed", `${calls.length}:${kept.kept.join()}`, '0:Disclosures - 1 Main St.pdf');
  const res = await A.fileToDealFolder(drive, { folder: { id: 'deal' }, files: [{ name: 'Preliminary Title Report.pdf' }] }, pkg, { trash: [{ id: 's1', name: 'src.pdf' }] });
  ok('saves package + FX at the top, keeps an existing attachment, then trashes sources', calls.join('|'), 'up:Disclosures - 1 Main St.pdf|up:FX - FHDA.pdf|folder:TRASH FOLDER|move:s1->trash');
  ok('the existing attachment is reported as kept', res.kept.join(), 'Preliminary Title Report.pdf');

  // ---- drop-ins ----
  const dealFiles = [
    { id: 'p', name: 'Property Profile.pdf', pages: 4 },
    { id: 'm', name: 'MLS CLIENT TO SIGN.pdf', pages: 2, texts: [{ num: 1, text: lorem(1) }, { num: 2, text: 'Printed 10/22 page 2' }] },
    { id: 't', name: 'Termite Inspection.pdf', pages: 7 },
    { id: 'pr', name: 'Prelim Title Report.pdf', pages: 20 },
    { id: 'o', name: 'Disclosures - 1 Main St.pdf', pages: 50 },
    { id: 'b', name: 'Buyer Report - Home Inspection.pdf', pages: 40 },
    { id: 'tpl', name: 'Audit Disclosures - 1 Main St.pdf.pdf', pages: 55 },
  ];
  const template = { id: 'tpl', name: 'Audit Disclosures - 1 Main St.pdf.pdf', texts: [{ num: 54, text: 'AFFILIATED BUSINESS ARRANGEMENT From: Compass' }], forms: [
    { code: 'DIA', name: 'DISCLOSURE INFORMATION ADVISORY', pages: [1, 2, 3] },
    { code: 'LPD', name: 'LEAD-BASED PAINT', pages: [19, 20] },
    { code: 'BHAA', name: "BUYER'S HOMEOWNERS' ASSOCIATION ADVISORY", pages: [38, 39] },
    { code: 'WFDA', name: 'WILDFIRE DISASTER ADVISORY', pages: [40, 41] },
    { code: '', name: 'LOCAL AREA DISCLOSURES', pages: [42, 43, 44, 45, 46, 47, 48] },
    { code: '', name: 'Receipt for Links to Booklets', pages: [49] },
    { code: '', name: 'AFFILIATED BUSINESS ARRANGEMENT DISCLOSURE STATEMENT', pages: [54, 55] },
  ] };
  const d1 = D.planDropIns({ dealFiles, template, deliveredCodes: ['TDS', 'SPQ', 'WFDA'], wantedCodes: ['DIA', 'LPD', 'BHAA', 'WFDA'], buyerBrokerage: 'Compass' });
  ok('profile from the deal folder', d1.dropIns.profile && d1.dropIns.profile.id, 'p');
  ok('MLS footer-only page dropped', JSON.stringify(d1.dropIns.mls.pages), '[1]');
  ok('DIA is never dropped in; delivered WFDA not twice; LPD + BHAA from the template', d1.dropIns.forms.map((f) => f.code).join(), 'LPD,BHAA');
  ok('LPD gets a note for Megan', d1.notes.some((n) => /LPD/.test(n)), true);
  ok('our brokerage pages = after the C.A.R. forms, not local area', JSON.stringify(d1.dropIns.ourBrokerage[0].pages), '[49,54,55]');
  ok('brokerage named in page text: no warning', d1.warnings.some((w) => /do not name/.test(w)), false);
  ok('no AVID in the deal folder = none added', d1.dropIns.ourAvid, null);
  ok('our BLANK AVID in the deal folder is added (blank is correct)', (D.planDropIns({ dealFiles: [{ id: 'ab', name: 'Our AVID - Blank.pdf', pages: 3 }] }).dropIns.ourAvid || {}).id, 'ab');
  ok('only the termite report is a deal-folder seller report', d1.reports.map((r) => r.name).join(), 'Termite Inspection.pdf');
  const d2 = D.planDropIns({ dealFiles: dealFiles.concat([{ id: 'n', name: 'SIDE MCA (NEED S).pdf', pages: 6 }, { id: 'av', name: 'AVID - Buyer Agent.pdf', pages: 3 }]), template, deliveredCodes: [], wantedCodes: null, buyerBrokerage: 'Side' });
  ok('brokerage forms signed with the offer are not added again', d2.dropIns.ourBrokerage.length, 0);
  ok('a filled AVID in the deal folder is added', d2.dropIns.ourAvid && d2.dropIns.ourAvid.id, 'av');
  ok('the NEED S file is not a seller report', d2.reports.some((r) => /NEED S/.test(r.name)), false);
  const d3 = D.planDropIns({ dealFiles, template, deliveredCodes: [], wantedCodes: null, buyerBrokerage: 'Rodeo Realty' });
  ok("template pages that do not name the buyer's brokerage are warned", d3.warnings.some((w) => /do not name Rodeo Realty/.test(w)), true);

  // 4180 Sunnyslope: the template's local area advisory is not brokerage pages,
  // and the firm's own "<Firm> DISC.pdf" in the deal folder is used instead.
  const sfv = { ...template, texts: [], forms: template.forms.concat([{ code: '', name: 'SAN FERNANDO VALLEY LOCAL AREA DISCLOSURE ADVISORY', pages: [56, 57, 58] }]).filter((f) => f.pages[0] < 49 || f.pages[0] > 55) };
  const d4 = D.planDropIns({ dealFiles, template: sfv, deliveredCodes: [], wantedCodes: null, buyerBrokerage: 'Equity union' });
  ok('a local area advisory on the template is not our brokerage pages', d4.dropIns.ourBrokerage.length, 0);
  const d5 = D.planDropIns({ dealFiles: dealFiles.concat([{ id: 'eu', name: 'Equity Union DISC.pdf', pages: 2 }]), template, deliveredCodes: [], wantedCodes: null, buyerBrokerage: 'Equity union' });
  ok("the firm's own DISC file beats the template pages", d5.dropIns.ourBrokerage.map((b) => b.src.id).join(), 'eu');
  ok('the firm file is not a seller report', d5.reports.some((r) => r.src.id === 'eu'), false);

  // The profile from FX PURCHASE AGREEMENT when the top has none (4180 Sunnyslope).
  const fxProfile = D.planDropIns({ dealFiles: [{ id: 'fp', name: 'FX - Property Profile.pdf', pages: 4, inFx: true }, { id: 'c', name: 'FX - CONTRACT.pdf', pages: 30, inFx: true }] });
  ok('profile found in FX PURCHASE AGREEMENT', (fxProfile.dropIns.profile || {}).id, 'fp');
  ok('nothing else in FX PURCHASE AGREEMENT is used', fxProfile.reports.length, 0);
  const both = D.planDropIns({ dealFiles: [{ id: 'top', name: 'Property Profile.pdf', pages: 4 }, { id: 'fp', name: 'Property Profile.pdf', pages: 4, inFx: true }] });
  ok('the top-level profile wins', both.dropIns.profile.id, 'top');

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall package-assemble checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
