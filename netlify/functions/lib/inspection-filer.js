// netlify/functions/lib/inspection-filer.js
//
// ============================================================================
// INSPECTION REPORTS FILE THEMSELVES into the deal's escrow folder.
// ============================================================================
// Megan, 2026-10-09: ~9 inspection-report emails a day reach Belle, whose whole
// job on them is to save the PDF into the deal's Drive folder. "Let's auto fill
// them into the google drive escrow folder, but not the sub-folder. I am
// interested to see how good it can work since agents can be messy."
//
// So this is built to be WATCHED: every attempt says what it did, or exactly
// why it did not (no address, two possible folders, nothing but a link, ...),
// in the router log. When it is not sure, it files NOTHING and the email stays
// with Belle as before. A wrong folder is worse than no folder.
//
// Folder layout (lib/watch.js): 00 MTC CLIENTS / <agent> / 00 ESCROW /
// <property address> / ... . Files go in <property address> itself.
//
// Off switch: INSPECTION_FILING=off in Netlify.
// ============================================================================

// What an inspection report is called. Specific enough to file on the PDF's
// name alone.
const INSPECTION_RX = /\binspect|termite|wood\s*destroying|\bwdo\b|\bpest\b|sewer|\blateral|\broof|chimney|\bmold|\bhvac|plumb|foundation|structural|geolog|\bsoils?\b|\bseptic|electrical|leak\s+detect|moisture|asbestos|radon|\bgas\s+line|arborist|\bspectora\b/i;
// Never these: contract forms, disclosures and escrow paperwork that ride along.
const EXCLUDE_RX = /\b(tds|spq|avid|esd|fhds|lpd|nhd|natural\s+hazard|zone\s+report|prelim|preliminary\s+title|escrow\s+instruction|amend|rpa|purchase\s+agreement|addendum|counter|request\s+for\s+repair|\brr\b|rrrr|contingency|\bcr\b|crb|biw|waiver|disclosure|questionnaire|closing\s+statement|commission|\bcda\b|w-?9|grant\s+deed|vp|verification\s+of\s+property|rfr|receipt\s+for\s+reports|hoa|cc&?rs|bylaws|budget|9a|city\s+report|offer|acceptance|pre-?approval|proof\s+of\s+funds|escrow|funds|deposit|emd|wire|statement|demand|payoff)\b/i;
// An email ABOUT inspections, by its subject.
// Not "report" alone: NHD, wildfire, 9A and city reports are escrow paperwork.
const SUBJECT_RX = /inspect|termite|\bwdo\b|sewer|\broof|chimney|\bmold|\bhvac|plumb|foundation|geolog|\bsoil|septic|wood\s*destroying/i;

const DIRECTIONALS = new Set(['n', 's', 'e', 'w', 'north', 'south', 'east', 'west', 'n.', 's.', 'e.', 'w.']);
const NOT_STREET = new Set(['and', 'the', 'of', 'to', 'for', 'unit', 'apt', 'suite', 'ste', 'page', 'pages', 'am', 'pm', 'days', 'day', 'sq', 'sqft', 'ft']);

