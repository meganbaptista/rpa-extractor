// netlify/functions/buyer-email-draft-background.js
//
// FILLS IN THE BUYER EMAIL DRAFT FOR ONE DEAL. Megan, 2026-10-22: "no you do
// the email for me." Her Zap pre-drafts "Seller Disclosure Package | <address>"
// (label "Buyer Disclosures") with the recipients, greeting, booklet links and
// signature. This:
//   1. finds that draft (subject + address, label Buyer Disclosures),
//   2. fills its page-range placeholders and optional lines (lib/buyer-email.js),
//   3. attaches the package PDF, read from the deal folder in Drive,
//   4. adds the label(s) she asked for ("Edelyn"),
// and records what it did at out/buyer-email/<runId> in the jobs store.
// It never sends: Gmail drafts only, and the recipients the Zap set are kept.
//
// POST JSON (a background function: answers 202 at once):
//   { key, runId, address, pdfName, extraPdfs?: [names],
//     guide?: [{from,to,label}]  (preferred: the plain-English page guide), or
//     seller: {from,to}, avid: {from,to}|{pending:true}  (the Zap's blanks),
//     reportsLink?, stillToCome?: [], labels?: ['Edelyn'], preview?: true }
// `key` must equal meta/admin-key in the jobs store (set from a dev machine;
// the site is at Netlify's env-variable limit, so not an env var).
// preview: finds everything and saves the filled HTML, changes NOTHING.

const J = require('./lib/intake-job');
const rt = require('./lib/intake-runtime');
const gmail = require('./lib/gmail');
const drive = require('./lib/drive');
const { parseRequestBody } = require('./lib/parse-body');
const { fillBuyerEmail, attachmentLabel } = require('./lib/buyer-email');
const { buildMime } = require('./lib/mime');
const { pdfPageCount } = require('./disclosure-intake-check-background').core;

const streetOf = (address) => String(address || '').split(',')[0].trim();
// Gmail's limit is 25MB for the whole message AFTER base64 (about x1.37).
const GMAIL_MAX_RAW = 25 * 1024 * 1024;

async function findPackagePdf(address, pdfName) {
  const street = streetOf(address);
  const folders = (await drive.findFoldersNameContains(street))
    .filter((f) => String(f.name || '').toLowerCase().startsWith(street.toLowerCase()));
  if (!folders.length) throw new Error(`no Drive folder named like "${street}"`);
  for (const f of folders) {
    const files = await drive.listChildren(f.id, { excludeFolders: true });
    const hit = files.find((x) => x.name === pdfName);
    if (hit) return { file: hit, folder: f };
  }
  throw new Error(`"${pdfName}" not found in ${folders.map((f) => f.name).join(' / ')}`);
}

async function findDraft(address) {
  const street = streetOf(address);
  const drafts = await gmail.listDrafts(`subject:"Seller Disclosure Package" "${street}"`);
  if (!drafts.length) throw new Error(`no "Seller Disclosure Package" draft mentions "${street}"`);
  // Newest first; the Zap makes one per deal.
  const d = drafts[0];
  const msg = await gmail.getMessage(d.message.id);
  return { draftId: d.id, msg, others: drafts.length - 1 };
}

