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

function fillWithGuide(html, { guide, totalPages, stillToCome = [], reportsLink = '' }) {
  const out = String(html || '');
  const problems = guideProblems(guide, totalPages, stillToCome);
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
  const parts = [`<b>Here is how the package is organized:</b><ul>${items}</ul>`];
  const todo = (stillToCome || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (todo.length) parts.push(`<b>Still to come from the seller's side:</b> ${esc(joinList(todo))}. I will send these over as soon as they arrive.`);
  if (reportsLink) parts.push(`<a href="${esc(reportsLink)}">CLICK HERE FOR SELLER REPORTS</a>`);
  const block = brLayout ? parts.join('<br><br>') : parts.map((x) => `<div>${x}</div><br>`).join('');
  return { html: out.slice(0, start) + block + out.slice(end), filled: { guide: true }, warnings: [] };
}

function fillBuyerEmail(html, opts = {}) {
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

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

module.exports = { fillBuyerEmail, joinList, guideProblems, RX_FORM_CODE };
