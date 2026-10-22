// netlify/functions/lib/revision-check.js
//
// THE REVISION CHECK (phase 3). When the listing side replies to Megan's
// corrections email with revised forms, the question is NOT "audit this
// package again": it is "did they fix what I asked for?". Asked as a fresh
// audit (8 Star Catcher, 2026-10-22) the job re-raised items she had chosen
// not to send and called the solar form missing while it was in that email.
//
// So:
//   1. the checklist is the corrections email she SENT in that thread, never
//      the audit's draft (Megan: "I will often change or revise it"),
//   2. each item is checked against the revised files by TWO independent reads;
//      an item counts as fixed only when both reads put the fix on the same
//      page (the run-to-run variance problem, kept out of what she relies on),
//   3. the revised files are put in package order and every change gets its
//      page number in the MERGED PDF, computed here, not by the model.
//
// Pure helpers are exported for checks/revision-check.js; checkRevisions takes
// the model call as a dependency so the checks can run it on canned answers.

const { RX_FORM_CODE } = require('./buyer-email');

const stripTags = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ').trim();

/**
 * The bullet items of a corrections email: <li> items from the HTML, else
 * lines starting with -, * or a bullet in the plain text. Only the NEWEST
 * message counts (Gmail quotes the thread below it), and a "CHECK BEFORE
 * SENDING" block left in by mistake is never a request.
 */
function correctionItems(msg) {
  let html = String((msg && msg.bodyHtml) || '');
  // Gmail puts the quoted thread in <div class="gmail_quote">; cut there.
  const q = html.search(/<div[^>]+class="[^"]*gmail_quote/i);
  if (q >= 0) html = html.slice(0, q);
  html = html.replace(/CHECK BEFORE SENDING[\s\S]*?delete through here[^<]*/i, '');
  let items = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1]));
  if (!items.length) {
    const text = String((msg && (msg.newestText || msg.bodyText)) || '')
      .replace(/CHECK BEFORE SENDING[\s\S]*?delete through here.*/i, '');
    items = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[-*•]\s+\S/.test(l)).map((l) => l.replace(/^[-*•]\s+/, ''));
  }
  return items.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 3);
}

// A CORRECTIONS email, not a first request for the forms: a delivery that
// answers "please send the disclosures" must still get the full audit. Her
// corrections emails (the intake's chase template, which she edits) say one
// of these; the subject usually says "Corrections".
const RX_CORRECTIONS_SUBJECT = /\bcorrect|\brevis/i;
const RX_CORRECTIONS_BODY = /need a quick update|still pending on my end|to be revised|be corrected|please correct|could the seller|could you fill/i;
function looksLikeCorrections(m) {
  const subject = (m.headers && m.headers.subject) || '';
  const text = String(m.newestText || m.bodyText || '');
  return RX_CORRECTIONS_SUBJECT.test(subject) || RX_CORRECTIONS_BODY.test(text);
}

/**
 * The corrections email this revision answers: the newest message WE sent in
 * the thread before the revision arrived that reads as a corrections email and
 * has at least one bullet item. Returns { msg, items } or null (then the
 * delivery is treated as a new package and gets the full audit).
 */
function findCorrectionsEmail(threadMsgs, revision) {
  const before = (threadMsgs || []).filter((m) => (m.labelIds || []).includes('SENT')
    && Number(m.internalDate) < Number(revision.internalDate) && m.id !== revision.id);
  for (const m of before.sort((a, b) => Number(b.internalDate) - Number(a.internalDate))) {
    if (!looksLikeCorrections(m)) continue;
    const items = correctionItems(m);
    if (items.length) return { msg: m, items };
  }
  return null;
}