exports.handler = async function (event) {
  rt.connect(event);
  const store = rt.jobStore();
  const parsed = parseRequestBody(event);
  const b = (parsed.ok && parsed.body) || {};
  const runId = String(b.runId || `run-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '');
  const save = (result) => J.putOut(store, 'buyer-email', runId, { at: new Date().toISOString(), ...result });

  try {
    const meta = await store.get('meta/admin-key', { type: 'json', consistency: 'strong' });
    if (!meta || !meta.key || b.key !== meta.key) { console.warn('[buyer-email] refused: bad key'); return { statusCode: 403 }; }

    const { draftId, msg, others } = await findDraft(b.address);
    const h = msg.headers || {};
    const { file, folder } = await findPackagePdf(b.address, b.pdfName);
    // The guide is checked against the FINAL PDF in the deal folder (Megan
    // edits it after it is built), so a stale range is refused, not sent.
    const pdf = await drive.download(file.id);
    const totalPages = await pdfPageCount(pdf);
    // The separate PDFs, named in the email (looked up before filling so the
    // list names exactly what is attached).
    const extras = [];
    for (const name of (Array.isArray(b.extraPdfs) ? b.extraPdfs : [])) extras.push((await findPackagePdf(b.address, name)).file);
    const filled = fillBuyerEmail(msg.bodyHtml, {
      guide: b.guide, totalPages, greeting: b.greeting || '',
      attached: extras.map((f) => attachmentLabel(f.name, b.address)),
      seller: b.seller, avid: b.avid, stillToCome: b.stillToCome || [], reportsLink: b.reportsLink || '',
    });
    // Megan, 2026-10-22: the full NHD report, the Prelim and the vendor wildfire
    // report never go INSIDE the package ("pushing a 100 page PDF to a client is
    // asinine"); they ride along as their own PDFs.
    const totalBytes = [file, ...extras].reduce((t, f) => t + Number(f.size || 0), 0);
    const summary = {
      draftId, subject: h.subject, to: h.to, cc: h.cc || '', otherMatchingDrafts: others,
      pdf: `${folder.name} / ${file.name}`, pdfBytes: Number(file.size || 0), pdfPages: totalPages,
      extraPdfs: extras.map((f) => `${f.name} (${Math.round(Number(f.size || 0) / 104857.6) / 10}MB)`),
      estimatedMessageMB: Math.round((totalBytes * 1.37) / 104857.6) / 10,
      filled: filled.filled, warnings: filled.warnings, preview: !!b.preview,
    };
    if (b.preview) {
      await save({ ok: true, ...summary, html: filled.html });
      console.log(`[buyer-email] ${runId} preview saved`);
      return { statusCode: 200 };
    }
    if (filled.warnings.length) throw new Error(`not filled, nothing changed: ${filled.warnings.join('; ')}`);
    if (totalBytes * 1.37 > GMAIL_MAX_RAW) {
      throw new Error(`attachments total ${Math.round(totalBytes / 1048576)}MB, over Gmail's 25MB once encoded; nothing changed`);
    }

    const attachments = [];
    attachments.push({ filename: file.name, contentType: 'application/pdf', data: pdf });
    for (const f of extras) attachments.push({ filename: f.name, contentType: 'application/pdf', data: await drive.download(f.id) });
    const raw = buildMime({
      headers: { To: h.to, Cc: h.cc, Bcc: h.bcc, Subject: h.subject },
      html: filled.html,
      attachments,
    });
    const updated = await gmail.updateDraftRaw(draftId, raw);
    const newMsgId = updated && updated.message && updated.message.id;
    const labelNames = Array.isArray(b.labels) && b.labels.length ? b.labels : ['Buyer Disclosures', 'Edelyn'];
    const ids = (await Promise.all(labelNames.map((n) => gmail.labelId(n)))).filter(Boolean);
    if (newMsgId && ids.length) await gmail.modifyMessage(newMsgId, { add: ids });
    // READ IT BACK. 2026-10-23 Scenic: an update made 11s after a deploy ran
    // on the old code, and a fresh preview (built, not read) looked right.
    // What the draft really holds is saved, so "updated" is checked, not assumed.
    let readBack = '';
    try { if (newMsgId) readBack = String((await gmail.getMessage(newMsgId)).bodyText || '').slice(0, 4000); } catch (e) { readBack = `(could not read back: ${e.message})`; }
    await save({ ok: true, ...summary, rawBytes: raw.length, labelled: labelNames.filter((_, i) => ids[i]), readBack });
    console.log(`[buyer-email] ${runId} draft ${draftId} filled and attached (${Math.round(raw.length / 1048576)}MB)`);
  } catch (err) {
    console.error(`[buyer-email] ${runId} failed: ${err.message}`);
    await save({ ok: false, error: err.message }).catch(() => {});
  }
  return { statusCode: 200 };
};
