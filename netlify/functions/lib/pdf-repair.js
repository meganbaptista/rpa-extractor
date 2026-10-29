// netlify/functions/lib/pdf-repair.js
//
// LOCKED PDFs, UNLOCKED BEFORE A PACKAGE IS ASSEMBLED.
//
// 8808 Thrasher (2026-10-29): 16 of 20 incoming files were encrypted by the
// listing side's signing program with an OWNER password only: anyone can open
// and read them (pdf.js renders them), but the contents are encrypted on disk.
// pdf-lib cannot decrypt, so it read scrambled objects, copyPages failed, and
// every file was rebuilt from page images. Hundreds of image pages ran the
// package step out of time, three tries each: 8808 Thrasher, 2170 Century Park
// East #408S and 26701 Quail Creek #261 got no buyer draft at all.
//
// @cantoo/pdf-lib (MIT, a maintained pdf-lib fork) opens such a file with the
// EMPTY user password and saves it unencrypted, in milliseconds (the 154-page
// RFR in under a second). A file that is not encrypted comes back untouched, the
// same Buffer; one that needs a real password (nobody could open it) is left as
// it was, and the old rebuild-from-images path still catches it.

let Cantoo = null;
const cantoo = () => (Cantoo ??= require('@cantoo/pdf-lib'));

/** True when the file declares encryption (its trailer names an /Encrypt dictionary). */
function isEncrypted(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return false;
  // The trailer (or a cross-reference stream's dictionary) carries /Encrypt; it sits near the end
  // in an ordinary file, and near the start in a linearized one, so both ends are read.
  const tail = buf.subarray(Math.max(0, buf.length - 4096)).toString('latin1');
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
  return /\/Encrypt\s+\d+\s+\d+\s+R/.test(tail) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(head);
}

/** { buf, unlocked }: the file without its owner-password lock, or the same file. */
async function unlockPdf(buf) {
  if (!isEncrypted(buf)) return { buf, unlocked: false };
  const quiet = console.log;
  try {
    console.log = () => {};   // pdf-lib narrates every odd object it meets
    const { PDFDocument } = cantoo();
    const doc = await PDFDocument.load(buf, { password: '' });
    const out = Buffer.from(await doc.save({ useObjectStreams: false }));
    return { buf: out, unlocked: true };
  } catch {
    return { buf, unlocked: false };
  } finally {
    console.log = quiet;
  }
}

module.exports = { isEncrypted, unlockPdf };