/** First name(s) greeting from the package email she sent ("Hello Omeed,"). */
function greetingFrom(msg) {
  const text = String((msg && (msg.newestText || msg.bodyText)) || '');
  const m = text.match(/^\s*((?:Hello|Hi|Dear|Good (?:morning|afternoon))\b[^\n,]{0,80},)/im);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

// Package order (buyer-package-rulebook): the TDS, then the SPQ, then other
// seller forms; advisories last. Ties keep the order they were delivered in.
function formRank(name) {
  const n = String(name || '').toLowerCase();
  if (/transfer disclosure/.test(n)) return 0;
  if (/seller property questionnaire/.test(n)) return 1;
  if (/advisory/.test(n) && !/solar|questionnaire/.test(n)) return 3;
  return 2;
}

/** files: [{ n, pages, forms: [names] }] -> same, in package order. */
function packageOrder(files) {
  return files.map((f, i) => ({ f, i, r: Math.min(...(f.forms && f.forms.length ? f.forms : ['']).map(formRank)) }))
    .sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.f);
}

/** Page `page` of file `n` as a page number in the merged PDF (1-based). */
function mergedPage(ordered, n, page) {
  let offset = 0;
  for (const f of ordered) {
    if (f.n === n) return page >= 1 && page <= f.pages ? offset + page : null;
    offset += f.pages;
  }
  return null;
}

/**
 * Two reads -> one verdict per item.
 *   fixed:   both reads say fixed, on the same file + page
 *   open:    both say open
 *   unclear: anything else (shown to Megan, never decided silently)
 */
function agree(items, readA, readB) {
  const byIdx = (r) => new Map(((r && r.items) || []).map((x) => [Number(x.item), x]));
  const a = byIdx(readA); const b = byIdx(readB);
  return items.map((text, k) => {
    const x = a.get(k + 1) || {}; const y = b.get(k + 1) || {};
    const fixedBoth = x.status === 'fixed' && y.status === 'fixed';
    const samePlace = Number(x.file) === Number(y.file) && Number(x.page) === Number(y.page);
    // A fix on a form a seller has not signed is not done: the buyer side sends
    // it back (1222 N Kings Rd #8: Omer Lavian's line blank on the first APD).
    const unsigned = x.signed_by_all_sellers === false || y.signed_by_all_sellers === false;
    if (fixedBoth && samePlace && unsigned) {
      return { item: text, status: 'unclear', file: Number(x.file), page: Number(x.page), evidence: x.evidence || y.evidence || '', buyerLine: x.buyer_line || y.buyer_line || '', why: 'fixed, but not every seller has signed the form with the fix' };
    }
    if (fixedBoth && samePlace) return { item: text, status: 'fixed', file: Number(x.file), page: Number(x.page), evidence: x.evidence || y.evidence || '', buyerLine: x.buyer_line || y.buyer_line || '' };
    if (x.status === 'open' && y.status === 'open') return { item: text, status: 'open', evidence: x.evidence || y.evidence || '', openPhrase: x.open_phrase || y.open_phrase || '' };
    const fx = x.status === 'fixed' ? x : (y.status === 'fixed' ? y : null);
    return {
      item: text,
      status: 'unclear',
      file: fx ? Number(fx.file) : null,
      page: fx ? Number(fx.page) : null,
      evidence: [x.evidence, y.evidence].filter(Boolean).join(' / '),
      buyerLine: fx ? (fx.buyer_line || '') : '',
      openPhrase: x.open_phrase || y.open_phrase || '',
      why: `the two reads disagreed (${x.status || 'no answer'}${x.page ? ` p${x.page}` : ''} vs ${y.status || 'no answer'}${y.page ? ` p${y.page}` : ''})`,
    };
  });
}

