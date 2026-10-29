// netlify/functions/lib/buyer-revision.js
//
// The buyer REVISION reply, shared by the hand trigger
// (buyer-revision-draft-background.js) and the intake job's revdraft step, so
// the two cannot drift. The body itself is lib/buyer-email.js
// buildRevisionEmail; this file finds the thread, merges the PDF, saves it to
// the deal folder and creates the draft. Drafts only, never sends.

const { PDFDocument } = require('pdf-lib');
const { unlockPdf } = require('./pdf-repair');
const { buildMime } = require('./mime');

// A duplex reads as a number range ("4180 - 4182 Sunnyslope Ave", 2026-10-23)
// while her folder and email subjects use the first number: search by that.
const streetOf = (address) => String(address || '').split(',')[0].trim().replace(/^(\d+)\s*[-–&]\s*\d+\s+/, '$1 ');
const GMAIL_MAX_RAW = 25 * 1024 * 1024;

// Street types and directions, each spelling -> one form.
const STREET_WORDS = {
  trail: 'trl', trl: 'trl', street: 'st', st: 'st', avenue: 'ave', ave: 'ave', av: 'ave',
  drive: 'dr', dr: 'dr', road: 'rd', rd: 'rd', lane: 'ln', ln: 'ln', court: 'ct', ct: 'ct',
  boulevard: 'blvd', blvd: 'blvd', place: 'pl', pl: 'pl', circle: 'cir', cir: 'cir',
  parkway: 'pkwy', pkwy: 'pkwy', highway: 'hwy', hwy: 'hwy', terrace: 'ter', ter: 'ter',
  way: 'way', wy: 'way', canyon: 'cyn', cyn: 'cyn', square: 'sq', sq: 'sq', point: 'pt', pt: 'pt',
  north: 'n', south: 's', east: 'e', west: 'w',
};
const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
/** "Deer Trail, Yucca Valley" and "Deer Trl" -> "deer trl yucca valley" / "deer trl". */
const streetKey = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim().split(/\s+/).map((w) => STREET_WORDS[w] || w).join(' ');
/** The word Drive is searched by: the street's own name, never "N" or the type. */
const nameWord = (rest) => String(rest).split(/[\s,]+/).find((w) => w.length > 1 && !DIRECTIONS.has(w.toLowerCase())) || rest;

/** The package email she SENT for this deal (newest), or null. */
async function findSentPackage(gmail, address) {
  const street = streetOf(address);
  if (!street) return null;
  const hits = await gmail.listMessages({ q: `in:sent subject:"Seller Disclosure Package" "${street}"`, maxPages: 1, pageSize: 10 });
  if (!hits.length) return null;
  const msgs = await Promise.all(hits.map((m) => gmail.getMessage(m.id)));
  msgs.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
  // The ORIGINAL package email carries the greeting; a later "Re:" is ours too.
  const original = msgs.filter((m) => !/^\s*re:/i.test((m.headers && m.headers.subject) || '')).pop() || msgs[msgs.length - 1];
  return { msg: msgs[0], original, others: msgs.length - 1 };
}

/**
 * The deal folder: the one holding "Disclosures - <address>.pdf" (where the
 * package was saved), else the ONLY folder named after the street. Two or more
 * candidates without the package is ambiguous, so nothing is saved; `seen`
 * lists what was looked at for the result.
 */
async function findDealFolder(drive, address) {
  const street = streetOf(address);
  // The number, then the rest of the street: "4180 Sunnyslope Ave" finds
  // "4180 Sunnyslope Ave, ..." and also a folder named "4180-4182 Sunnyslope Ave".
  // The street type in either spelling (2073 Deer Trl, 2026-10-29: the folder
  // said "Trail"), so Drive is searched by the street's NAME word, not "Deer Trl".
  const m = street.match(/^(\d+)\s+(.+)$/);
  const rest = m ? m[2] : street;
  const want = streetKey(rest);
  const folders = (await drive.findFoldersNameContains(nameWord(rest)))
    .filter((f) => {
      const n = String(f.name || '').toLowerCase();
      return m ? n.startsWith(m[1]) && ` ${streetKey(n.slice(m[1].length))} `.includes(` ${want} `) && !/^\d/.test(n.slice(m[1].length)) : n.startsWith(street.toLowerCase());
    });
  const seen = [];
  for (const f of folders) {
    const files = await drive.listChildren(f.id, { excludeFolders: true });
    seen.push({ folder: f.name, pdfs: files.map((x) => x.name).filter((n) => /\.pdf$/i.test(n || '')).slice(0, 15) });
    if (files.some((x) => /^Disclosures - /i.test(x.name || ''))) return { folder: f, files, seen };
  }
  if (folders.length === 1) {
    return { folder: folders[0], files: await drive.listChildren(folders[0].id, { excludeFolders: true }), seen };
  }
  return { folder: null, files: [], seen };
}

/**
 * PDFs (Buffers, in order) -> one PDF.
 *
 * DAMAGED FILES. About one seller packet in six has broken internal object
 * references, and pdf-lib cannot copy their pages ("Expected instance of
 * PDFDict, but got instance of undefined"; 1222 N Kings Rd #8, 2026-10-22, the
 * Amendment to Prior Disclosure and the RFR). pdfjs reads them fine, so with
 * `render` (the intake's pdfjs page renderer) such a file's pages are rendered
 * as images and added instead; `rebuilt` names them for the check note.
 *   render(buf, pageNumbers, scale) -> [{ pageNumber, base64 png }]
 *   pageCount(buf) -> number
 */
