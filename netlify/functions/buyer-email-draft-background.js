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
//   { key, runId, address, pdfName, seller: {from,to}, avid: {from,to},
//     reportsLink?, stillToCome?: [], labels?: ['Edelyn'], preview?: true }
// `key` must equal meta/admin-key in the jobs store (set from a dev machine;
// the site is at Netlify's env-variable limit, so not an env var).
// preview: finds everything and saves the filled HTML, changes NOTHING.

const J = require('./lib/intake-job');
const rt = require('./lib/intake-runtime');
const gmail = require('./lib/gmail');
const drive = require('./lib/drive');
const { parseRequestBody } = require('./lib/parse-body');
const { fillBuyerEmail } = require('./lib/buyer-email');
const { buildMime } = require('./lib/mime');

const streetOf = (address) => String(address || '').split(',')[0].trim();

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
    const filled = fillBuyerEmail(msg.bodyHtml, {
      seller: b.seller, avid: b.avid, stillToCome: b.stillToCome || [], reportsLink: b.reportsLink || '',
    });
    const { file, folder } = await findPackagePdf(b.address, b.pdfName);
    const summary = {
      draftId, subject: h.subject, to: h.to, cc: h.cc || '', otherMatchingDrafts: others,
      pdf: `${folder.name} / ${file.name}`, pdfBytes: Number(file.size || 0),
      filled: filled.filled, warnings: filled.warnings, preview: !!b.preview,
    };
    if (b.preview) {
      await save({ ok: true, ...summary, html: filled.html });
      console.log(`[buyer-email] ${runId} preview saved`);
      return { statusCode: 200 };
    }
    if (filled.warnings.length) throw new Error(`not filled, nothing changed: ${filled.warnings.join('; ')}`);

    const pdf = await drive.download(file.id);
    const raw = buildMime({
      headers: { To: h.to, Cc: h.cc, Bcc: h.bcc, Subject: h.subject },
      html: filled.html,
      attachments: [{ filename: file.name, contentType: 'application/pdf', data: pdf }],
    });
    const updated = await gmail.updateDraftRaw(draftId, raw);
    const newMsgId = updated && updated.message && updated.message.id;
    const labelNames = Array.isArray(b.labels) && b.labels.length ? b.labels : ['Buyer Disclosures', 'Edelyn'];
    const ids = (await Promise.all(labelNames.map((n) => gmail.labelId(n)))).filter(Boolean);
    if (newMsgId && ids.length) await gmail.modifyMessage(newMsgId, { add: ids });
    await save({ ok: true, ...summary, rawBytes: raw.length, labelled: labelNames.filter((_, i) => ids[i]) });
    console.log(`[buyer-email] ${runId} draft ${draftId} filled and attached (${Math.round(raw.length / 1048576)}MB)`);
  } catch (err) {
    console.error(`[buyer-email] ${runId} failed: ${err.message}`);
    await save({ ok: false, error: err.message }).catch(() => {});
  }
  return { statusCode: 200 };
};