const PROMPT = (items, files) => `You are checking REVISED California real estate disclosure forms that a listing agent sent back after a transaction coordinator asked for specific corrections.

The coordinator asked for these items:
${items.map((t, i) => `${i + 1}. ${t}`).join('\n')}

The attached files, in order:
${files.map((f, i) => `File ${i + 1}: "${f.name}" (${f.pages} page${f.pages === 1 ? '' : 's'})`).join('\n')}

For EACH item, find the page of the attached files where it is addressed and judge it:
- "fixed": the requested answer, explanation, box, signature or form is now present on that page and answers what was asked.
- "open": it has not been addressed (still blank, unchanged, or the form is not attached).
Read handwriting and checkmarks carefully at full resolution. A question whose answer stays the same but now has the explanation that was asked for IS fixed.

Return ONLY JSON:
{
  "property_address": "<the property address printed on the forms, with city, state and ZIP>",
  "items": [{
    "item": <item number>,
    "status": "fixed" | "open",
    "file": <file number, or null>,
    "page": <page number within that file, or null>,
    "evidence": "<what the page now says there, quoted as literally as you can>",
    "signed_by_all_sellers": <true if EVERY seller named on that form has signed (and dated) it, false if any seller line is blank, null if the form has no seller signature lines>,
    "buyer_line": "<if fixed: ONE plain-English sentence for the BUYER saying what the seller changed, starting with 'The seller', e.g. 'The seller filled in where the 220 volt wiring is located (the garage).'>",
    "open_phrase": "<if open: a short plain-English phrase for what is still to come, e.g. 'where the 220 volt wiring is located'>"
  }],
  "files": [{ "file": <n>, "forms": ["<each form in the file by its FULL printed title, in order, e.g. Transfer Disclosure Statement>"] }]
}
In buyer_line and open_phrase NEVER use form codes or abbreviations such as TDS, SPQ, AVID, SOLAR, NHD, FHDS, SFLS or "C.A.R. Form": a buyer does not know them. Say "the solar questionnaire", "the seller's disclosure statement", etc.`;

/**
 * files: [{ n, name, pages, base64 }]  (the revised attachments)
 * callModel(content) -> raw text. Two reads run side by side.
 * Returns { items: [verdicts], ordered: [{ n, name, pages, forms }], address, reads }.
 */
async function checkRevisions({ items, files, callModel }) {
  const content = [];
  files.forEach((f, i) => {
    content.push({ type: 'text', text: `File ${i + 1}: ${f.name}` });
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.base64 } });
  });
  content.push({ type: 'text', text: PROMPT(items, files) });
  const parse = (raw) => {
    const t = String(raw || '').replace(/```json|```/g, '').trim();
    const m = t.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : t);
  };
  const [readA, readB] = await Promise.all([callModel(content).then(parse), callModel(content).then(parse)]);

  // The model numbers files from 1 in the order sent; map back to job doc numbers.
  const formsOf = new Map();
  for (const r of [readA, readB]) {
    for (const f of (r.files || [])) if (!formsOf.has(Number(f.file)) && Array.isArray(f.forms)) formsOf.set(Number(f.file), f.forms);
  }
  const withForms = files.map((f, i) => ({ n: f.n, name: f.name, pages: f.pages, forms: formsOf.get(i + 1) || [] }));
  const ordered = packageOrder(withForms);
  const verdicts = agree(items, readA, readB).map((v) => {
    const doc = v.file ? files[v.file - 1] : null;
    const page = doc ? mergedPage(ordered, doc.n, v.page) : null;
    const out = { ...v, n: doc ? doc.n : null, mergedPage: page };
    // A page the model gave that is not in the file cannot be relied on.
    if (v.status === 'fixed' && !page) return { ...out, status: 'unclear', why: `page ${v.page} of file ${v.file} does not exist` };
    // A buyer line with a form code is useless to the buyer; send it to Megan.
    if (v.status === 'fixed' && (!v.buyerLine || RX_FORM_CODE.test(v.buyerLine))) {
      return { ...out, status: 'unclear', why: `the buyer sentence needs rewording ("${v.buyerLine}")` };
    }
    return out;
  });
  const address = String(readA.property_address || readB.property_address || '').trim();
  return { items: verdicts, ordered, address, reads: [readA, readB] };
}

