// checks/pdf-unlock.js
//
// An owner-password-locked PDF (anyone can open it; its contents are encrypted
// on disk) is unlocked before pdf-lib copies it. 8808 Thrasher (2026-10-29):
// 16 of 20 incoming files were locked, every one was rebuilt from page images,
// and the package step ran out of time three times with no buyer draft.
//   node checks/pdf-unlock.js

const { PDFDocument, StandardFonts } = require('pdf-lib');
const Cantoo = require('@cantoo/pdf-lib');
const { unlockPdf, isEncrypted } = require('../netlify/functions/lib/pdf-repair.js');
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }
const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
const copies = (buf) => quiet(async () => { try { const d = await PDFDocument.load(buf, { ignoreEncryption: true }); const o = await PDFDocument.create(); (await o.copyPages(d, d.getPageIndices())).forEach((p) => o.addPage(p)); await o.save(); return true; } catch { return false; } });

(async () => {
  // A locked file like the listing side's: an owner password, an empty user password.
  const doc = await Cantoo.PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage().drawText(`TDS page ${i + 1}`, { x: 50, y: 700, font: await doc.embedFont(Cantoo.StandardFonts.Helvetica) });
  doc.encrypt({ ownerPassword: 'owner-secret', userPassword: '', permissions: { printing: 'highResolution', modifying: false, copying: false } });
  const locked = Buffer.from(await doc.save({ useObjectStreams: true }));

  ok('the locked file is seen as encrypted', isEncrypted(locked), true);
  // (The real Thrasher files failed to copy before unlocking and copied after, 16 of 16,
  // tested on 2026-10-29; they are deal documents, so they are not kept in the repo.)
  const r = await unlockPdf(locked);
  ok('it is unlocked', r.unlocked, true);
  ok('and then copies, all three pages', await copies(r.buf), true);

  const plainDoc = await PDFDocument.create();
  plainDoc.addPage().drawText('SPQ', { x: 50, y: 700, font: await plainDoc.embedFont(StandardFonts.Helvetica) });
  const plain = Buffer.from(await plainDoc.save());
  const r2 = await unlockPdf(plain);
  ok('a file that is not locked comes back untouched (same bytes)', r2.buf === plain && !r2.unlocked, true);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall pdf-unlock checks pass');
  process.exit(failed ? 1 : 0);
})();