/** Every "<number> <street word>" in the text, in order, de-duplicated. */
function addressCandidates(text) {
  const out = [];
  const seen = new Set();
  const re = /\b(\d{2,6})\s+((?:[NSEW]\.?\s+|North\s+|South\s+|East\s+|West\s+)?)([A-Za-z][A-Za-z'.-]{1,})/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const num = m[1];
    const word = m[3].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!word || DIRECTIONALS.has(word) || NOT_STREET.has(word)) continue;
    if (/^(19|20)\d\d$/.test(num) && /^(inspection|report|termite|at|to|in)$/.test(word)) continue;
    const key = `${num}|${word}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ num, word });
  }
  return out;
}

const token = (hay, t) => new RegExp(`\\b${String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(hay);

/**
 * Which PDFs to file, and whether this email is about inspections at all.
 * Returns { pdfs, why } ; pdfs empty means "not ours".
 */
function pickFiles(message, decision) {
  const h = (message && message.headers) || {};
  const pdfs = ((message && message.attachments) || [])
    .filter((a) => a && a.attachmentId && (/\.pdf$/i.test(a.filename || '') || /pdf/i.test(a.mimeType || '')));
  if (!pdfs.length) return { pdfs: [], why: 'no PDF attached' };
  const reason = String((decision && decision.classifier && decision.classifier.reason) || '');
  const emailIsInspection = SUBJECT_RX.test(h.subject || '')
    || /inspection\s+report|termite|sewer|roof\s+(report|inspection)|inspection\s+reports?\s+(attached|linked)|route(s)?\s+to\s+belle[^.]*inspection/i.test(reason);
  const keep = pdfs.filter((a) => {
    const name = String(a.filename || '');
    if (EXCLUDE_RX.test(name)) return false;
    // A PDF named like a report files on its own name. Anything else (an
    // invoice, "Scan_0042.pdf", the estimate) files only when the EMAIL is
    // about inspections, so "Receipt for Funds Received in Escrow" never does.
    return INSPECTION_RX.test(name) || emailIsInspection;
  });
  if (!keep.length) return { pdfs: [], why: 'no inspection-type PDF' };
  // A PDF whose name says inspection is enough; otherwise the email itself must.
  if (!emailIsInspection && !keep.some((a) => INSPECTION_RX.test(a.filename || ''))) return { pdfs: [], why: 'not an inspection email' };
  return { pdfs: keep, why: '' };
}

/**
 * The deal's escrow (property) folder. Tries the subject, then the PDF names,
 * then the newest message text. A folder counts only if its NAME carries the
 * number and the street word, and it sits under a folder named like "ESCROW".
 * Exactly one, or none: two plausible folders means a human decides.
 */
async function findPropertyFolder(message, pdfs, deps) {
  const drive = deps.drive;
  const h = (message && message.headers) || {};
  const sources = [
    ['subject', h.subject || ''],
    ['attachment name', pdfs.map((p) => p.filename).join(' ')],
    ['email text', String((message && message.newestText) || '').slice(0, 3000)],
  ];
  const parentNames = new Map();
  for (const [where, text] of sources) {
    const found = new Map();
    for (const c of addressCandidates(text).slice(0, 6)) {
      // eslint-disable-next-line no-await-in-loop
      const folders = await drive.findFoldersNameContains(c.num);
      for (const f of folders) {
        if (!token(f.name, c.num) || !token(f.name.replace(/[^A-Za-z0-9\s]/g, ' '), c.word)) continue;
        const parent = (f.parents || [])[0];
        if (!parent) continue;
        if (!parentNames.has(parent)) {
          // eslint-disable-next-line no-await-in-loop
          const meta = await drive.getFileMeta(parent, 'id,name').catch(() => ({ name: '' }));
          parentNames.set(parent, String(meta.name || ''));
        }
        if (!/escrow/i.test(parentNames.get(parent))) continue;
        found.set(f.id, f);
      }
    }
    if (found.size === 1) return { folder: [...found.values()][0], where };
    if (found.size > 1) return { folder: null, why: `${found.size} possible deal folders (${[...found.values()].map((f) => f.name).join(' / ')}) from the ${where}` };
  }
  return { folder: null, why: 'no address that matches a deal folder' };
}

/** Drive file names: no slashes, no fi/fl ligatures (they break Drive search). */
function cleanName(name) {
  return String(name || 'report.pdf').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/[\\/:]/g, '-').trim();
}

/**
 * File this email's inspection PDFs. Never throws; returns a summary for the
 * log: { filed: [names], skipped: [names already there], folder, why }.
 */
async function fileInspectionReports(message, decision, deps = {}) {
  if (String(process.env.INSPECTION_FILING || '').toLowerCase() === 'off') return null;
  const d = { drive: deps.drive || require('./drive'), gmail: deps.gmail || require('./gmail') };
  try {
    const { pdfs, why } = pickFiles(message, decision);
    if (!pdfs.length) return why === 'no PDF attached' && /inspection/i.test(String(((decision || {}).classifier || {}).reason || ''))
      ? { filed: [], why: 'inspection email with no PDF attached (a link?), not filed' } : null;
    const { folder, why: noFolder } = await findPropertyFolder(message, pdfs, d);
    if (!folder) return { filed: [], why: `not filed: ${noFolder}` };
    const existing = new Set((await d.drive.listChildren(folder.id, { excludeFolders: true })).map((f) => f.name));
    const filed = [];
    const skipped = [];
    for (const p of pdfs) {
      const name = cleanName(p.filename);
      if (existing.has(name)) { skipped.push(name); continue; }
      // eslint-disable-next-line no-await-in-loop
      const bytes = await d.gmail.getAttachment(message.id, p.attachmentId);
      // eslint-disable-next-line no-await-in-loop
      await d.drive.uploadMultipart({ name, parents: [folder.id], mimeType: 'application/pdf', bytes });
      existing.add(name);
      filed.push(name);
    }
    return { filed, skipped, folder: folder.name, why: '' };
  } catch (e) {
    return { filed: [], why: `not filed: error ${e.message}` };
  }
}

/** One line for the router log. */
function summary(r) {
  if (!r) return '';
  if (r.filed && r.filed.length) {
    return `INSPECTION FILED to "${r.folder}": ${r.filed.join(', ')}${r.skipped && r.skipped.length ? ` (already there: ${r.skipped.join(', ')})` : ''}`;
  }
  if (r.skipped && r.skipped.length) return `INSPECTION already in "${r.folder}": ${r.skipped.join(', ')}`;
  return `INSPECTION ${r.why}`;
}

module.exports = { fileInspectionReports, summary, _internal: { pickFiles, addressCandidates, findPropertyFolder, cleanName } };