const RENDER_SCALE = 2;
async function mergePdfs(bufs, { render, pageCount, names = [] } = {}) {
  const out = await PDFDocument.create();
  const parts = [];
  const rebuilt = [];
  for (let i = 0; i < bufs.length; i++) {
    // An owner-password lock is taken off first (8808 Thrasher, see lib/pdf-repair).
    const { buf } = await unlockPdf(bufs[i]);
    try {
      const src = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
      parts.push(pages.length);
    } catch (err) {
      if (!render || !pageCount) throw err;
      const n = await pageCount(buf);
      if (!n) throw new Error(`${names[i] || `file ${i + 1}`} could not be read: ${err.message}`);
      const imgs = await render(buf, Array.from({ length: n }, (_, k) => k + 1), RENDER_SCALE);
      if (imgs.length !== n) throw new Error(`${names[i] || `file ${i + 1}`}: rendered ${imgs.length} of ${n} pages`);
      for (const im of imgs.sort((a, b) => a.pageNumber - b.pageNumber)) {
        const png = await out.embedPng(Buffer.from(im.base64, 'base64'));
        const w = png.width / RENDER_SCALE; const h = png.height / RENDER_SCALE;
        out.addPage([w, h]).drawImage(png, { x: 0, y: 0, width: w, height: h });
      }
      parts.push(n);
      rebuilt.push(names[i] || `file ${i + 1}`);
    }
  }
  return { bytes: Buffer.from(await out.save()), pages: out.getPageCount(), parts, rebuilt };
}

/**
 * Only the given pages (1-based) of a PDF. A damaged file pdf-lib cannot copy
 * is rendered page by page instead, like mergePdfs.
 */
async function pickPages(locked, pages, { render } = {}) {
  const { buf } = await unlockPdf(locked);
  const out = await PDFDocument.create();
  try {
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    (await out.copyPages(src, pages.map((p) => p - 1))).forEach((p) => out.addPage(p));
  } catch (err) {
    if (!render) throw err;
    const imgs = await render(buf, pages, RENDER_SCALE);
    for (const im of imgs.sort((a, b) => a.pageNumber - b.pageNumber)) {
      const png = await out.embedPng(Buffer.from(im.base64, 'base64'));
      const w = png.width / RENDER_SCALE; const h = png.height / RENDER_SCALE;
      out.addPage([w, h]).drawImage(png, { x: 0, y: 0, width: w, height: h });
    }
  }
  return Buffer.from(await out.save());
}

/** Save next to the package unless a file of that name is already there. */
async function saveToDealFolder(drive, deal, name, bytes) {
  if (!deal || !deal.folder || deal.files.some((x) => x.name === name)) return false;
  await drive.uploadMultipart({ name, parents: [deal.folder.id], bytes });
  return true;
}

/**
 * Create the draft.
 *   inThread: true  -> reply in the package thread, to its recipients (live)
 *   inThread: false -> standalone, addressed to `to` (trial: Megan only)
 */
async function createRevisionDraft(gmail, { pkg, html, pdfName, pdfBytes, labels, inThread, to = '', subjectPrefix = '', replaceDraftId = '' }) {
  if (pdfBytes && pdfBytes.length * 1.37 > GMAIL_MAX_RAW) {
    throw new Error(`the PDF is ${Math.round(pdfBytes.length / 1048576)}MB, over Gmail's 25MB once encoded`);
  }
  const h = (pkg && pkg.msg && pkg.msg.headers) || {};
  const base = h.subject ? (/^re:/i.test(h.subject) ? h.subject : `Re: ${h.subject}`) : 'Revised disclosures';
  const headers = inThread
    ? { To: h.to, Cc: h.cc, Subject: base, 'In-Reply-To': h['message-id'], References: [h.references, h['message-id']].filter(Boolean).join(' ') }
    : { To: to, Subject: `${subjectPrefix}${base}` };
  const raw = buildMime({
    headers,
    html,
    attachments: pdfBytes ? [{ filename: pdfName, contentType: 'application/pdf', data: pdfBytes }] : [],
  });
  // replaceDraftId: correct a draft already made, in place (two drafts in one
  // thread cannot both be seen on her computer).
  const created = replaceDraftId ? await gmail.updateDraftRaw(replaceDraftId, raw)
    : await gmail.createDraftRaw(raw, inThread ? { threadId: pkg.msg.threadId } : {});
  const newMsgId = created && created.message && created.message.id;
  const found = await Promise.all((labels || []).map((n) => gmail.labelId(n)));
  const ids = found.filter(Boolean);
  if (newMsgId && ids.length) await gmail.modifyMessage(newMsgId, { add: ids });
  return { draftId: created && created.id, rawBytes: raw.length, labelled: (labels || []).filter((_, i) => found[i]), headers };
}

module.exports = { streetOf, findSentPackage, findDealFolder, mergePdfs, pickPages, saveToDealFolder, createRevisionDraft, GMAIL_MAX_RAW };
