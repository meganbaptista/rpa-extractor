// netlify/functions/lib/package-job.js
//
// STAGE 3 of the automatic buyer package: the intake job's `package` step. It
// runs after `finish` on a FIRST delivery (revisions take the revcheck path) and
// only on deals where we represent the BUYER (the MTC INFORMATION sheet; a dual
// or unknown deal is skipped).
//
//   compliance Doc  -> wanted forms, open contract items, buyer brokerage
//   deal folder     -> profile, MLS, AVID, agency file, seller reports, and
//                      the Audit Disclosures template (mapped by the strip
//                      reader once, cached in Blobs by file id + modified time)
//   job docs/extras -> what the listing side sent (the map step's forms)
//   then: text facts -> planPackage -> assemble
//
// MODES (Blobs meta/package-mode, never an env var: the site is at the 4KB
// limit). 'shadow' is the default:
//   off     nothing
//   shadow  build it, keep the PDFs in Blobs, and put ONE trial draft in
//           Megan's Drafts (no recipient, "[PACKAGE TRIAL]") with the package
//           attached and the plan written out: order, attachments, FX files,
//           what was left out and why, warnings. Nothing is saved to Drive and
//           nothing is moved. She compares it with the package she builds.
//   live    (Megan, 2026-10-27: "yes we should have that built asap") save the
//           package + reports at the top of the deal folder and fill her Zap's
//           buyer draft, with a red CHECK BEFORE SENDING box (lib/package-live.js).
//           Never over an existing "Disclosures - ..." package; a build with a
//           problem is not filled (alert + the trial draft instead).
//
// The step never fails the job: errors retry, and on the last try they become
// an alert and the job is closed as usual.

const J = require('./intake-job');
const P = require('./package-plan');
const A = require('./package-assemble');
const D = require('./package-dropins');
const { parseCompliance } = require('./package-inputs');
const C = require('./compliance-doc');
const R = require('./buyer-revision');
const { buildMime } = require('./mime');
const L = require('./package-live');

const MODE_KEY = 'meta/package-mode';
const GMAIL_RAW_MAX = 24 * 1024 * 1024;

