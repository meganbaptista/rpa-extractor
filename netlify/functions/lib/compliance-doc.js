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
 * the missing parties from ['B','S','BA','LA','BR'] — `NB`, `NS+LA` — except
 * for a lone missing broker, which reads `NeedBroker(s)` because that is a
 * different chase and Megan asked for it in words. She hand-types `NeedSS`,
 * `NeedLA`, `NeedBA`, `NeedSS+LA`, and `MISSING` when a form has not come at
 * all. The reconcile reads any of them; only `FX` clears a line.
 *
 * The parenthesis in `NeedBroker(s)` is why this pattern allows them.
 */
const OUTSTANDING = /^(NEEDB[A-Za-z()+]*|Need[A-Za-z()+]*|N[A-Z+]*|MISSING)$/i;

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
  /**
   * The affiliated business disclosure, which her list and the forms name
   * four different ways: "ABA", "Brokerage Affiliate Disclosures (If any)",
   * "Affiliated Business Arrangement Disclosure Statement" (C.A.R. and most
   * brokerages) and plain "Affiliated Business Disclosure" (Sotheby's). With
   * no alias, a list line reading "ABA -" never matched a file named
   * "...Affiliated Business Arrangement Disclosure Statement..." and the Doc
   * went on asking for a form sitting in the folder.
   */
  { key: 'aba', match: [/^aba\b/i, /^affiliated\s+business\b/i, /^brokerage\s+affiliate/i] },
];

/**
 * A filename may lead with the BROKERAGE, so aliasing has to look past it.
 *
 * Every pattern above is anchored at the start, which was fine while a file was
 * named for its form. Since 2026-09-24 a document with no C.A.R. code files as
 * "<Firm> - <Name> - <STATUS>" - Megan: "I would urge for the brokerage name to
 * be before 'Affiliate'" - so "Christie's International Real Estate - EQ
 * Booklet Receipt" would have stopped matching the eq-booklet alias, and the
 * prefix that made the folder legible would have broken the reconcile.
 *
 * The full text is tried FIRST, so a line that genuinely starts with an alias
 * ("LA AVID - NeedB") is unaffected.
 */
function withoutLeadingFirm(text) {
  const t = String(text || '').trim();
  const cut = t.indexOf(' - ');
  return cut > 0 ? t.slice(cut + 3).trim() : '';
}

