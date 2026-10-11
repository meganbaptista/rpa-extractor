// netlify/functions/lib/timeline-email.js
//
// THE DAY-0 DATES, FROM MEGAN'S ESCROW INTRODUCTION EMAILS. The scoreboard's
// answer key (lib/scoreboard.js).
//
// Why these emails (Megan, 2026-10-10). Scoring the extractor against the
// deal's CURRENT values counted every repair-price reduction, extension and
// re-opened escrow as an extraction miss (3627 Cody: the extractor read the
// second contract exactly; Process Street showed the extended close). The
// introduction email is written from the contract the day escrow opens,
// before anything changes, and every one has the same shape:
//
//   Subject: <Property Address> | Seller Escrow Introductions
//            <Property Address> | Buyer Escrow Introductions
//   IMPORTANT DATES/TIMELINE OF ESCROW:
//     Acceptance Date: Wednesday, September 16th
//     Buyer Deposit Due: Monday, September 21st
//     Seller to Deliver Disclosures: ...
//     Buyer Inspection Contingency Release: Monday, September 21st
//     Close of Escrow: Wednesday, October 7th
//
// Plain code, no model: the layout is hers and does not vary.

'use strict';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "<address> | Seller Escrow Introductions" -> { address, side }, or null. */
function parseSubject(subject) {
  const m = /^\s*(?:(?:re|fwd?|fw)\s*:\s*)*(.+?)\s*\|\s*(seller|buyer)\s+escrow\s+introductions?\s*$/i.exec(String(subject || ''));
  return m ? { address: m[1].trim(), side: m[2][0].toUpperCase() + m[2].slice(1).toLowerCase() } : null;
}

/**
 * "Wednesday, September 16th" -> "2026-09-16". The year is not written, so it
 * is the one that puts the date nearest the email's own date (a December
 * email naming "January 8th" means next year).
 */
function parseDay(text, sentIso) {
  const m = /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i.exec(String(text || ''));
  if (!m) return '';
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const day = Number(m[2]);
  const sent = new Date(sentIso || Date.now());
  let year = m[3] ? Number(m[3]) : sent.getUTCFullYear();
  if (!m[3]) {
    const candidates = [year - 1, year, year + 1].map((y) => ({ y, t: Date.UTC(y, month, day) }));
    year = candidates.sort((a, b) => Math.abs(a.t - sent.getTime()) - Math.abs(b.t - sent.getTime()))[0].y;
  }
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Her labels, loosely: the wording drifts a little from email to email.
const LINES = [
  { key: 'acceptance', re: /acceptance\s*date/i },
  { key: 'emd', re: /(buyer\s*)?deposit\s*due|\bemd\b/i },
  { key: 'disclosures', re: /deliver\s*disclosures|disclosures?\s*due/i },
  { key: 'inspection', re: /inspection|investigation/i },
  { key: 'appraisal', re: /appraisal/i },
  { key: 'loan', re: /\bloan\b/i },
  { key: 'close', re: /close\s*of\s*escrow|\bcoe\b/i },
  { key: 'possession', re: /possession/i },
];

/**
 * The timeline block's dates. Only lines inside the block, so a date in the
 * greeting or the signature never counts. A line that is not a date
 * ("Waived", "N/A") is recorded as 'none' - a contingency that does not exist.
 */
function parseTimeline(bodyText, sentIso) {
  const text = String(bodyText || '');
  const start = text.search(/important\s+dates\s*\/?\s*timeline/i);
  if (start < 0) return null;
  const block = text.slice(start).split(/\n/).slice(1, 25);
  const out = {};
  for (const raw of block) {
    const line = raw.replace(/^[\s•*\-–·]+/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) {
      // The block ends at the first ordinary sentence after it began.
      if (Object.keys(out).length && line.length > 60) break;
      continue;
    }
    const label = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    const hit = LINES.find((l) => l.re.test(label));
    if (!hit || out[hit.key] !== undefined) continue;
    const day = parseDay(value, sentIso);
    out[hit.key] = day || (/waiv|n\/?a|none|no\s/i.test(value) ? 'none' : '');
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { parseSubject, parseTimeline, _internal: { parseDay } };
