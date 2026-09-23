// netlify/functions/lib/compliance-doc.js
//
// ============================================================================
// Reconcile a deal's compliance Google Doc against the files in its folder.
// ============================================================================
// Megan, 2026-09-23: "it should find the google doc compliance list associated
// with the address and update the list" — cross off what arrived, annotate what
// is still short a signature.
//
// DETERMINISTIC. No AI. The splitter has already done the hard part: it
// identified each form, audited its signatures, and wrote the verdict into the
// FILENAME as `<label> - <status>`. So the update is a filename-to-list match,
// which means it is reviewable, repeatable, and cheap.
//
// IT READS THE DEAL FOLDER, NOT THE PACKAGE THAT JUST ARRIVED. Anything filed
// by hand counts the same as anything the splitter wrote — Megan added a BA
// AVID and a Booklets receipt that came separately, and a folder-driven
// reconcile picks those up with no special case. It is also idempotent: running
// it twice changes nothing the second time.
//
// EVERY SECTION, not just DISCLOSURES. Megan: "sometimes lets say an ABA is in
// the disclosures signed PDF, the ABA would be listed in PURCHASE DOCUMENTS so
// safe to look in that as well." Her own worked example also clears a Prelim
// Receipt out of CLOSING PACKAGE ITEMS. So the rule is per LINE, and the
// section headings are only preserved, never interpreted.
// ============================================================================

/** A filename suffix meaning every required party has signed. */
const DONE = 'FX';

/**
 * Suffixes that mean "arrived but short a signature".
 *
 * TWO DIALECTS IN ONE FOLDER, and both are real. The splitter generates `N` +
 * the missing parties from ['B','S','BA','LA'] — `NB`, `NS+LA`. Megan types
 * `NeedSS`, `NeedLA`, `NeedSS+LA`, and `MISSING` when a form has not come at
 * all. The reconcile reads any of them; only `FX` clears a line.
 */
const OUTSTANDING = /^(N[BS]?|N[A-Z+]*|Need[A-Za-z+]*|MISSING)$/i;

/**
 * Doc wording -> the code the splitter names a file with.
 *
 * ONLY WHERE THEY GENUINELY DIVERGE. Most lines already start with the same
 * code as the file ("SPQ - ", "SPQ - Seller Property Questionnaire - FX.pdf"),
 * and a table of every form would rot. These are the ones Megan's Doc words
 * differently from the form.
 */
const ALIASES = [
  { key: 'avid-la', match: [/^la\s*avid\b/i, /^avid[\s-]*la\b/i] },
  { key: 'avid-ba', match: [/^ba\s*avid\b/i, /^avid[\s-]*ba\b/i] },
  { key: 'eq-booklet', match: [/^(earthquake|eq)\s+booklet\s+receipt/i] },
  { key: 'mls', match: [/^mls\b/i] },
  { key: 'nhd', match: [/^nhd\b/i] },
  { key: 'prelim', match: [/^prelim\b/i] },
  { key: 'home-insp', match: [/^property\s+inspections?\b/i, /^home\s+insp/i] },
  { key: 'termite', match: [/^termite\b/i] },
];

/** The canonical key for either a Doc line or a filename, or '' if neither. */
function aliasFor(text) {
  for (const a of ALIASES) if (a.match.some((re) => re.test(text))) return a.key;
  return '';
}

/** Letters and digits only — punctuation and spacing are noise on both sides. */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim();
}

/**
 * The part of a Doc line that names the document.
 *
 * Her lines carry trailing notes and parentheticals — "SFLS - 1,309 sqft sqft -",
 * "WCMD (only SFR required) -", "Brokerage Affiliate Disclosures (If any) -
 * Other". The document's name is what comes before the first " - " or " (".
 */