/** The canonical key for either a Doc line or a filename, or '' if neither. */
function aliasFor(text) {
  for (const a of ALIASES) if (a.match.some((re) => re.test(text))) return a.key;
  const tail = withoutLeadingFirm(text);
  if (tail) {
    for (const a of ALIASES) if (a.match.some((re) => re.test(tail))) return a.key;
  }
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
  /**
   * "need SS" IS THE SAME STATUS AS "NeedSS".
   *
   * Megan hand-names files with a space - `BA AVID - need SS.pdf` - and the
   * trailing token was read as just "SS", which matches no status, so the line
   * fell through to "a file exists but Keeva cannot tell if it is complete"
   * and was left untouched on her list. It should have annotated the BA AVID
   * line to NeedSS. Her spacing is the correct spelling of the thing; it is
   * the parser that has to accept both.
   *
   * The captured status is normalised to the closed-up form so everything
   * downstream - the OUTSTANDING test, and the text written into the Doc -
   * sees one spelling, and the Doc gets the same vocabulary the splitter uses
   * in filenames.
   */
  // The parentheses are for "NeedBroker(s)"; the + for "NeedSS+LA".
  const m = base.match(/[\s-]+(Need\s*[A-Za-z()+]*|N[A-Za-z+]*|MISSING|FX)\s*$/i);
  const status = m ? m[1].replace(/^need\s+/i, 'Need') : '';
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
 * Is this a continuation sheet, rather than a form whose NAME contains the
 * word?
 *
 * TESTED PER DASH-SEGMENT, not anywhere in the string, which was the bug: the
 * LPD's full name is "Lead-Based Paint and Lead-Based Paint Hazards
 * Disclosure, Acknowledgment and Addendum", so "LPD 1978 -" matched nothing
 * while its file sat in the folder excluded as an addendum. A real one
 * announces itself as its own segment — "SPQ - Addendum", "TDS - Addendum
 * No. 1".
 */
function isAddendum(text) {
  return String(text || '')
    .replace(/\.pdf$/i, '')
    .split(/\s-\s*|\s*-\s/)
    .some((part) => /^(addendum|amendment|supplement)\b/i.test(part.trim()));
}

/** The form code a line or a label opens with: LPD, TDS, SPQ, TA, AC. */
function leadingCode(text) {
  const m = String(text || '').trim().match(/^([A-Z]{2,6})(?=[\s\-–:,]|$)/);
  return m ? m[1].toLowerCase() : '';
}

/**
 * A LAST RESORT FOR LINES THAT NAME A FORM WITHOUT ITS CODE.
 *
 * Her Docs say "Trust Advisory-" for TA and "Los Angeles County Local Area
 * Disclosures" for a file called "Local Area Disclosures – Greater Area Los
 * Angeles". Neither leads with a code and neither is a prefix of the other, so
 * both were being left untouched with the file sitting right there.
 *
 * SCORED ON SHARED WORDS, and deliberately timid: short words are ignored, the
 * overlap must cover most of the shorter side, and the match must be UNIQUE.
 * A wrong match here DELETES a line off a compliance list, so an ambiguous
 * one has to lose to "leave it alone".
 */
function overlapScore(itemK, fileK) {
  const words = (k) => new Set(String(k).split(' ').filter((w) => w.length > 3));
  const a = words(itemK);
  const b = words(fileK);
  if (a.size < 2 || b.size < 2) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

const OVERLAP_MIN = 0.75;

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
  const wantsAddendum = isAddendum(text);
  const eligible = wantsAddendum ? files : files.filter((f) => !isAddendum(f.filename));
  /**
   * IN ORDER OF CONFIDENCE, and it stops at the first that lands: an exact
   * key, then a prefix, then a shared form code, then a unique strong word
   * overlap. Anything less certain than that is no match at all.
   */
  const code = leadingCode(text);
  let hit =
    eligible.find((f) => f.key === key) ||
    eligible.find((f) => answers(key, f.key)) ||
    (code ? eligible.find((f) => leadingCode(f.filename) === code) : undefined);

  if (!hit) {
    const scored = eligible
      .map((f) => ({ f, score: overlapScore(key, f.key) }))
      .filter((x) => x.score >= OVERLAP_MIN)
      .sort((x, y) => y.score - x.score);
    // Unique or clearly ahead — a tie means Keeva cannot tell, so it does not.
    if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
      hit = scored[0].f;
    }
  }
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
/** A line asking something of a numbered paragraph, rather than naming a form. */
function isContentCheck(text) {
  return /^([A-Z]{2,6})\b[^=:]*[=:]/.test(String(text || '').trim());
}

function derivedClear(text, arrived) {
  const t = String(text || '').trim();

  /**
   * A CHECK ON A FORM'S CONTENTS, not a document of its own.
   *
   * Her lists carry several: "TDS C,12,13,14 = YES, there is an HOA", "SPQ 6G
   * + Section 14 = YES", "SPQ 7E: Yes, property built prior to 1978". The
   * first two were hardcoded and the third then arrived, so the rule is
   * generalised: a line that OPENS with a form code and then asks something
   * of a numbered paragraph — marked by an "=" or a ":" — is a check on that
   * form, and it clears when the form itself turns up.
   *
   * THE "=" OR ":" IS WHAT KEEPS "LPD 1978 -" OUT. That line is the form,
   * qualified by the year that makes it apply, not a question about paragraph
   * 1978.
   *
   * ARRIVED, NOT FULLY EXECUTED: these read what the seller ANSWERED, and the
   * answers are legible the moment the form is in hand. On 700 S Abel the TDS
   * came back NB and Megan cleared its content line anyway.
   */
  const check = t.match(/^([A-Z]{2,6})\b[^=:]*[=:]/);
  if (check) return arrived(norm(check[1]));

  /**
   * "Brokerage Affiliate Disclosures (If any) - Other" clears itself. Megan:
   * "When it says Other, there aren't any." A line naming a real brokerage
   * does NOT — those forms carry the brokerage in a header and must turn up.
   */
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
    const text = raw.replace(/^\s*[-*•]\s*/, '').trim();
    if (!text) continue;

    /**
     * A CONTENT CHECK IS DECIDED FIRST, and never matched as a document.
     *
     * "TDS C,12,13,14 = YES" opens with a form code, so the code tier below
     * happily matched it to the TDS file and ANNOTATED it with the TDS's
     * signature status — which is nonsense: the line asks what the seller
     * answered in paragraph 12, and a missing buyer signature has no bearing
     * on it. It clears when the form arrives and otherwise stays exactly as
     * written.
     */
    if (isContentCheck(text)) {
      out.push(derivedClear(text, arrived)
        ? { text, action: 'delete', reason: 'cleared by the form it checks' }
        : { text, action: 'keep' });
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

/**
 * The Doc's live text via the plain-text export. Needs no auth.
 *
 * NO LONGER USED BY THE PIPELINE, and deliberately not deleted: it is the
 * cheapest way to read a compliance Doc and is worth having for a one-off or a
 * check. But it MUST NOT feed the writer. The Docs API edits by character
 * position and this export's line breaks are not guaranteed to correspond to
 * the document's real offsets, so matching a line here and then deleting that
 * many characters from the document can take out part of the wrong paragraph.
 * lib/docs.js reads structurally for exactly that reason.
 */
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

module.exports._internal = { aliasFor, withoutLeadingFirm, norm };