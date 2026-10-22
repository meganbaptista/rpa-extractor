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
const RX_SELLER_RANGE = new RegExp(`Pages${T}1${T}-${T}X`, 'i');
const RX_AVID_RANGE = new RegExp(`Pages${T}X${T}-${T}X`, 'i');
const RX_REMAINDER_LINE = /(<(p|div)\b[^>]*>(?:(?!<\/\2>)[\s\S])*The\s+remainder\s+of\s+the\s+PDF\s+package[\s\S]*?<\/\2>)/i;

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
function fillBuyerEmail(html, { seller, avid, stillToCome = [], reportsLink = '' } = {}) {
  let out = String(html || '');
  const warnings = [];
  const filled = { seller: false, avid: false };

  if (seller && RX_SELLER_RANGE.test(out)) {
    out = out.replace(RX_SELLER_RANGE, esc(range(seller)));
    filled.seller = true;
  } else if (seller) {
    warnings.push('the "Pages 1 - X" placeholder was not found; the seller page range was not filled in');
  }

  if (avid && RX_AVID_RANGE.test(out)) {
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
    if (RX_REMAINDER_LINE.test(out)) out = out.replace(RX_REMAINDER_LINE, `$1${extra.join('')}`);
    else warnings.push('could not find "The remainder of the PDF package" line; the extra lines were not added');
  }
  return { html: out, filled, warnings };
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

module.exports = { fillBuyerEmail, joinList };