async function packageMode(store) {
  const m = await store.get(MODE_KEY, { type: 'json', consistency: 'strong' }).catch(() => null);
  return (m && m.mode) || 'shadow';
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Strip map of the Audit Disclosures template, cached per version. */
async function templateMap(ctx, file, buf) {
  const key = `tplmap/${file.id}-${String(file.modifiedTime || '').replace(/[^0-9]/g, '')}`;
  const hit = await ctx.store.get(key, { type: 'json', consistency: 'strong' }).catch(() => null);
  if (hit && hit.forms) return hit.forms;
  const pages = await ctx.core.pdfPageCount(buf);
  const rows = await ctx.strips.readAllStrips(buf, pages, file.name);
  // Unread pages (an API error) would map to nothing and, cached, drop our
  // brokerage pages for good: retry the step instead, never cache a guess.
  const unread = rows.filter((r) => r.unread).length;
  if (unread) throw new Error(`template: ${unread} of ${pages} page(s) could not be read`);
  const forms = ctx.strips.documentsFromStrips(rows)
    .map((f) => ({ name: f.title || f.carCode || f.footerName || '', code: f.carCode || '', pages: f.pages }));
  if (!forms.length) throw new Error('template: no forms found on its pages');
  await ctx.store.setJSON(key, { forms, at: Date.now() });
  ctx.log(`mapped the Audit Disclosures template: ${forms.length} form(s) on ${pages} page(s)`);
  return forms;
}

/**
 * Build the package for this job. Returns { plan, built, drop, inputs, deal }
 * or { skip: '<why>' }. All I/O comes from ctx; deps.side lets checks stub
 * the deal-side lookup.
 */
async function buildForJob(ctx, deps = {}) {
  const { store, job, core, drive } = ctx;
  const address = job.address;
  if (!address) return { skip: 'no address' };
  const side = await (deps.side || require('./deal-side').sideForSubject)(address);
  if (side !== 'buyer') return { skip: `not a buyer-side deal (${side || 'side unknown or dual'})` };

  // Compliance Doc.
  let inputs = { brokerage: '', wantedCodes: null, contractItems: [] };
  try {
    // The address as her sheet row may write it: a duplex "4180 - 4182 ..."
    // uses the first number; "Valencia (Santa Clarita)" (26012 Lucerne) may be
    // either city.
    const variants = [address, address.replace(/^(\d+)\s*[-–&]\s*\d+\s+/, '$1 ')];
    const paren = address.match(/,\s*([^,(]+?)\s*\(([^)]+)\)\s*,/);
    if (paren) variants.push(address.replace(paren[0], `, ${paren[1]},`), address.replace(paren[0], `, ${paren[2]},`));
    let url = '';
    for (const v of [...new Set(variants)]) { url = await C.findComplianceDocUrl(v); if (url) break; }
    const doc = url ? await C.fetchDocText(url) : null;
    if (doc && doc.text) inputs = parseCompliance(doc.text);
  } catch (err) { ctx.log(`compliance Doc not read: ${err.message}`); }

  // The listing side's delivery.
  const maps = (await J.getOut(store, job.id, 'map')) || {};
  const files = job.docs.map((d) => ({ n: d.n, name: d.name, pages: d.pages, forms: (maps[d.n] || {}).forms || [] }));
  const extras = (job.extras || []).map((e) => ({ key: e.key, name: e.name }));
  const bytes = new Map();
  const getBytes = async (src) => {
    const k = src.type === 'file' ? `f${src.n}` : src.type === 'extra' ? `x${src.key}` : `d${src.id}`;
    if (!bytes.has(k)) {
      bytes.set(k, src.type === 'file' ? await J.getDoc(store, job.id, src.n)
        : src.type === 'extra' ? await J.getDoc(store, job.id, src.key) : await drive.download(src.id));
    }
    return bytes.get(k);
  };

  // The deal folder (top level only).
  const deal = await R.findDealFolder(drive, address);
  let drop = { dropIns: {}, reports: [], warnings: [], notes: [] };
  const dealTexts = new Map();
  if (deal.folder) {
    const pdfs = deal.files.filter((f) => /\.pdf$/i.test(f.name || ''));
    // The Property Profile sometimes sits in FX PURCHASE AGREEMENT: read it
    // from there when the top has none (read only; nothing there is moved).
    if (!pdfs.some((f) => /^property profile\b/i.test(f.name || ''))) {
      try {
        const sub = (await drive.listChildren(deal.folder.id)).find((f) => /^fx purchase agreement$/i.test(String(f.name || '').trim()) && /folder/.test(f.mimeType || ''));
        if (sub) for (const f of await drive.listChildren(sub.id, { excludeFolders: true })) if (/^(fx\s*-\s*)?property profile\b.*\.pdf$/i.test(f.name || '')) pdfs.push({ ...f, inFx: true });
      } catch (err) { ctx.log(`FX PURCHASE AGREEMENT not read: ${err.message}`); }
    }
    const dealFiles = pdfs.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, pages: 0, inFx: !!f.inFx }));
    const deliveredCodes = files.flatMap((f) => f.forms.map((x) => x.code).filter(Boolean));
    const plain = D.planDropIns({ dealFiles, deliveredCodes, wantedCodes: inputs.wantedCodes, buyerBrokerage: inputs.brokerage });
    // Read only what the drop-ins use: MLS (footer pages) and seller reports (duplicate check).
    const agencyId = (plain.dropIns.ourBrokerage || []).map((b) => b.src && b.src.id).find((id) => id && /^blank\s+(aaa|ac|aba)/i.test((dealFiles.find((x) => x.id === id) || {}).name || ''));
    const needText = [plain.dropIns.mls && plain.dropIns.mls.id, agencyId, ...plain.reports.map((r) => r.src.id)].filter(Boolean);
    for (const id of needText) {
      const t = await core.pdfPageTexts(await getBytes({ type: 'drive', id }));
      dealTexts.set(id, t);
      const f = dealFiles.find((x) => x.id === id); f.texts = t; f.pages = t.length;
    }
    // The agency file's text is often garbled (zipForm export), so its forms are
    // read like the template's, to know if the listing side sent the same one.
    if (agencyId) {
      const f = dealFiles.find((x) => x.id === agencyId);
      try { f.codes = (await templateMap(ctx, f, await getBytes({ type: 'drive', id: agencyId }))).map((x) => String(x.code || '').toUpperCase()).filter(Boolean); } catch (err) { ctx.log(`agency file not read: ${err.message}`); }
    }
    let template = null;
    const tpl = pdfs.filter((f) => /^audit disclosures/i.test(f.name)).sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)))[0];
    if (tpl) {
      const buf = await getBytes({ type: 'drive', id: tpl.id });
      template = { id: tpl.id, name: tpl.name, forms: await templateMap(ctx, tpl, buf), texts: await core.pdfPageTexts(buf) };
    }
    drop = D.planDropIns({ dealFiles, template, deliveredCodes, wantedCodes: inputs.wantedCodes, buyerBrokerage: inputs.brokerage });
  } else {
    drop.warnings.push(`no deal folder found for ${address}: built without our drop-ins`);
  }

  // Text facts.
  const sources = [];
  for (const f of files) sources.push({ n: f.n, name: f.name, texts: await core.pdfPageTexts(await getBytes({ type: 'file', n: f.n })) });
  for (const x of extras) sources.push({ key: x.key, name: x.name, texts: await core.pdfPageTexts(await getBytes({ type: 'extra', key: x.key })) });
  for (const r of drop.reports) { extras.push(r); sources.push({ key: r.key, name: r.name, texts: dealTexts.get(r.src.id) || [] }); }
  const assembleDeps = { getBytes, pageTexts: core.pdfPageTexts, render: core.renderPagesAsImages, pageCount: core.pdfPageCount };
  const flags = {
    duplicates: A.findDuplicates(sources),
    wrongProperty: A.findWrongProperty(sources, address),
    tails: await A.findTails(sources, assembleDeps),
    fx: A.findContractDocs(files, sources, inputs.contractItems),
    firstText: A.firstTexts(sources),
  };

  const plan = P.planPackage({ files, extras, dropIns: drop.dropIns, flags });
  // Named like her deal folder ("4180 Sunnyslope Ave, ..." even when the audit
  // read the duplex as "4180 - 4182 ...").
  const built = await A.assemble(plan, assembleDeps, { address: deal.folder ? deal.folder.name : address });
  return { plan, built, drop, inputs, deal, flags };
}

