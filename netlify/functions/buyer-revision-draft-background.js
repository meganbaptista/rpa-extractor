// netlify/functions/buyer-revision-draft-background.js
//
// DRAFTS THE BUYER REVISION EMAIL FOR ONE DEAL, BY HAND. When the listing side
// sends the revisions Megan asked for, the buyer gets the revised pages as a
// REPLY in the "Seller Disclosure Package | <address>" thread she sent (Megan,
// 2026-10-22: "reply in thread, not a new email"). The intake job does the same
// automatically (lib/intake-steps.js revcheck/revdraft); this is the manual
// trigger for a case the job did not catch. Both use lib/buyer-revision.js.
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

const J = require('./lib/intake-job');
const rt = require('./lib/intake-runtime');
const gmail = require('./lib/gmail');
const drive = require('./lib/drive');
const signature = require('./lib/signature');
const { parseRequestBody } = require('./lib/parse-body');
const { buildRevisionEmail } = require('./lib/buyer-email');
const R = require('./lib/buyer-revision');
const { core } = require('./disclosure-intake-check-background');

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

    const pkg = await R.findSentPackage(gmail, b.address);
    if (!pkg) throw new Error(`no sent "Seller Disclosure Package" email mentions "${R.streetOf(b.address)}"`);
    const h = pkg.msg.headers || {};
    const pdf = await R.mergePdfs(await Promise.all(b.docs.map((n) => J.getDoc(store, b.jobId, n))),
      { render: core.renderPagesAsImages, pageCount: core.pdfPageCount });
    const built = buildRevisionEmail({
      greeting: b.greeting, changes: b.changes, forms: b.forms, totalPages: pdf.pages,
      stillToCome: b.stillToCome || [], requested: b.requested,
    });
    const html = built.html ? signature.withSignature(built.html, await signature.liveSignature(gmail)) : '';
    const deal = await R.findDealFolder(drive, b.address);
    const summary = {
      to: h.to, cc: h.cc || '', subject: h.subject, threadId: pkg.msg.threadId, repliesTo: h['message-id'] || '',
      otherSentPackages: pkg.others, pdfName: b.pdfName, pdfPages: pdf.pages, pdfParts: pdf.parts,
      pdfMB: Math.round(pdf.bytes.length / 104857.6) / 10, rebuiltAsImages: pdf.rebuilt,
      dealFolder: deal.folder ? deal.folder.name : '(not found; the PDF will not be saved to Drive)',
      foldersChecked: deal.seen,
      warnings: built.warnings, preview: !!b.preview,
    };
    if (b.preview) {
      await save({ ok: !built.warnings.length, ...summary, html });
      console.log(`[buyer-revision] ${runId} preview saved`);
      return { statusCode: 200 };
    }
    if (built.warnings.length) throw new Error(`not drafted, nothing changed: ${built.warnings.join('; ')}`);

    const savedToDrive = await R.saveToDealFolder(drive, deal, b.pdfName, pdf.bytes);
    const labels = Array.isArray(b.labels) && b.labels.length ? b.labels : ['Buyer Disclosures', 'Edelyn'];
    const d = await R.createRevisionDraft(gmail, { pkg, html, pdfName: b.pdfName, pdfBytes: pdf.bytes, labels, inThread: true });
    await save({ ok: true, ...summary, draftId: d.draftId, savedToDrive, rawBytes: d.rawBytes, labelled: d.labelled });
    console.log(`[buyer-revision] ${runId} draft ${d.draftId} created in thread ${pkg.msg.threadId}`);
  } catch (err) {
    console.error(`[buyer-revision] ${runId} failed: ${err.message}`);
    await save({ ok: false, error: err.message }).catch(() => {});
  }
  return { statusCode: 200 };
};
