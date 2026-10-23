// checks/mime.js
//
// Every attachment in a draft we build carries its OWN Content-ID and
// X-Attachment-Id. With none, Gmail sends every attachment as "Content-ID: <>",
// and Outlook / Apple Mail show the last file over and over (6051 Scenic Ave,
// 2026-10-23: the agent saw the prelim three times).
//   node checks/mime.js

const { buildMime } = require('../netlify/functions/lib/mime.js');
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

const raw = buildMime({
  headers: { To: 'a@example.com', Subject: 'Seller Disclosure Package | 1 Main St' },
  html: '<p>Hello</p>',
  attachments: ['Disclosures - 1 Main St.pdf', 'Natural Hazard Disclosure Report.pdf', 'Preliminary Title Report.pdf']
    .map((n, i) => ({ filename: n, contentType: 'application/pdf', data: Buffer.from(`file ${i}`) })),
});
const ids = [...raw.matchAll(/^Content-ID: <([^>]*)>\r?$/gm)].map((m) => m[1]);
const xids = [...raw.matchAll(/^X-Attachment-Id: (\S*)\r?$/gm)].map((m) => m[1]);
ok('one Content-ID per attachment', ids.length, 3);
ok('no blank Content-ID', ids.some((x) => !x), false);
ok('Content-IDs are all different', new Set(ids).size, 3);
ok('X-Attachment-Id matches its Content-ID', xids.join(), ids.join());
const parts = raw.split(/^--/m).filter((p) => /filename=/.test(p));
ok('each part keeps its own name and its own data',
  parts.map((p) => `${(p.match(/filename="([^"]+)"/) || [])[1]}=${Buffer.from(p.split(/\r\n\r\n/)[1].replace(/\s+/g, ''), 'base64').toString()}`).join('|'),
  'Disclosures - 1 Main St.pdf=file 0|Natural Hazard Disclosure Report.pdf=file 1|Preliminary Title Report.pdf=file 2');
ok('the ID headers sit in the part header, before the data', parts.every((p) => /Content-ID: <f_[0-9a-f]{16}>/.test(p.split(/\r\n\r\n/)[0])), true);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall mime checks pass');
process.exit(failed ? 1 : 0);
