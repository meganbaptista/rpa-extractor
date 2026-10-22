// netlify/functions/buyer-revision-draft-background.js
//
// DRAFTS THE BUYER REVISION EMAIL FOR ONE DEAL. When the listing side sends the
// revisions Megan asked for, the buyer gets the revised pages as a REPLY in the
// "Seller Disclosure Package | <address>" thread she sent (Megan, 2026-10-22:
// "reply in thread, not a new email"). This:
//   1. finds that sent package email (recipients, subject, thread),
//   2. merges the revised forms from the intake job that read the revision
//      email (its saved attachments), in the order given,
//   3. builds the body in her format (lib/buyer-email.js buildRevisionEmail)
//      and appends her live Gmail signature,
//   4. saves the PDF next to the package in the deal folder (never overwrites),
//   5. creates a reply draft with the PDF attached, labelled.
// It never sends. Result at out/buyer-email/<runId> in the jobs store.
//
// POST JSON (a background function: answers 202 at once):
//   { key, runId, address, jobId, docs: [n, ...]  (job attachment numbers, in order),
//     pdfName, greeting, changes: [{page,label}], forms: [full names],
//     stillToCome?: [], requested?: <count>, labels?: [...], preview?: true }
// `key` must equal meta/admin-key in the jobs store.
// preview: builds everything and saves the body, changes NOTHING.

const { PDFDocument } = require('pdf-lib');
const J = require('./lib/intake-job');
const rt = require('./lib/intake-runtime');
const gmail = require('./lib/gmail');
const drive = require('./lib/drive');
const { parseRequestBody } = require('./lib/parse-body');
const { buildRevisionEmail } = require('./lib/buyer-email');
const { buildMime } = require('./lib/mime');

const streetOf = (address) => String(address || '').split(',')[0].trim();
const GMAIL_MAX_RAW = 25 * 1024 * 1024;

/** The package email she SENT for this deal, newest first. */
async function findSentPackage(address) {
  const street = streetOf(address);
  const hits = await gmail.listMessages({ q: `in:sent subject:"Seller Disclosure Package" "${street}"`, maxPages: 1, pageSize: 10 });
  if (!hits.length) throw new Error(`no sent "Seller Disclosure Package" email mentions "${street}"`);
  const msgs = await Promise.all(hits.map((m) => gmail.getMessage(m.id)));
  msgs.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
  return { msg: msgs[0], others: msgs.length - 1 };
}

/** The deal folder holding "Disclosures - <address>.pdf" (where the package was saved). */
async function findDealFolder(address) {
  const street = streetOf(address);
  const folders = (await drive.findFoldersNameContains(street))
    .filter((f) => String(f.name || '').toLowerCase().startsWith(street.toLowerCase()));
  for (const f of folders) {
    const files = await drive.listChildren(f.id, { excludeFolders: true });
    if (files.some((x) => /^Disclosures - /i.test(x.name || ''))) return { folder: f, files };
  }
  return null;
}

async function mergeJobDocs(store, jobId, docs) {
  const out = await PDFDocument.create();
  const parts = [];
  for (const n of docs) {
    const buf = await J.getDoc(store, jobId, n);
    if (!buf) throw new Error(`job ${jobId} has no attachment #${n}`);
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    parts.push(pages.length);
  }
  return { bytes: Buffer.from(await out.save()), pages: out.getPageCount(), parts };
}

exports.handler = async function (event) {
  rt.connect(event);
  const store = rt.jobStore();
  const parsed = parseRequestBody(event);
  const b = (parsed.ok && parsed.body) || {};
  const runId = String(b.runId || `run-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '');
  const save = (result) => J.putOut(store, 'buyer-email', runId, { at: new Date().toISOString(), kind: 'revision', ...result });

  try {
    const meta = await store.get('meta/admin-key', { type: 'json', consistency: 'strong' });
    if (!meta || !meta.key || b.key !== meta.key) { console.warn('[buyer-revision] refused: bad key'); return { statusCode: 403 }; }
    if (!b.jobId || !Array.isArray(b.docs) || !b.docs.length) throw new Error('jobId and docs are required');
    if (!/\.pdf$/i.test(String(b.pdfName || ''))) throw new Error('pdfName must end in .pdf');

    const { msg, others } = await findSentPackage(b.address);
    const h = msg.headers || {};
    const pdf = await mergeJobDocs(store, b.jobId, b.docs);
    const built = buildRevisionEmail({
      greeting: b.greeting, changes: b.changes, forms: b.forms, totalPages: pdf.pages,
      stillToCome: b.stillToCome || [], requested: b.requested,
    });
    let signature = '';
    const warnings = [...built.warnings];
    try { signature = await gmail.fetchSignature(); } catch (e) { warnings.push(`signature not read (${e.message}); add it by hand`); }
    const html = built.html ? `${built.html}<div>--</div>${signature}` : '';
    const subject = /^re:/i.test(h.subject || '') ? h.subject : `Re: ${h.subject}`;
    const deal = await findDealFolder(b.address);
    const summary = {
      to: h.to, cc: h.cc || '', subject, threadId: msg.threadId, repliesTo: h['message-id'] || '',
      otherSentPackages: others, pdfName: b.pdfName, pdfPages: pdf.pages, pdfParts: pdf.parts,
      pdfMB: Math.round(pdf.bytes.length / 104857.6) / 10,
      dealFolder: deal ? deal.folder.name : '(not found; the PDF will not be saved to Drive)',
      warnings, preview: !!b.preview,
    };
    if (b.preview) {
      await save({ ok: !built.warnings.length, ...summary, html });
      console.log(`[buyer-revision] ${runId} preview saved`);
      return { statusCode: 200 };
    }
    if (built.warnings.length) throw new Error(`not drafted, nothing changed: ${built.warnings.join('; ')}`);
    if (pdf.bytes.length * 1.37 > GMAIL_MAX_RAW) throw new Error(`the PDF is ${summary.pdfMB}MB, over Gmail's 25MB once encoded; nothing changed`);

    // Next to the package; an existing file of that name is left alone.
    let savedToDrive = false;
    if (deal && !deal.files.some((x) => x.name === b.pdfName)) {
      await drive.uploadMultipart({ name: b.pdfName, parents: [deal.folder.id], bytes: pdf.bytes });
      savedToDrive = true;
    }

    const raw = buildMime({
      headers: {
        To: h.to, Cc: h.cc, Subject: subject,
        'In-Reply-To': h['message-id'], References: [h.references, h['message-id']].filter(Boolean).join(' '),
      },
      html,
      attachments: [{ filename: b.pdfName, contentType: 'application/pdf', data: pdf.bytes }],
    });
    const created = await gmail.createDraftRaw(raw, { threadId: msg.threadId });
    const newMsgId = created && created.message && created.message.id;
    const labelNames = Array.isArray(b.labels) && b.labels.length ? b.labels : ['Buyer Disclosures', 'Edelyn'];
    const found = await Promise.all(labelNames.map((n) => gmail.labelId(n)));
    const ids = found.filter(Boolean);
    if (newMsgId && ids.length) await gmail.modifyMessage(newMsgId, { add: ids });
    await save({ ok: true, ...summary, draftId: created.id, savedToDrive, rawBytes: raw.length, labelled: labelNames.filter((_, i) => found[i]) });
    console.log(`[buyer-revision] ${runId} draft ${created.id} created in thread ${msg.threadId}`);
  } catch (err) {
    console.error(`[buyer-revision] ${runId} failed: ${err.message}`);
    await save({ ok: false, error: err.message }).catch(() => {});
  }
  return { statusCode: 200 };
};
