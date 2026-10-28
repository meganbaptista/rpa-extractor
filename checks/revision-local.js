// checks/revision-local.js
//
// Local area disclosures still open on a revision come from OUR package (the
// deal's Audit Disclosures template, printed with this property's address),
// unless the seller fills the form in (Santa Clarita / SCV, Santa Monica).
// Megan, 2026-10-26 (2506 Westminster) and 2026-10-27.
//   node checks/revision-local.js

const RL = require('../netlify/functions/lib/revision-local.js');
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

(async () => {
  const items = [
    { status: 'open', item: 'Orange County Local Area Disclosures' },
    { status: 'open', item: 'Santa Clarita Valley Local Area Disclosures' },
    { status: 'open', item: 'Santa Monica Local Area Disclosures' },
    { status: 'fixed', item: 'San Fernando Local Area Disclosures' },
    { status: 'open', item: 'Trust Advisory' },
  ];
  const lc = RL.localItems(items);
  ok('Orange County: we add ours', lc.ours.map((v) => v.item).join(), 'Orange County Local Area Disclosures');
  ok('Santa Clarita and Santa Monica: the seller fills them, still a request', lc.theirs.map((v) => v.item).join(' | '), 'Santa Clarita Valley Local Area Disclosures | Santa Monica Local Area Disclosures');
  ok('buyer line', RL.buyerLine('Orange County Local Area Disclosures'), 'The Orange County local area disclosures, for your review and signature.');

  // Page detection: the form's capitals, not the SBSA's "Local Disclosures and Advisories".
  const texts = [
    { num: 30, text: 'G. Local Disclosures and Advisories ... local area disclosures may apply' },
    { num: 42, text: 'LOCAL AREA DISCLOSURES Property Address: ...' },
    ...[43, 44, 45, 46, 47, 48].map((num) => ({ num, text: "Buyer's Initials ( ) LOCAL AREA DISCLOSURES – ORANGE COUNTY 10/24" })),
    { num: 49, text: 'Receipt for Links to Booklets' },
  ];
  ok('the seven OC pages, not the SBSA page', RL.localPages(texts, null).join(), '42,43,44,45,46,47,48');
  ok('unreadable text: the page reader map is used', RL.localPages([], [{ name: 'LOCAL AREA DISCLOSURES', pages: [40, 41] }]).join(), '40,41');

  // From the deal folder, with fakes.
  const deps = (files, pdfTexts) => ({
    drive: { download: async () => Buffer.from('x') },
    findDealFolder: async () => ({ folder: { id: 'f' }, files }),
    pageTexts: async () => pdfTexts,
    pickPages: async (buf, pages) => Buffer.from(`pages ${pages.join(',')}`),
    strips: null,
  });
  const got = await RL.fromOurPackage('1 Main St', deps([{ id: 't', name: 'Audit Disclosures - 1 Main St.pdf.pdf' }], texts));
  ok('taken from the deal template', `${got.pages}|${got.bytes.toString()}`, '7|pages 42,43,44,45,46,47,48');
  ok('no template: says why', (await RL.fromOurPackage('1 Main St', deps([], texts))).why, 'no Audit Disclosures template in the deal folder');

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall revision-local checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
