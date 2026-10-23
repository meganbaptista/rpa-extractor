// netlify/functions/lib/buyer-email.js
//
// FILLS IN MEGAN'S PRE-MADE BUYER EMAIL. A Zap drafts "Seller Disclosure
// Package | <address>" (label "Buyer Disclosures") when the file opens, with
// the right recipients, the buyer's name, the five booklet links and her
// signature. What it cannot know is the page ranges, so it leaves highlighted
// placeholders:
//
//   "Pages 1 - X have been filled out by the seller ..."
//   "Pages X - X is the Agent Visual Inspection ..."
//
// fillBuyerEmail() replaces exactly those, and adds two optional lines Megan
// asked for (2026-10-22): "Still to come from the seller's side: ..." when the
// corrections list is not empty, and "CLICK HERE FOR SELLER REPORTS" ONLY when
// the delivery included a link to additional reports (case by case). Every
// other byte of her draft - greeting, links, signature - is left as the Zap
// wrote it. Pure: no I/O, so checks/buyer-email.js runs it on her template.

// Whatever HTML Gmail wraps around a placeholder (the yellow highlight is a
// <span style="background-color:...">), tolerated between the words.
const T = '(?:\\s|&nbsp;|<[^>]+>)*';
// Also matches a range filled in on an earlier run ("Pages 1 - 17 have been
// filled out by the seller"), so a wrong range can be corrected by re-running.
const RX_SELLER_RANGE = new RegExp(`Pages${T}1${T}-${T}(?:X|\\d+)(?=${T}have\\s+been\\s+filled)`, 'i');
const RX_AVID_RANGE = new RegExp(`Pages${T}X${T}-${T}X`, 'i');
const RX_REMAINDER_LINE = /(<(p|div)\b[^>]*>(?:(?!<\/\2>)[\s\S])*The\s+remainder\s+of\s+the\s+PDF\s+package[\s\S]*?<\/\2>)/i;
// Her real Zap draft (8 Star Catcher, 2026-10-22) has no <p>/<div>: lines are
// separated by "<br></br><br></br>". Insert before the first break after the
// remainder sentence.
const RX_REMAINDER_BR = /(The\s+remainder\s+of\s+the\s+PDF\s+package[\s\S]*?)(\s*<br\s*\/?>)/i;

// C.A.R. form codes a buyer would not understand (Megan, 2026-10-22: "a buyer
// does not speak CAR forms"). Buyer-facing text containing one is refused.
const RX_FORM_CODE = /\b(TDS|SPQ|AVIDs?|NHD|SFLS|WCMD|WHSD|SBSA|MCA|BHAA|WFDA|FHDS|DSDT|LPD|RCSD(?:-[SB])?|AAA|ABA|TOA|RFR|PSD|DIA|ESD|SOLAR|BIE|SXA|FIRPTA|RPA|BRBC|ADM|C\.?A\.?R\.?\s+Form)\b/;

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const range = (r) => (r && r.from ? (r.to && r.to !== r.from ? `Pages ${r.from} - ${r.to}` : `Page ${r.from}`) : '');

/**
 * html:        the draft body as the Zap wrote it
 * seller:      { from, to } pages the seller filled out
 * avid:        { from, to } the AVID pages, or null
 * stillToCome: ['NHD report', 'a few updated answers'] (may be empty)
 * reportsLink: URL of additional reports from the delivery, or ''
 * Returns { html, filled: { seller, avid }, warnings: [] }.
 */
/**
 * PAGE GUIDE MODE (Megan, 2026-10-22: the Oletha email's "Here is how the
 * package is organized:" list is what she wants, in plain English). Replaces
 * the Zap's three placeholder lines ("Pages 1 - X ...", "Pages X - X ...",
 * "The remainder of the PDF package ...") with the guide, then the optional
 * "still to come" and seller-reports lines.
 *   guide:      [{ from, to, label }] in page order, plain English
 *   totalPages: the final PDF's page count; the guide must cover 1..totalPages
 *               with no gap or overlap (a cover page may be left out at the start)
 * Refuses (returns the draft untouched, with warnings) when a label or a
 * still-to-come item contains a form code, or the ranges do not add up.
 */
