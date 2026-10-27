// netlify/functions/lib/package-live.js
//
// THE AUTOMATIC BUYER EMAIL (Megan, 2026-10-27: "yes we should have that built
// asap"). The package step's LIVE mode: after a first delivery is audited and
// the package is built (lib/package-job.js), this
//   1. saves the package, its separate reports and any FX files at the TOP of
//      the deal folder (never over an existing "Disclosures - ..." file: if
//      one is there, Megan or Claude already built it, and nothing is touched),
//   2. fills her Zap's "Seller Disclosure Package | <address>" draft in the
//      calm layout: page guide, separate reports, still to come, attachments,
//   3. puts a red CHECK BEFORE SENDING box at the top of the draft with every
//      warning and everything left out of the package (she deletes it).
// It never sends. A build with a PROBLEM (a page still blank, too big for
// Gmail) is not filled: she gets an alert and the trial-style report instead.
//
// "Still to come" is written from the audit's still-needed lines in the words
// a buyer reads (never form codes); a line it has no words for is listed in
// the red box instead of guessed.

const { fillBuyerEmail, attachmentLabel, RX_FORM_CODE } = require('./buyer-email');
const { buildMime } = require('./mime');

const GMAIL_MAX_RAW = 25 * 1024 * 1024;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The calm layout's page guide from the plan's groups and the built page ranges. */
function guideFromPlan(plan, ranges) {
  const out = [];
  for (const g of plan.guide || []) {
    const idx = plan.units.map((u, i) => (g.sections.includes(u.section) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    out.push({ from: Math.min(...idx.map((i) => ranges[i][0])), to: Math.max(...idx.map((i) => ranges[i][1])), label: g.label });
  }
  return out.sort((a, b) => a.from - b.from);
}

// The audit's still-needed lines (her compliance list wording) in buyer words.
// null = not the seller's to send / not something the buyer waits for.
const STILL_WORDS = [
  [/^(ba|buyer'?s?)\s*avid|our\s+avid/i, null],
  [/^vp\b|final\s+walk/i, null],
  [/inspections?\s+or\s+biw|termite\s+inspection|\bbiw\b|\bbie\b/i, null],
  [/contingency\s+release|\bcr\b/i, null],
  [/receipt\s+for\s+reports|\brfr\b/i, null],
  [/prelim|property\s+profile|mls\s+client|\bdia\b/i, null],
  [/^(la|listing\s+agent'?s?)\s*avid|\bavid\b/i, "the listing agent's visual inspection"],
  [/^tds\b|transfer\s+disclosure/i, "the seller's transfer disclosure statement"],
  [/^spq\b|seller\s+property\s+questionnaire/i, "the seller's property questionnaire"],
  [/^esd\b|exempt\s+seller/i, "the seller's exempt disclosure"],
  [/^sfls\b|square\s+footage/i, 'the square footage disclosure'],
  [/^fhds\b|fire\s+hardening/i, 'the fire safety disclosure'],
  [/\bnhd\b|natural\s+hazard/i, 'the natural hazard disclosure statement'],
  [/^rcsd/i, 'the form confirming who signs for the seller'],
  [/^wcmd\b|water.?conserving|carbon\s+monoxide/i, 'the plumbing fixtures and carbon monoxide detector notice'],
  [/^whsd\b|water\s+heater/i, 'the water heater and smoke alarm statement'],
  [/^lpd\b|lead.?based/i, 'the lead paint disclosure'],
  [/^ta\b|trust\s+advisory/i, 'the trust advisory'],
  [/^mca\b|market\s+conditions/i, 'the market conditions advisory'],
  [/^sbsa\b|statewide/i, 'the statewide buyer and seller advisory'],
  [/^bhaa\b|homeowners.?\s*association\s+advisory/i, 'the homeowners association advisory'],
  [/^wfda\b|wildfire\s+disaster/i, 'the wildfire disaster advisory'],
  [/earthquake\s+(booklet|guide)|booklet\s+receipt/i, 'the earthquake booklet receipt'],
  [/earthquake\s+hazards?\s+report|residential\s+earthquake/i, 'the earthquake risk disclosure'],
  [/solar/i, 'the solar questionnaire'],
  [/^psd\b|pool\s+safety/i, 'the pool safety disclosure'],
  [/hoa\s+(docs|documents)|association\s+documents/i, 'the homeowners association documents'],
];
function localAreaWords(line) {
  const m = String(line).match(/^(.*?)\s*local\s+area\s+disclosures?/i);
  if (!m) return '';
  const region = m[1].replace(/\b(county|city of)\b/ig, (x) => x).trim();
  return `the ${region ? `${region} ` : ''}local area disclosures`.replace(/\s+/g, ' ');
}

/**
 * payload: the audit's (still_needed_lines, response_flags_count).
 * included: lower-case codes the package already holds from our template
 * (SBSA/BHAA/...), which are therefore not "to come".
 * Returns { items: [buyer words], unsure: [raw lines] }.
 */
function stillToComeFrom(payload, included = []) {
  const lines = String((payload && payload.still_needed_lines) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const items = []; const unsure = [];
  for (const line of lines) {
    const code = (line.match(/^([A-Z]{2,6})\b/) || [])[1];
    if (code && included.includes(code.toLowerCase())) continue;
    const local = localAreaWords(line);
    if (local) { if (!items.includes(local)) items.push(local); continue; }
    const hit = STILL_WORDS.find(([rx]) => rx.test(line));
    if (!hit) { unsure.push(line); continue; }
    if (hit[1] && !items.includes(hit[1])) items.push(hit[1]);
  }
  if (Number((payload && payload.response_flags_count) || 0) > 0) items.push("updates to a few of the seller's answers");
  return { items: items.filter((s) => !RX_FORM_CODE.test(s)), unsure };
}

/** The red box at the top of the draft. */
function checkBoxHtml({ warnings = [], leftOut = [], unsure = [], notes = [], source = '' }) {
  const li = (xs) => xs.map((x) => `<li>${esc(x)}</li>`).join('');
  return '<div style="color:#b91c1c;font-family:Arial,sans-serif;font-size:13px">'
    + '<p style="margin:0 0 6px 0"><b>CHECK BEFORE SENDING (delete from here to the line below)</b></p>'
    + `<p style="margin:0 0 6px 0">Built automatically from ${esc(source)}. The package and reports are saved at the top of the deal folder.</p>`
    + (warnings.length ? `<p style="margin:0">Check:</p><ul style="margin:0 0 6px 0">${li(warnings)}</ul>` : '')
    + (unsure.length ? `<p style="margin:0">Still needed on the list, not put in "still to come" (add in your words if the buyer should know):</p><ul style="margin:0 0 6px 0">${li(unsure)}</ul>` : '')
    + (leftOut.length ? `<p style="margin:0">Left out of the package:</p><ul style="margin:0 0 6px 0">${li(leftOut.map((l) => `${l.what}: ${l.why}`))}</ul>` : '')
    + (notes.length ? `<ul style="margin:0 0 6px 0">${li(notes)}</ul>` : '')
    + '<p style="margin:0 0 16px 0">---------- delete through here ----------</p></div>';
}

/** Her Zap's draft for the deal (newest), or null. */
async function findZapDraft(gmail, street) {
  const drafts = await gmail.listDrafts(`subject:"Seller Disclosure Package" "${street}"`);
  if (!drafts.length) return null;
  const msg = await gmail.getMessage(drafts[0].message.id);
  return { draftId: drafts[0].id, msg, others: drafts.length - 1 };
}

/**
 * Fill the draft. built: assemble()'s output; plan: planPackage's; still:
 * stillToComeFrom(); extraNotes: drop-in notes. Returns a summary; throws
 * 'no-draft' when the Zap's draft is not there yet (the step retries).
 */
async function fillDraft({ gmail, street, address, built, plan, still, warnings, notes, source, labels = ['Buyer Disclosures', 'Edelyn'] }) {
  const d = await findZapDraft(gmail, street);
  if (!d) { const e = new Error(`no "Seller Disclosure Package" draft for "${street}" yet`); e.code = 'no-draft'; throw e; }
  const guide = guideFromPlan(plan, built.pkg.ranges);
  const filled = fillBuyerEmail(d.msg.bodyHtml, {
    guide, totalPages: built.pkg.pages, greeting: '',
    attached: built.attachments.map((a) => attachmentLabel(a.name, address)),
    stillToCome: still.items, reportsLink: '',
  });
  if (filled.warnings.length) throw new Error(`the draft could not be filled: ${filled.warnings.join('; ')}`);

  // Attach the package, then the separate reports while they fit.
  const atts = [{ filename: built.name, contentType: 'application/pdf', data: built.pkg.bytes }];
  let total = built.pkg.bytes.length;
  const notAttached = [];
  for (const a of built.attachments) {
    if ((total + a.bytes.length) * 1.37 > GMAIL_MAX_RAW) { notAttached.push(a.name); continue; }
    atts.push({ filename: a.name, contentType: 'application/pdf', data: a.bytes });
    total += a.bytes.length;
  }
  const box = checkBoxHtml({
    warnings: warnings.concat(notAttached.length ? [`not attached (too big for one email; it is in the deal folder): ${notAttached.join(', ')}`] : []),
    leftOut: plan.leftOut, unsure: still.unsure, notes, source,
  });
  // The box goes right after the opening <div> of the body, above the greeting.
  const html = /^\s*<div[^>]*>/i.test(filled.html) ? filled.html.replace(/^(\s*<div[^>]*>)/i, `$1${box}`) : box + filled.html;
  const h = d.msg.headers || {};
  const raw = buildMime({ headers: { To: h.to, Cc: h.cc, Bcc: h.bcc, Subject: h.subject }, html, attachments: atts });
  const updated = await gmail.updateDraftRaw(d.draftId, raw);
  const newMsgId = updated && updated.message && updated.message.id;
  const ids = (await Promise.all(labels.map((n) => gmail.labelId(n)))).filter(Boolean);
  if (newMsgId && ids.length) await gmail.modifyMessage(newMsgId, { add: ids });
  let readBack = '';
  try { if (newMsgId) readBack = String((await gmail.getMessage(newMsgId)).bodyText || '').slice(0, 3000); } catch (e) { readBack = `(could not read back: ${e.message})`; }
  return { draftId: d.draftId, to: h.to, cc: h.cc || '', otherDrafts: d.others, rawMB: Math.round(raw.length / 104857.6) / 10, guide, stillToCome: still.items, notAttached, readBack };
}

module.exports = { guideFromPlan, stillToComeFrom, checkBoxHtml, findZapDraft, fillDraft, STILL_WORDS };