/** The trial draft's report: what Megan checks against her own build. */
function reportHtml(job, r) {
  const { plan, built, drop, inputs } = r;
  const row = (a, b) => `<tr><td style="padding:2px 10px 2px 0;white-space:nowrap">${a}</td><td style="padding:2px 0">${b}</td></tr>`;
  const list = (xs) => (xs.length ? `<ul style="margin:4px 0 10px 18px;padding:0">${xs.map((x) => `<li>${x}</li>`).join('')}</ul>` : '<p style="margin:4px 0 10px">none</p>');
  const order = plan.units.map((u, i) => row(`pages ${built.pkg.ranges[i][0]}-${built.pkg.ranges[i][1]}`, esc(u.label))).join('');
  return '<div style="font-family:Arial,sans-serif;font-size:13px">'
    + '<div style="border:2px solid #0f766e;padding:10px 12px;margin-bottom:14px">'
    + '<b>BUYER PACKAGE TRIAL (not sent, nothing saved to Drive, nothing moved)</b><br>'
    + `From "${esc(job.source.subject)}" (${esc(job.source.from)}).<br>`
    + `The package is attached: ${built.pkg.pages} pages, ${(built.pkg.bytes.length / 1048576).toFixed(1)}MB. `
    + `Compliance list read: ${inputs.wantedCodes ? 'yes' : 'NO (built without it)'}; buyer brokerage: ${esc(inputs.brokerage || 'unknown')}.</div>`
    + (built.problems.length ? `<p style="color:#b91c1c"><b>PROBLEMS (do not use this package):</b></p>${list(built.problems.map(esc))}` : '')
    + `<p><b>Order</b></p><table style="border-collapse:collapse;font-size:13px">${order}</table>`
    + `<p><b>Attached separately</b></p>${list(built.attachments.map((a) => `${esc(a.name)} (${a.pages} pages)`))}`
    + `<p><b>Filed as FX (not in the package)</b></p>${list((built.fx || []).map((a) => `${esc(a.name)} (${a.pages} pages)`))}`
    + `<p><b>Left out of the package</b></p>${list(plan.leftOut.map((l) => `${esc(l.what)}: ${esc(l.why)}`))}`
    + `<p><b>Check before using</b></p>${list(drop.warnings.concat(plan.warnings, built.warnings).map(esc))}`
    + (drop.notes.length ? `<p><b>Notes</b></p>${list(drop.notes.map(esc))}` : '')
    + '</div>';
}