function itemKey(line) {
  const text = String(line || '').replace(/^\s*[-*•]\s*/, '').trim();
  return aliasFor(text) || norm(text.split(/\s+[-–]\s+|\s*\(/)[0]);
}

/** `SPQ - Seller Property Questionnaire - FX.pdf` -> { key: 'spq', status: 'FX' }. */
function fileKey(filename) {
  const base = String(filename || '').replace(/\.pdf$/i, '').trim();
  /**
   * THE STATUS IS THE LAST TOKEN, however it was punctuated.
   *
   * Splitting on dashes did not survive contact with the real folder. The
   * splitter writes "TDS - ... - NB", but hand-named files put the same fact
   * in three other shapes: "Prelim - BSIGNED-FX", "CR 2 FX", "Eq Booklet
   * Receipt- FX". Reading a trailing token instead of a delimited field gets
   * all four, and leaves "AVID-LA" alone because the hyphen there is inside a
   * word rather than before the status.
   */
  const m = base.match(/[\s-]+(N[A-Za-z+]*|Need[A-Za-z+]*|MISSING|FX)\s*$/i);
  const status = m ? m[1] : '';
  const label = status ? base.slice(0, m.index).replace(/[\s-]+$/, '') : base;
  return { key: aliasFor(label) || norm(label), status };
}

/**
 * Does this file answer this line?
 *
 * PREFIX MATCH ON THE CODE, in one direction only: the file's label may say
 * more than the Doc line ("SPQ" answers "SPQ - Seller Property Questionnaire"),
 * and a line may say more than the file. Both are anchored at the START, so
 * "SPQ" never matches "PSD" and "AVID-LA" never answers "AVID-BA".
 */
function answers(itemK, fileK) {
  if (!itemK || !fileK) return false;
  if (itemK === fileK) return true;
  const a = itemK + ' ';
  const b = fileK + ' ';
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * What to do to each line of the Doc.
 *
 * Returns one decision per line:
 *   delete  — a file exists and every required party signed
 *   annotate— a file exists and somebody still has to sign; the line keeps its
 *             name and takes the file's status
 *   keep    — nothing matched, so nothing is known and nothing changes
 *
 * NOTHING IS EVER INVENTED. A line with no matching file is left exactly as it
 * reads, because the only safe failure here is telling a TC to chase something
 * they already have. See the pipeline memo on the asymmetry.
 */
function planLine(line, files) {
  const text = String(line || '').replace(/^\s*[-*•]\s*/, '').trim();
  if (!text) return null;
  const key = itemKey(text);
  /**
   * EXACT BEFORE PREFIX. Both "SPQ - Seller Property Questionnaire - FX" and
   * "SPQ - Addendum - FX" start with the SPQ code, and the addendum must not
   * be what answers the SPQ line when the questionnaire itself is right there.
   */
  /**
   * AN ADDENDUM IS NOT THE FORM IT AMENDS. "SPQ - Addendum - FX" prefix-matches
   * the "SPQ -" line, and on 700 S Abel it sorted first and answered it — so
   * the line cleared on the wrong document and the real questionnaire showed up
   * as a file nothing had asked for. A continuation sheet only answers a line
   * that names one.
   */
  const wantsAddendum = /addend|amend|supplement/i.test(text);
  const eligible = wantsAddendum
    ? files
    : files.filter((f) => !/addend|amend|supplement/i.test(f.filename));
  const hit =
    eligible.find((f) => f.key === key) || eligible.find((f) => answers(key, f.key));
  if (!hit) return { text, action: 'keep' };
  if (hit.status === DONE) return { text, action: 'delete', file: hit.filename };
  if (hit.status && OUTSTANDING.test(hit.status)) {
    // The line's own name, with the file's status replacing any old one.
    const name = text.replace(/\s*[-–]\s*[^-–]*$/, (m) =>
      OUTSTANDING.test(norm(m).toUpperCase()) || /^\s*[-–]\s*$/.test(m) ? '' : m);
    const to = `${name.replace(/\s*[-–]\s*$/, '').trim()} - ${hit.status}`;
    /**
     * AN ANNOTATION THAT CHANGES NOTHING IS NOT A CHANGE.
     *
     * Running over an already-updated Doc planned "TDS - NB -> TDS - NB", which
     * reads in the preview as work to do. This is the idempotency that makes
     * the consumer safe to fire on every split: the second pass over an
     * unchanged folder must plan nothing at all.
     */
    if (to === text) return { text, action: 'keep', file: hit.filename };
    return { text, action: 'annotate', to, file: hit.filename };
  }
  /**
   * A FILE WITH NO READABLE STATUS. Third-party reports carry no C.A.R.
   * signature block and get named however they arrive — "Home Insp Report
   * (S)-B signed". Its presence is not proof every party signed, so the line
   * STAYS and the caller is told a file exists. Deleting on presence alone is
   * the one direction that can tell a TC they are covered when they are not.
   */
  return { text, action: 'review', file: hit.filename };
}

/**
 * DERIVED LINES: checks on a form's CONTENT, cleared by the form arriving fully
 * executed rather than by a file of their own.
 *
 * Megan, 2026-09-23: "If the TDS is FX we can remove the 'TDS C,12,13,14 =
 * YES, there is an HOA -' line. If the SPQ is FX, we can remove the 'SPQ 6G +
 * Section 14 = YES, there is an HOA -' line."
 *
 * And the brokerage one clears itself: "When it says Other, there aren't any."
 * A line naming a real brokerage does NOT clear — those forms carry the
 * brokerage in a header and have to actually turn up.
 */
function derivedClear(text, arrived) {
  const t = String(text || '');
  /**
   * ARRIVED, NOT FULLY EXECUTED — and this deviates from Megan's literal
   * words, deliberately. She said "If the TDS is FX we can remove the TDS
   * C,12,13,14 line", but on 700 S Abel the TDS came back `NB` and she
   * removed that line anyway. Her action is the better rule: these check what
   * the seller ANSWERED, and the answers are readable the moment the form is
   * in hand. A missing buyer signature says nothing about paragraph 12.
   */
  if (/^TDS\s+C\s*,/i.test(t)) return arrived('tds');
  if (/^SPQ\s+6G\b/i.test(t)) return arrived('spq');
  if (/^Brokerage\s+Affiliate\s+Disclosures?\b/i.test(t)) return /-\s*other\s*$/i.test(t);
  return false;
}

/**
 * The whole plan for a Doc: one decision per line, headings untouched.
 *
 * `files` is the deal folder's filenames. Headings and blank lines pass
 * through as 'heading' so a caller can render a preview that reads like the
 * Doc it will produce.
 */
function planDoc(docText, filenames) {
  const files = filenames.map((n) => ({ filename: n, ...fileKey(n) }));
  const arrived = (k) => files.some((f) => answers(k, f.key));
  const matched = new Set();
  const out = [];
  for (const raw of String(docText || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const isBullet = /^\s*[-*•]\s+/.test(raw);
    if (!isBullet) {
      out.push({ text: raw, action: 'heading' });
      continue;
    }
    const plan = planLine(raw, files);
    if (!plan) continue;
    if (plan.file) matched.add(plan.file);
    if (plan.action === 'keep' && derivedClear(plan.text, arrived)) {
      out.push({ text: plan.text, action: 'delete', reason: 'cleared by the form it checks' });
      continue;
    }
    out.push(plan);
  }

  /**
   * FILES THE LIST NEVER ASKED FOR, reported and never added.
   *
   * Megan hand-added "Receipt for Links to Booklets - NeedSS" to her Doc
   * because the form arrived separately and was not on the original list.
   * Keeva can SEE that file sitting in the folder, so it can say so — but
   * adding a line to a compliance list is a bigger claim than crossing one
   * off, and it is her list. Surfaced for a human, never written.
   */
  const unmatched = files
    .filter((f) => !matched.has(f.filename))
    .map((f) => f.filename);

  return { lines: out, unmatched };
}

/**
 * Find a deal's compliance Doc from the master sheet.
 *
 * The same lookup `disclosure-intake-check-background` does inline: match the
 * address against column A and take the Doc URL from the "Compliance Audit
 * List URL" column. Lives here rather than there because it is about the
 * compliance Doc, and the intake check should eventually call this instead of
 * keeping its own copy.
 *
 * THE LAST NON-EMPTY MATCH WINS. Rows are appended, so a cancelled deal and a
 * re-opened one share an address and the newer row is the live one.
 */
async function findComplianceDocUrl(address, csvUrl = process.env.AUDIT_LIST_CSV_URL) {
  if (!csvUrl || !address) return '';
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`master sheet fetch ${res.status}`);
  const rows = parseCsv(await res.text());
  if (rows.length < 2) return '';
  const header = rows[0].map((h) => String(h).toLowerCase().trim());
  const addrCol = Math.max(0, header.findIndex((h) => h.includes('address')));
  const urlCol = header.findIndex((h) => h.includes('compliance') && (h.includes('url') || h.includes('link')));
  if (urlCol < 0) return '';
  const want = norm(address);
  let found = '';
  for (const r of rows.slice(1)) {
    if (norm(r[addrCol] || '') !== want) continue;
    const u = String(r[urlCol] || '').trim();
    if (u) found = u;
  }
  return found;
}

/** Minimal CSV reader — the sheet has quoted commas in addresses. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** The Doc's live text. Link-viewable, so the export endpoint needs no auth. */
async function fetchDocText(docUrl) {
  const id = (String(docUrl || '').match(/\/document\/d\/([a-zA-Z0-9_-]+)/) || [])[1];
  if (!id) return { id: '', text: '' };
  const res = await fetch(`https://docs.google.com/document/d/${id}/export?format=txt`);
  if (!res.ok) throw new Error(`doc export ${res.status}`);
  return { id, text: String(await res.text()).replace(/^\ufeff/, '') };
}

module.exports = {
  planDoc, planLine, itemKey, fileKey, answers, DONE, OUTSTANDING,
  findComplianceDocUrl, fetchDocText, parseCsv,
};