/**
 * "Seller Report - Restoration Report.pdf" -> "Seller Report - Restoration Report";
 * "Preliminary Title Report - 5733 E Stillwater ..., CA 92869.pdf" -> "Preliminary Title Report".
 * The address is in the subject already.
 */
function attachmentLabel(filename, address) {
  let n = String(filename || '').replace(/\.pdf$/i, '').trim();
  const a = String(address || '').trim();
  if (a && n.toLowerCase().endsWith(` - ${a.toLowerCase()}`)) n = n.slice(0, -(a.length + 3)).trim();
  return n;
}

function guideProblems(guide, totalPages, stillToCome) {
  const problems = [];
  let next = 0;
  for (const g of guide) {
    if (!g || !g.from || !g.to || g.to < g.from) { problems.push(`bad range ${JSON.stringify(g)}`); continue; }
    if (next && g.from !== next) problems.push(`pages ${next}-${g.from - 1} are missing from the guide (or overlap)`);
    next = g.to + 1;
    const code = String(g.label || '').match(RX_FORM_CODE);
    if (code) problems.push(`"${g.label}" uses the form code ${code[0]}; say it in plain English`);
    if (!String(g.label || '').trim()) problems.push(`pages ${g.from}-${g.to} have no description`);
  }
  if (totalPages && next !== totalPages + 1) problems.push(`the guide ends at page ${next - 1} but the PDF has ${totalPages} pages`);
  for (const item of stillToCome || []) {
    const code = String(item || '').match(RX_FORM_CODE);
    if (code) problems.push(`still-to-come "${item}" uses the form code ${code[0]}; say it in plain English`);
  }
  return problems;
}