async function trialDraft(ctx, r) {
  const { job, gmail } = ctx;
  const att = [{ filename: r.built.name, contentType: 'application/pdf', data: r.built.pkg.bytes }];
  let total = r.built.pkg.bytes.length;
  const extra = [];
  for (const a of r.built.attachments.concat(r.built.fx || [])) {
    if ((total + a.bytes.length) * 1.37 > GMAIL_RAW_MAX) { extra.push(a.name); continue; }
    att.push({ filename: a.name, contentType: 'application/pdf', data: a.bytes });
    total += a.bytes.length;
  }
  const note = extra.length ? `<p style="font-family:Arial,sans-serif;font-size:13px">Not attached here (too big for one draft): ${extra.map(esc).join(', ')}.</p>` : '';
  const raw = buildMime({ headers: { To: '', Subject: `[PACKAGE TRIAL] ${job.address}` }, html: reportHtml(job, r) + note, attachments: att });
  const created = await gmail.createDraftRaw(raw, {});
  const messageId = created && created.message && created.message.id;
  const names = String(process.env.INTAKE_TRIAL_LABELS || 'Megan,Edelyn').split(',').map((s) => s.trim()).filter(Boolean);
  if (messageId && names.length) {
    try {
      const ids = (await Promise.all(names.map((n) => gmail.labelId(n)))).filter(Boolean);
      if (ids.length) await gmail.modifyMessage(messageId, { add: ids });
    } catch (err) { ctx.log(`package trial draft labels failed: ${err.message}`); }
  }
  return (created && created.id) || 'created';
}

/**
 * LIVE: save to the deal folder, fill the buyer draft. Returns the outcome, or
 * null when the trial draft should be made instead (Megan looks at it).
 */
async function deliverLive(ctx, r, effects, lastTry) {
  const { store, job, drive, gmail } = ctx;
  const save = () => J.putOut(store, job.id, 'package-effects', effects);
  const address = job.address;
  if (r.built.problems.length) {
    await ctx.alert(`package-problem:${job.id}`, `${address}: the buyer package was NOT filled into the buyer email: ${r.built.problems.join('; ')}. A [PACKAGE TRIAL] draft shows what was built.`);
    return null;
  }
  if (!r.deal || !r.deal.folder) {
    // Which folders it looked at, so a duplicate shows in the alert itself.
    const seen = ((r.deal && r.deal.seen) || []).map((x) => `"${x.folder}"${x.parent ? ` in ${x.parent}` : ''}`);
    const why = seen.length > 1 ? ` It found ${seen.length} folders with that name and could not tell which is the deal: ${seen.join('; ')}.` : seen.length ? '' : ' No folder with that name was found.';
    await ctx.alert(`package-nofolder:${job.id}`, `${address}: no deal folder found, so the buyer package was not saved or filled.${why} A [PACKAGE TRIAL] draft shows what was built.`);
    return null;
  }
  // ALREADY BUILT BY HAND = hands off. Her own file can have any name (3345
  // Rubio: "SELLER DISCLOSURES SS.pdf"), and a package email already sent
  // means the buyer has it.
  const existing = r.deal.files.find((f) => f.name === r.built.name || /^(disclosures\s*-|seller\s+disclosures)/i.test(String(f.name || '')));
  if (existing) return `package: "${existing.name}" already in the deal folder, nothing changed (built by hand)`;
  try {
    const sent = await R.findSentPackage(gmail, address);
    if (sent) return 'package: a "Seller Disclosure Package" email was already sent for this address, nothing changed';
  } catch (err) { ctx.log(`sent-package check failed: ${err.message}`); }
  if (!effects.saved) {
    const res = await A.fileToDealFolder(drive, r.deal, r.built);
    effects.saved = res.saved; await save();
    ctx.log(`package saved to the deal folder: ${res.saved.join(', ')}`);
  }
  const payload = (await J.getOut(store, job.id, 'payload')) || {};
  const included = ((r.drop && r.drop.dropIns && r.drop.dropIns.forms) || []).map((f) => String(f.code || '').toLowerCase());
  const still = L.stillToComeFrom(payload, included);
  try {
    const d = await L.fillDraft({
      gmail, street: R.streetOf(address), address, built: r.built, plan: r.plan, still,
      warnings: r.drop.warnings.concat(r.plan.warnings, r.built.warnings), notes: r.drop.notes,
      source: `"${job.source.subject}" (${job.source.fromName || job.source.from})`,
    });
    effects.liveDraft = d.draftId; await save();
    await J.putOut(store, job.id, 'package-live', d);
    return `package: buyer draft filled (${r.built.pkg.pages} pages, ${r.built.attachments.length} separate report(s))`;
  } catch (err) {
    if (err.code === 'no-draft' && !lastTry) throw err;     // her Zap may not have made it yet: retry
    await ctx.alert(`package-fill:${job.id}`, `${address}: the buyer package is saved in the deal folder (${effects.saved.join(', ')}), but the buyer email was not filled: ${err.message}. Fill it by hand.`);
    return `package: saved, buyer draft NOT filled (${err.message})`;
  }
}

