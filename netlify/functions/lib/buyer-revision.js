// netlify/functions/lib/buyer-revision.js
//
// The buyer REVISION reply, shared by the hand trigger
// (buyer-revision-draft-background.js) and the intake job's revdraft step, so
// the two cannot drift. The body itself is lib/buyer-email.js
// buildRevisionEmail; this file finds the thread, merges the PDF, saves it to
// the deal folder and creates the draft. Drafts only, never sends.

const { PDFDocument } = require('pdf-lib');
const { buildMime } = require('./mime');

const streetOf = (address) => String(address || '').split(',')[0].trim();
const GMAIL_MAX_RAW = 25 * 1024 * 1024;

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
  const folders = (await drive.findFoldersNameContains(street))
    .filter((f) => String(f.name || '').toLowerCase().startsWith(street.toLowerCase()));
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

/** PDFs (Buffers, in order) -> one PDF. */
async function mergePdfs(bufs) {
  const out = await PDFDocument.create();
  const parts = [];
  for (const buf of bufs) {
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    parts.push(pages.length);
  }
  return { bytes: Buffer.from(await out.save()), pages: out.getPageCount(), parts };
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
async function createRevisionDraft(gmail, { pkg, html, pdfName, pdfBytes, labels, inThread, to = '', subjectPrefix = '' }) {
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
  const created = await gmail.createDraftRaw(raw, inThread ? { threadId: pkg.msg.threadId } : {});
  const newMsgId = created && created.message && created.message.id;
  const found = await Promise.all((labels || []).map((n) => gmail.labelId(n)));
  const ids = found.filter(Boolean);
  if (newMsgId && ids.length) await gmail.modifyMessage(newMsgId, { add: ids });
  return { draftId: created && created.id, rawBytes: raw.length, labelled: (labels || []).filter((_, i) => found[i]), headers };
}

module.exports = { streetOf, findSentPackage, findDealFolder, mergePdfs, saveToDealFolder, createRevisionDraft, GMAIL_MAX_RAW };
