// checks/vendome-rules.js
//
// 135 S Vendome (2026-10-29), after Google Drive links were read:
//  1. The seller's own typed "Addendum to the Transfer Disclosure Statement and
//     Seller's Property Questionnaire" (3 pages) must reach the review. The page
//     picker took page 11 and left 9-10, so ten "see addendum" answers were
//     asked about although the addendum explained them.
//  2. Tenant lease paperwork (signed 2021-2022) is not "a previous sale": the
//     email told the agent so. It is set aside quietly instead.
//   node checks/vendome-rules.js

const M = require('../netlify/functions/disclosure-intake-check-background.js');
const I = M._internal;
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

// 1. THE SELLER'S ADDENDUM PAGES
const filler = ' The seller states the following facts about the property and its condition for the buyer to review.'.repeat(4);
const head = 'Addendum to the Transfer Disclosure Statement and Seller’s Property\nQuestionnaire dated October 23, 2026 for address 135-137 N Vendome\nStreet Los Angeles, CA 90026\n';
const texts = [
  { num: 1, text: 'STATEWIDE BUYER AND SELLER ADVISORY (C.A.R. Form SBSA, Revised 6/26)' + filler },
  { num: 2, text: head + '● The property contains 3 units. The rear units are rented.' + filler },
  { num: 3, text: head + '● 135 ½ + 135 share a two car garage.' + filler },
  { num: 4, text: head + 'Effective May 1, 2026: base rent increases.' + filler },
  { num: 5, text: 'MARKET CONDITIONS ADVISORY (C.A.R. Form MCA, Revised 6/24)' + filler },
];
const sel = I.selectQAPagesFromText(texts, 5);
ok('every page of the seller’s addendum goes to the review', [2, 3, 4].every((n) => sel.pages.includes(n)), true);
ok('the advisories around it do not', sel.pages.includes(1) || sel.pages.includes(5), false);
ok('a TDS that only says "see attached addendum" is not an addendum', I.isSellerAddendum('REAL ESTATE TRANSFER DISCLOSURE STATEMENT (C.A.R. Form TDS) ... see attached addendum'), false);
ok('"Seller Explanations" heading counts', I.isSellerAddendum('SELLER EXPLANATIONS for 14951 Camarosa'), true);

// 2. TENANT LEASE PAPERWORK (the Vendome set, as the run read it)
const v = (code, name, signed, seller = 'Thelma Sazon') => ({ code, name, signed, seller, vintage: { band: 'historical', reason: signed ? 'age' : 'party', signed } });
const historical = [
  v('TEC', 'Tenant Estoppel Certificate', '', 'Kenneth Hsiang Jr., Thelma Sazon, Owner'),
  v('LR', 'Residential Lease or Month-to-Month Rental Agreement', '5/25/2022'),
  v('BBD', 'Bed Bug Disclosure', '2/16/2022'),
  v('TFHD', 'Tenant Flood Hazard Disclosure', '2/16/2022'),
  v('RCJC', 'Rent Cap and Just Cause Addendum', '5/25/2022'),
  v('CMD', 'Carbon Monoxide Detector Notice', '4/26/2021'),
  v('KLA', 'Keysafe/Lockbox Addendum and Tenant Permission to Access Property', '4/26/2021'),
  v('LRM', 'Lease/Rental Mold and Ventilation Addendum', '4/26/2021'),
  v('DBD', 'Megan\'s Law Data Base Disclosure', '4/26/2021'),
  v('WHSD', 'Water Heater and Smoke Detector Statement of Compliance', '4/26/2021'),
  // A real prior sale's TDS, years before any lease: stays "prior sale".
  v('TDS', 'Real Estate Transfer Disclosure Statement', '3/2/2016', 'Someone Else'),
  v('WHSD', 'Water Heater and Smoke Detector Statement of Compliance', '3/2/2016', 'Someone Else'),
];
const { leases, prior } = I.splitLeasePaperwork(historical);
ok('all ten lease documents are set aside as lease paperwork', leases.length, 10);
ok('a real prior sale (TDS and its WHSD, 2016) is still a prior sale', prior.map((f) => f.code).join(','), 'TDS,WHSD');
ok('a Tenant Occupied Property Addendum is never lease paperwork (it is a sale form)', I.isLeaseDocument({ code: 'TOPA', name: 'Tenant Occupied Property Addendum' }), false);

// 3. INLINE PDFs ARE ATTACHMENTS (370 Electric, 2026-10-29: 17 PDFs marked
//    inline by the sender's mail program read as "0 attachment(s)").
const G = require('../netlify/functions/lib/gmail.js');
const part = (filename, mimeType, disp) => ({ filename, mimeType, body: { attachmentId: `a-${filename}`, size: 10 }, headers: [{ name: 'Content-Disposition', value: `${disp}; filename="${filename}"` }] });
const rosi = { mimeType: 'multipart/mixed', parts: [
  { mimeType: 'text/html', body: { size: 100 }, headers: [] },
  part('image001.png', 'image/png', 'inline'),
  part('Real Estate Transfer Disclosure Statement.pdf', 'application/pdf', 'inline'),
  part('Seller Property Questionnaire.pdf', 'application/pdf', 'inline'),
  part('MASTER ABA 630.pdf', 'application/pdf', 'attachment'),
] };
ok('inline PDFs count, the inline signature logo does not', G.collectAttachments(rosi).map((a) => a.filename).join(' | '), 'Real Estate Transfer Disclosure Statement.pdf | Seller Property Questionnaire.pdf | MASTER ABA 630.pdf');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall vendome-rules checks pass');
process.exit(failed ? 1 : 0);