/**
 * ONLY THE FILES THAT CARRY A FIX go to the buyer (Megan, 2026-10-22): a reply
 * can also hold buyer-side forms (RFR, investigation elections) that are not
 * seller revisions. Returns the attached files in package order, the verdicts
 * with their pages renumbered for that attachment, and what was left out.
 * Nothing fixed at all -> everything is attached (for Megan to look at).
 */
function attachmentPlan(verdicts, ordered) {
  const used = new Set(verdicts.filter((v) => v.n != null && v.mergedPage).map((v) => v.n));
  const attached = used.size ? ordered.filter((f) => used.has(f.n)) : ordered;
  const left = ordered.filter((f) => !attached.includes(f));
  // v.page is the page within its own file; renumber against the attachment.
  const renumbered = verdicts.map((v) => (v.n != null && v.mergedPage ? { ...v, mergedPage: mergedPage(attached, v.n, v.page) } : v));
  return { attached, left, verdicts: renumbered };
}

/**
 * The buyer email inputs from the verdicts. Unclear items with a fixed read go
 * in as change lines (Megan checks them in the note); other unclear items and
 * open items go in "still to come", so nothing she asked for silently drops.
 */
function emailInputs(verdicts, ordered) {
  const changes = []; const stillToCome = [];
  for (const v of verdicts) {
    if ((v.status === 'fixed' || v.status === 'unclear') && v.mergedPage && v.buyerLine && !RX_FORM_CODE.test(v.buyerLine)) {
      changes.push({ page: v.mergedPage, label: v.buyerLine });
    } else {
      stillToCome.push(v.openPhrase && !RX_FORM_CODE.test(v.openPhrase) ? v.openPhrase : 'a few items to be revised by the seller');
    }
  }
  const forms = [];
  for (const f of ordered) for (const name of f.forms) if (!forms.includes(name)) forms.push(name);
  return { changes, stillToCome: [...new Set(stillToCome)], forms, requested: verdicts.length };
}

const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The red "CHECK BEFORE SENDING" note at the top of the draft. */
function checkNoteHtml({ verdicts, correctionsDate, greetingNote, extra = [], banner = '' }) {
  const line = (v) => {
    const where = v.mergedPage ? ` (page ${v.mergedPage} of the attachment)` : '';
    if (v.status === 'fixed') return `<li>FIXED${where}: ${escHtml(v.item)}<br><i>Now reads: ${escHtml(v.evidence)}</i></li>`;
    if (v.status === 'open') return `<li><b>STILL OPEN:</b> ${escHtml(v.item)}<br><i>${escHtml(v.evidence)}</i></li>`;
    return `<li><b>CHECK THIS ONE${where}:</b> ${escHtml(v.item)}<br><i>${escHtml(v.why || '')}. ${escHtml(v.evidence)}</i></li>`;
  };
  return '<div style="color:#c62828">'
    + '<p style="margin:0 0 6px 0"><strong>CHECK BEFORE SENDING (delete from here to the line below)</strong></p>'
    + (banner ? `<p style="margin:0 0 6px 0;font-size:16px"><strong>${escHtml(banner)}</strong></p>` : '')
    + `<p style="margin:0 0 6px 0">Your corrections email${correctionsDate ? ` (${escHtml(correctionsDate)})` : ''} asked for ${verdicts.length} item(s):</p>`
    + `<ul style="margin:0 0 6px 0;padding-left:22px">${verdicts.map(line).join('')}</ul>`
    + [greetingNote, ...extra].filter(Boolean).map((t) => `<p style="margin:0 0 6px 0">${escHtml(t)}</p>`).join('')
    + '<p style="margin:0 0 16px 0">---------- delete through here ----------</p></div>';
}

module.exports = {
  correctionItems, findCorrectionsEmail, looksLikeCorrections, attachmentPlan, greetingFrom, formRank, packageOrder, mergedPage,
  agree, checkRevisions, emailInputs, checkNoteHtml, PROMPT,
};