/** The step. */
async function packageStep(ctx) {
  const { store, job } = ctx;
  const lastTry = ctx.attempt >= J.MAX_ATTEMPTS;
  const close = (outcome) => (j) => { j.status = 'done'; j.packageOutcome = outcome; };
  try {
    /*
      A TRIAL RUN NEVER DELIVERS (2026-10-29): a shadow intake job, or one
      marked packageMode 'shadow' to show a package again (2073 Deer Trl),
      makes the trial draft even while packages are live, never touching the
      deal folder or the buyer's draft.
    */
    const global = await packageMode(store);
    const mode = global === 'off' ? 'off' : job.packageMode || (job.mode === 'shadow' ? 'shadow' : global);
    if (mode === 'off') return close('package: off');
    const effects = (await J.getOut(store, job.id, 'package-effects')) || {};
    if (effects.trialDraft) return close('package: trial draft already made');
    if (effects.liveDraft) return close('package: buyer draft already filled');
    const r = await buildForJob(ctx, ctx.packageDeps || {});
    if (r.skip) { ctx.log(`package skipped: ${r.skip}`); return close(`package skipped: ${r.skip}`); }
    if (mode === 'live') {
      const out = await deliverLive(ctx, r, effects, lastTry);
      if (out) return close(out);
      // null = fall through to the trial draft (a problem, no deal folder).
    }
    await J.putDoc(store, job.id, 'pkg', r.built.pkg.bytes);
    await J.putOut(store, job.id, 'package', {
      name: r.built.name, pages: r.built.pkg.pages, ranges: r.built.pkg.ranges,
      units: r.plan.units.map((u) => ({ label: u.label, section: u.section, src: u.src, pages: u.pages || null })),
      attachments: r.built.attachments.map((a) => ({ name: a.name, pages: a.pages })),
      fx: (r.built.fx || []).map((a) => ({ name: a.name, pages: a.pages })),
      leftOut: r.plan.leftOut, warnings: r.drop.warnings.concat(r.plan.warnings, r.built.warnings),
      notes: r.drop.notes, problems: r.built.problems, size: r.built.size, guide: r.plan.guide, flags: r.flags,
    });
    effects.trialDraft = await trialDraft(ctx, r);
    await J.putOut(store, job.id, 'package-effects', effects);
    ctx.log(`package trial: ${r.built.pkg.pages} pages, ${r.built.attachments.length} attachment(s), ${r.built.problems.length} problem(s)`);
    return close(`package trial: ${r.built.pkg.pages} pages${r.built.problems.length ? `, ${r.built.problems.length} PROBLEM(S)` : ''}`);
  } catch (err) {
    if (!lastTry) throw err;
    await ctx.alert(`package-failed:${job.id}`, `${job.address}: the buyer package trial could not be built (${err.message}). Build it by hand as usual.`);
    return close(`package failed: ${err.message}`);
  }
}

module.exports = { packageStep, buildForJob, reportHtml, packageMode, deliverLive, MODE_KEY };