function fillWithGuide(html, { guide, totalPages, stillToCome = [], reportsLink = '', attached = [] }) {
  const out = String(html || '');
  const problems = guideProblems(guide, totalPages, stillToCome);
  for (const a of attached || []) {
    const code = String(a || '').match(RX_FORM_CODE);
    if (code) problems.push(`the attachment "${a}" uses the form code ${code[0]}; rename the file in plain English`);
  }
  if (problems.length) return { html: out, filled: { guide: false }, warnings: problems };

  const seller = RX_SELLER_RANGE.exec(out) || /Pages(?:\s|&nbsp;|<[^>]+>)*1(?:\s|&nbsp;|<[^>]+>)*-/i.exec(out);
  const rem = /The\s+remainder\s+of\s+the\s+PDF\s+package/i.exec(out);
  if (!seller || !rem || rem.index < seller.index) {
    return { html: out, filled: { guide: false }, warnings: ['could not find the "Pages 1 - X" through "The remainder of the PDF package" lines; nothing changed'] };
  }
  const spanAt = out.lastIndexOf('<span', seller.index);
  const start = spanAt >= 0 && seller.index - spanAt < 120 ? spanAt : seller.index;
  // End of the remainder sentence: the first line break or paragraph end after it.
  const after = out.slice(rem.index);
  const br = after.search(/<br\b/i);
  const para = after.search(/<\/(p|div)>/i);
  let end; let brLayout;
  if (br >= 0 && (para < 0 || br < para)) {
    brLayout = true;
    end = rem.index + br;   // keep the line breaks that follow, they separate the next line
  } else if (para >= 0) {
    brLayout = false;
    end = rem.index + para + after.slice(para).match(/^<\/(p|div)>/i)[0].length;
  } else {
    return { html: out, filled: { guide: false }, warnings: ['could not find the end of the "remainder" line; nothing changed'] };
  }

  const items = guide.map((g) => `<li><b>${esc(range(g))}:</b> ${esc(g.label)}</li>`).join('');
  // OPTION A (Megan, 2026-10-23: "lets do option a moving forward"): short
  // labels, and what is still to come as its own list, so it scans at a glance.
  const parts = [`<b>What's in the package:</b><ul>${items}</ul>`];
  const todo = (stillToCome || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (todo.length) parts.push(stillToComeList(todo));
  // THE SEPARATE ATTACHMENTS, NAMED (Megan, 5733 E Stillwater #2, 2026-10-23:
  // "dont we need to address the 3 seller reports attached? same with prelim?").
  const files = (attached || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (files.length) parts.push(`<b>Also attached as separate files:</b><ul>${files.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);
  if (reportsLink) parts.push(`<a href="${esc(reportsLink)}">CLICK HERE FOR SELLER REPORTS</a>`);
  const block = brLayout ? parts.join('<br><br>') : parts.map((x) => `<div>${x}</div><br>`).join('');
  return { html: out.slice(0, start) + block + out.slice(end), filled: { guide: true }, warnings: [] };
}

/**
 * GREETING (Megan, 2026-10-23, 10600 Eastborne: the Zap wrote "Hello Jesse,"
 * on an email to Jesse AND Gayle). Replaces only the first "Hello <names>,"
 * the Zap wrote; refused (draft untouched) when there is none.
 */
function replaceGreeting(html, greeting) {
  const g = String(greeting || '').trim();
  if (!g) return { html, warnings: [] };
  if (!/^(Hello|Hi|Dear)\b[^<>]{1,80},$/.test(g)) return { html, warnings: [`"${g}" does not look like a greeting ("Hello Jesse and Gayle,")`] };
  const rx = /\b(Hello|Hi|Dear)\b[^<>,]{1,80},/;
  if (!rx.test(html)) return { html, warnings: ['no "Hello <name>," greeting found in the draft; the greeting was not changed'] };
  return { html: html.replace(rx, esc(g)), warnings: [] };
}

function fillBuyerEmail(html, opts = {}) {
  if (opts.greeting) {
    const g = replaceGreeting(html, opts.greeting);
    if (g.warnings.length) return { html, filled: {}, warnings: g.warnings };
    const rest = fillBuyerEmail(g.html, { ...opts, greeting: '' });
    return rest.warnings.length ? { ...rest, html } : { ...rest, filled: { ...rest.filled, greeting: true } };
  }
  if (Array.isArray(opts.guide) && opts.guide.length) return fillWithGuide(html, opts);
  const { seller, avid, stillToCome = [], reportsLink = '' } = opts;
  let out = String(html || '');
  const warnings = [];
  const filled = { seller: false, avid: false };

  if (seller && RX_SELLER_RANGE.test(out)) {
    out = out.replace(RX_SELLER_RANGE, esc(range(seller)));
    filled.seller = true;
  } else if (seller) {
    warnings.push('the "Pages 1 - X" placeholder was not found; the seller page range was not filled in');
  }

  /**
   * NO AVID YET (12273 Donald Reed, 2026-10-22: "we dont have our clients avid
   * yet"; the listing side's had not arrived either). avid: { pending: true }
   * removes the whole "Pages X - X is the Agent Visual Inspection ..." line
   * instead of leaving a placeholder; the caller lists the AVIDs as still to come.
   */
  if (avid && avid.pending) {
    const m = RX_AVID_RANGE.exec(out);
    if (m) {
      const spanStart = out.lastIndexOf('<span', m.index);
      const start = spanStart >= 0 && m.index - spanStart < 120 ? spanStart : m.index;
      const rest = out.slice(m.index);
      const br = rest.search(/<br\s*\/?>(?:\s*<\/br>)?(?:\s*<br\s*\/?>(?:\s*<\/br>)?)?\s*/i);
      const para = rest.search(/<\/(p|div)>/i);
      let end;
      if (br >= 0 && (para < 0 || br < para)) {
        const tail = rest.slice(br).match(/^(?:\s*<br\s*\/?>(?:\s*<\/br>)?)+\s*/i);
        end = m.index + br + (tail ? tail[0].length : 0);
      } else if (para >= 0) {
        end = m.index + para + rest.slice(para).match(/^<\/(p|div)>/i)[0].length;
      }
      if (end) { out = out.slice(0, start) + out.slice(end); filled.avid = 'removed'; }
      else warnings.push('could not find the end of the AVID line; it was left as is');
    }
  } else if (avid && RX_AVID_RANGE.test(out)) {
    out = out.replace(RX_AVID_RANGE, esc(range(avid)));
    filled.avid = true;
  } else if (avid) {
    warnings.push('the "Pages X - X" placeholder was not found; the AVID page range was not filled in');
  }

  const extra = [];
  const items = (stillToCome || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (items.length) {
    extra.push(`<p><b>Still to come from the seller's side:</b> ${esc(joinList(items))}. `
      + 'I will send these over as soon as they arrive.</p>');
  }
  if (reportsLink) {
    extra.push(`<p><a href="${esc(reportsLink)}">CLICK HERE FOR SELLER REPORTS</a></p>`);
  }
  if (extra.length) {
    // Which layout: whichever comes FIRST after the sentence, a line break or
    // the end of a paragraph. 12273 Donald Reed's draft is <br>-separated but
    // wrapped in one outer <div>, so the paragraph rule put the lines after the
    // DocuSign sentence at the very end.
    const at = out.search(/The\s+remainder\s+of\s+the\s+PDF\s+package/i);
    const after = at >= 0 ? out.slice(at) : '';
    const brFirst = /<br\b/i.test(after) && (after.search(/<br\b/i) < (after.search(/<\/(p|div)>/i) + 1 || Infinity));
    if (!brFirst && RX_REMAINDER_LINE.test(out)) out = out.replace(RX_REMAINDER_LINE, `$1${extra.join('')}`);
    else if (RX_REMAINDER_BR.test(out)) {
      const asLines = extra.map((x) => x.replace(/^<p>/, '<br><br>').replace(/<\/p>$/, '')).join('');
      out = out.replace(RX_REMAINDER_BR, `$1${asLines}$2`);
    } else warnings.push('could not find "The remainder of the PDF package" line; the extra lines were not added');
  }
  return { html: out, filled, warnings };
}

/** "Still to come from the seller:" as a bulleted list, each item capitalised (Option A). */
function stillToComeList(todo) {
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  return `<b>Still to come from the seller:</b><ul>${todo.map((x) => `<li>${esc(cap(x))}</li>`).join('')}</ul>`
    + "I'll send these over as soon as they arrive.";
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * THE REVISION EMAIL (Megan, 2026-10-22, 8 Star Catcher): when the listing
 * side's revisions arrive, the buyer gets the revised pages as a REPLY in the
 * "Seller Disclosure Package" thread. Her edited version is the template:
 *
 *   Hello Shahrokh and Omeed,
 *   The seller has sent over a few updates to their disclosures. The revised pages are attached:
 *       Pages 1: The seller filled in where the 220 volt wiring is located (the garage).
 *       Pages 8: The seller added a note that the HOA regularly maintains ...
 *   These replace the matching Transfer Disclosure Statement, Seller Property
 *   Questionnaire, and Solar Advisory pages in the package I sent earlier.
 *
 * One line per CHANGE, pointing at the exact page of the attached PDF (not
 * form-wide ranges); forms named IN FULL in the closing (codes are refused);
 * no DocuSign line. There is no Zap draft to fill, so the whole body is built
 * here; the caller appends her signature.
 *   greeting:    "Hello Shahrokh and Omeed," (every buyer, by first name)
 *   changes:     [{ page, label }] page = page number in the attached PDF
 *   forms:       ['Transfer Disclosure Statement', ...] full names, package order
 *   totalPages:  the attached PDF's page count
 *   stillToCome: items still open from HER SENT corrections email (may be empty)
 *   requested:   optional count of items in her sent corrections email; every
 *                one must be a change line or a still-to-come item
 * Refuses (html '', warnings) rather than build a wrong email.
 */
function buildRevisionEmail({ greeting, changes, forms, totalPages, stillToCome = [], requested }) {
  const problems = [];
  const todo = (stillToCome || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!Array.isArray(changes) || !changes.length) problems.push('no change lines');
  if (!Array.isArray(forms) || !forms.length) problems.push('no form names for the closing line');
  if (!String(greeting || '').trim()) problems.push('no greeting');
  for (const c of changes || []) {
    const n = Number(c && c.page);
    if (!Number.isInteger(n) || n < 1 || (totalPages && n > totalPages)) {
      problems.push(`page ${c && c.page} is not in the attached PDF (${totalPages} pages)`);
    }
    if (!String((c && c.label) || '').trim()) problems.push(`page ${c && c.page} has no description`);
  }
  if (requested != null && (changes || []).length + todo.length < requested) {
    problems.push(`her corrections email asked for ${requested} item(s) but only ${(changes || []).length + todo.length} are accounted for`);
  }
  const texts = [['greeting', greeting], ...(changes || []).map((c) => [`page ${c && c.page}`, c && c.label]),
    ...(forms || []).map((f) => ['form name', f]), ...todo.map((t) => ['still to come', t])];
  for (const [name, s] of texts) {
    const code = String(s || '').match(RX_FORM_CODE);
    if (code) problems.push(`the ${name} "${s}" uses the form code ${code[0]}; say it in plain English`);
  }
  if (problems.length) return { html: '', warnings: problems };

  const line = (c) => `<div style="margin-left:40px"><b>Pages ${Number(c.page)}:</b> ${esc(String(c.label).trim())}</div>`;
  const parts = [
    `<div>${esc(String(greeting).trim())}</div><br>`,
    '<div>The seller has sent over a few updates to their disclosures. The revised pages are attached:</div>',
    // Two changes on the same page read as one line (1222 N Kings Rd #8: both
    // fixes on the one-page amendment gave "Pages 1:" twice).
    mergeSamePage(changes).map(line).join(''),
    '<br>',
  ];
  if (todo.length) {
    parts.push(`<div>${stillToComeList(todo)}</div><br>`);
  }
  parts.push(`<div>${esc(closingLine(forms))}</div><br>`);
  return { html: parts.join(''), warnings: [] };
}

function mergeSamePage(changes) {
  const byPage = new Map();
  for (const c of changes.slice().sort((x, y) => x.page - y.page)) {
    const t = String(c.label).trim();
    byPage.set(c.page, byPage.has(c.page) ? `${byPage.get(c.page)} ${t}` : t);
  }
  return [...byPage].map(([page, label]) => ({ page, label }));
}

// An AMENDMENT adds to the questionnaire rather than replacing its pages
// (Megan, 2026-10-22, 1222 N Kings Rd #8: "This amendment updates the seller's
// disclosures in the package I sent earlier.").
function closingLine(forms) {
  const amend = forms.filter((f) => /amendment/i.test(f));
  const other = forms.filter((f) => !/amendment/i.test(f));
  if (!amend.length) return `These replace the matching ${serialList(other)} pages in the package I sent earlier.`;
  const a = amend.length === 1 ? 'This amendment updates' : 'These amendments update';
  if (!other.length) return `${a} the seller's disclosures in the package I sent earlier.`;
  return `These replace the matching ${serialList(other)} pages in the package I sent earlier, and the ${amend.length === 1 ? 'amendment updates' : 'amendments update'} the seller's disclosures.`;
}

// "A, B, and C" (her closing line keeps the serial comma).
function serialList(items) {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

module.exports = { attachmentLabel, fillBuyerEmail, buildRevisionEmail, joinList, guideProblems, RX_FORM_CODE };
