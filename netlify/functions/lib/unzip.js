// ----------------------------------------------------------------------------
// Shared ZIP support.
//
// Zapier's "Upload File" step bundles all of an email's attachments into ONE
// .zip on Drive, so a single document URL can actually be 22 PDFs. Worse, agents
// routinely attach their OWN zip of disclosures to that email, so what arrives is
// a zip inside a zip:
//
//   attachments.zip
//     ├── image522632.png              <- Outlook signature art
//     ├── image983110.png
//     └── 1535_Carla_Rdg_-_Disclosures.zip   <- every disclosure lives in here
//
// The original single-pass readers kept only top-level entries that were PDFs, so
// a nested zip was dropped into the same bucket as the signature PNGs and the run
// died with "No documents could be loaded". collectPdfs() walks the tree instead.
//
// Pure Node built-ins (zlib) — no extra dependency.
// ----------------------------------------------------------------------------
const zlib = require('zlib');

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const PDF_MAGIC = Buffer.from('%PDF');

// Recursion guards. A zip that contains itself is a real thing, and so is a
// malicious zip bomb. These stop either from running the function out of memory.
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_TOTAL_BYTES = 400 * 1024 * 1024;

function looksZip(buf, name, contentType) {
  if (buf && buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) return true;
  // Magic bytes win over a misleading name/content-type: a single PDF sometimes
  // arrives named "attachments.zip" served as application/octet-stream. Real PDF
  // bytes are never a zip, so don't route them into the unzip path.
  if (buf && buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC)) return false;
  if (/\.zip$/i.test(name || '')) return true;
  if (/zip/i.test(contentType || '')) return true;
  return false;
}

// Name-tolerant check, for callers that may not hold the bytes yet.
function looksPdf(buf, name) {
  if (buf && buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC)) return true;
  return /\.pdf$/i.test(name || '');
}

// Bytes-only check. Inside a zip we ALWAYS have the bytes, so the filename gets
// no vote: a macOS AppleDouble sidecar is literally named "._Real_Report.pdf"
// and would sail through the name fallback, then blow up the Anthropic call with
// "The PDF specified was not valid" and take the whole identify batch with it.
//
// The %PDF header is allowed to sit a little way into the file (some writers emit
// a BOM or stray bytes first), so scan the head rather than demanding offset 0.
function isPdfBytes(buf) {
  if (!buf || buf.length < 4) return false;
  return buf.subarray(0, Math.min(buf.length, 1024)).indexOf(PDF_MAGIC) !== -1;
}

// macOS writes a parallel "._Name.ext" resource-fork file for every real file when
// it zips a folder, plus a __MACOSX/ directory to hold them. They carry the same
// extension as the file they shadow, so they double the apparent document count
// and every one of them is unreadable garbage to a PDF parser. unzipEntries()
// reduces names to a basename, so the "._" test also catches "__MACOSX/._x.pdf".
function isMacMetadata(name) {
  const n = name || '';
  return n.startsWith('._') || n === '.DS_Store' || /(^|\/)__MACOSX(\/|$)/.test(n);
}

// Minimal ZIP reader: walk the central directory and inflate each entry. Handles
// stored (method 0) and deflate (method 8) — i.e. every normal zip. Skips
// directories, zip64-only entries, and anything it can't inflate.
//
// `name` is deliberately reduced to the basename. Downstream blocklists match on
// filename patterns, and a folder path (or a parent zip name) leaking into that
// string would let one badly named container block everything inside it.
function unzipEntries(buf, opts) {
  const o = opts || {};
  // Called with the CENTRAL-DIRECTORY metadata, before any inflate. Return false
  // to reject an entry for free. This is the whole memory story: without it every
  // byte of a 105MB Dropbox folder zip is decompressed and only then discarded
  // for being a jpeg, a receipt, or too large.
  const shouldInflate = typeof o.shouldInflate === 'function' ? o.shouldInflate : null;
  const onSkip = typeof o.onSkip === 'function' ? o.onSkip : null;
  const out = [];
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < cdCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    // Uncompressed size, read straight from the index. This is what an entry will
    // COST in memory, known before we spend it.
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry
    if (compSize === 0xffffffff || localOffset === 0xffffffff) continue; // zip64, skip

    // Reject BEFORE inflating. `name` here is still the FULL path inside the zip
    // ("Buyer Reports/whatever.pdf"), which the basename passed downstream loses,
    // so this is also the only place a caller can reason about folders.
    if (shouldInflate && !shouldInflate({ path: name, uncompSize, compSize, method })) {
      if (onSkip) onSkip(name, uncompSize);
      continue;
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data;
    try {
      if (method === 0) data = comp;
      else if (method === 8) data = zlib.inflateRawSync(comp);
      else continue;
    } catch (e) { continue; }
    out.push({ name: name.split('/').pop(), data });
  }
  return out;
}

// Is this a readable zip, without inflating a single byte? Just locates the
// end-of-central-directory record. The intake used to answer this by calling
// unzipEntries() and throwing the result away, which decompressed the whole
// archive purely to validate it — then collectPdfs() decompressed it AGAIN.
// On a 105MB folder zip that is ~220MB of inflated data nobody ever reads.
function hasCentralDirectory(buf) {
  if (!buf || buf.length < 22) return false;
  const minStart = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// Recursively expand a zip and collect every PDF inside it, at any nesting depth.
//
//   collectPdfs(buf, 'attachments.zip', { maxDocBytes, isBlocked })
//     -> { kept: [{ name, path, data }], skipped: [string], truncated: bool }
//
// `name` is the bare filename (what blocklists and downstream naming should use).
// `path` is the full container trail for logging, e.g.
//   "attachments.zip/1535_Carla_Rdg_-_Disclosures.zip/Carla Rdg TDS.pdf"
//
// opts:
//   maxDocBytes    per-PDF ceiling; larger entries are skipped (default: no limit)
//   isBlocked      fn(name) -> bool, tested against the BASENAME only (optional)
//   maxDepth       nested-zip depth cap (default 4)
//   maxEntries     total entries examined across all levels (default 500)
//   maxTotalBytes  cumulative uncompressed bytes kept (default 400MB)
// ----------------------------------------------------------------------------
// Folders and filenames that are NOT seller disclosures. Not an exclusion — a
// DEPRIORITISATION. A Dropbox folder for one deal routinely holds Buyer Reports,
// Receipts, Prelim/Permits and photo sets alongside the disclosures, and those
// are where the hundred megabytes live. When a byte budget has to bite, it must
// bite here and not on the TDS. Anything unrecognised keeps normal priority, so
// a folder named something we have never seen is never quietly demoted.
const LOW_PRIORITY_PATH = /buyer\s*report|receipt|invoice|prelim|permit|\btitle\b|photo|floor\s*plan|\bphotos?\b|inspection\s*report/i;

// Extensions worth inflating at all. A .jpg/.docx/.xlsx would be inflated in
// full and then dropped by the isPdfBytes check, which is pure waste.
const INFLATABLE_EXT = /\.(?:pdf|zip)$/i;

// ----------------------------------------------------------------------------
// NON-DISCLOSURE FOLDERS, for whole-folder share links (opt-in via
// excludeNonDisclosureFolders; OFF by default so other callers are untouched).
//
// A Dropbox folder for one deal is organised for the deal, not for a disclosure
// audit. 1428 El Paso Dr shared 105MB across Seller Disclosures, Seller Reports,
// Buyer Reports, Receipts, "Provident Title Company - Prelim and Permits",
// NHD + 9A and Tesla Solar Lease. After the name blocklist that still left 42
// PDFs and 55.8MB, about ten times a normal delivery, which is a cost and
// 15-minute-timeout problem rather than a memory one.
//
// Matched against DIRECTORY SEGMENTS ONLY, never the filename, so a disclosure
// that merely says "permit" in its name is unaffected.
// ----------------------------------------------------------------------------
const EXCLUDED_FOLDER_PATTERNS = [
  /\bbuyer\s*reports?\b/i,
  /\breceipts?\b/i,
  /\bprelim/i,
  /\bpermits?\b/i,
  /\btitle\s*(?:company|co\.?|report)\b/i,
];

// A FOLDER OF A PREVIOUS SALE IS A DIFFERENT TRANSACTION.
//
// 2026-09-17: a listing side shared the current disclosures as attachments plus a
// Dropbox folder holding the property's prior sale. That sale was an exempt trust
// sale, so its package carried an ESD, which put a regular sale on the exempt
// path. The signature-date partition in disclosure-intake is the guarantee against
// that; this is the cheap first pass, filtering a whole folder before a single
// page is inflated or costs a model token.
//
// SEPARATE FROM EXCLUDED_FOLDER_PATTERNS because RESCUE_NAME must NOT override
// these. That rescue exists so a seller's explanation sheet filed in the wrong
// folder is never lost, and it matches any filename containing "disclosure" - which
// is every file in a folder named "Previous Sale Disclosures", i.e. exactly the
// case being excluded. A prior sale's TDS is not a document of this deal that
// happens to be misfiled; it belongs to another transaction, and nothing in it is
// wanted.
//
// Deliberately narrow, matched on directory segments only.
const PRIOR_TRANSACTION_FOLDER_PATTERNS = [
  /\b(?:previous|prior|past|old|former)\s+(?:sale|transaction|escrow|disclosures?|docs?|file)\b/i,
  /\b(?:previous|prior|past)\s+owner'?s?\b/i,
  /\barchived?\b/i,
  /\bhistorical?\b/i,
];

// A YEAR-LABELLED ARCHIVE FOLDER ("2019", "2021 Sale"), which agents do use.
//
// Two ways to get this wrong, both caught by checks/vintage-partition.js:
//
//   A CALIFORNIA STREET NUMBER LOOKS LIKE A YEAR. "2019 Maple Ave" is a property
//   folder, and a loose year pattern excluded the entire deal's disclosures. So the
//   segment must be the year ALONE, or the year plus a transaction word - never a
//   year followed by anything else.
//
//   THE CURRENT SALE IS ALSO IN A YEAR. A folder named "2026" in 2026 is this
//   deal, not an archive, so the cutoff is computed from today rather than hard
//   coded: only a year at least two behind the current one reads as prior. Last
//   year stays in bounds because a listing that opened in December and closes in
//   January is one transaction.
const PRIOR_YEAR_SEGMENT = /^((?:19|20)\d{2})(?:\s*[-_]?\s*(?:sale|escrow|transaction|disclosures?|docs?|file|listing|closing))?$/i;

function isPriorYearSegment(dir) {
  const m = String(dir).trim().match(PRIOR_YEAR_SEGMENT);
  if (!m) return false;
  return Number(m[1]) <= new Date().getFullYear() - 2;
}

// A seller's explanation sheet is routinely filed in whatever folder the agent
// had open — 1428 El Paso Dr has "Letter from Buyer #1 + Seller Explanation and
// Receipts.pdf". Losing one of those is the exact failure this pipeline spent a
// morning fixing, so a name like this overrides the folder every time.
const RESCUE_NAME = /explanation|addendum|disclosure|\bspq\b|\btds\b|\bavid\b/i;

function inExcludedFolder(path) {
  const parts = String(path).split('/');
  parts.pop();                                   // directories only, not the file
  return parts.some((dir) => EXCLUDED_FOLDER_PATTERNS.some((re) => re.test(dir)));
}

// A prior-sale folder, which RESCUE_NAME must not pull anything back out of.
function inPriorTransactionFolder(path) {
  const parts = String(path).split('/');
  parts.pop();
  return parts.some((dir) => isPriorYearSegment(dir)
    || PRIOR_TRANSACTION_FOLDER_PATTERNS.some((re) => re.test(dir)));
}

function collectPdfs(buf, rootName, opts) {
  const o = opts || {};
  const maxDepth = o.maxDepth != null ? o.maxDepth : DEFAULT_MAX_DEPTH;
  const maxEntries = o.maxEntries != null ? o.maxEntries : DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = o.maxTotalBytes != null ? o.maxTotalBytes : DEFAULT_MAX_TOTAL_BYTES;
  const maxDocBytes = o.maxDocBytes != null ? o.maxDocBytes : Infinity;
  const isBlocked = typeof o.isBlocked === 'function' ? o.isBlocked : null;
  const excludeFolders = o.excludeNonDisclosureFolders === true;

  const kept = [];
  const skipped = [];
  let truncated = false;
  let examined = 0;
  let totalBytes = 0;
  let budgetHit = false;
  // Bytes we have COMMITTED to inflating. Distinct from totalBytes, which counts
  // what was finally kept and is only known after the walks. The budget has to
  // accumulate DURING the walk or it sees zero every time and only rejects
  // entries individually larger than the whole budget — which let 26MB through a
  // an 18MB budget in testing.
  let plannedBytes = 0;
  const thrownBy = [];

  // Evaluated from the zip index, before any inflate. Every one of these was
  // previously checked AFTER decompressing the entry.
  //
  // Returns '' to accept, or a reason string to reject.
  // A caller's isBlocked predicate throwing must not take the delivery with it.
  // Found the hard way: an isBlocked that threw propagated out of unzipEntries,
  // was caught by the "unreadable zip" handler below, and reported ZERO documents
  // from a perfectly good 105MB archive. Silent total loss from a one-line caller
  // bug is exactly the failure mode this file keeps being bitten by, so the
  // predicate is treated as untrusted: on a throw, keep the entry and say so.
  const safeBlocked = (base) => {
    if (!isBlocked) return false;
    try { return isBlocked(base); }
    catch (e) { thrownBy.push(`${base}: ${e.message}`); return false; }
  };

  const rejectReason = ({ path, uncompSize }) => {
    const base = String(path).split('/').pop();
    if (isMacMetadata(path) || isMacMetadata(base)) return 'macOS metadata';
    if (!INFLATABLE_EXT.test(base)) return 'not a pdf or zip';
    if (uncompSize > maxDocBytes && !/\.zip$/i.test(base)) return `too large (${uncompSize}B)`;
    if (safeBlocked(base)) return 'blocked';
    // Checked BEFORE the rescue, and not subject to it: see PRIOR_TRANSACTION_FOLDER_PATTERNS.
    if (excludeFolders && inPriorTransactionFolder(path)) return 'prior-sale folder';
    if (excludeFolders && inExcludedFolder(path) && !RESCUE_NAME.test(base)) return 'non-disclosure folder';
    // Hard memory bound: refuse the entry rather than inflate past the budget.
    if (plannedBytes + uncompSize > maxTotalBytes) { budgetHit = true; return 'byte budget reached'; }
    // Accepted, so commit the cost now. A .pdf whose bytes turn out not to be a
    // PDF is still counted, which over-counts slightly — the safe direction.
    plannedBytes += uncompSize;
    return '';
  };

  // Work queue of zips still to open. Start with the outer one.
  const queue = [{ buf, path: rootName || 'archive.zip', depth: 0 }];

  while (queue.length) {
    const job = queue.shift();
    // TWO INDEX WALKS, likely-disclosures first.
    //
    // Sorting AFTER unzipEntries would be useless: the byte budget is spent
    // inside it, in archive order, so by the time a sort could run the budget has
    // already gone to whatever happened to come first — Buyer Reports, on this
    // Dropbox layout. Walking the index twice is free (the index is metadata; no
    // inflating), and the two passes are mutually exclusive on tier, so no entry
    // is ever inflated twice.
    const preSkipped = [];
    const walk = (wantLowPriority) => unzipEntries(job.buf, {
      shouldInflate: (meta) => {
        const isLow = LOW_PRIORITY_PATH.test(meta.path);
        if (isLow !== wantLowPriority) return false;   // the other pass's job
        const why = rejectReason(meta);
        if (why) { preSkipped.push(`${job.path}/${meta.path} [${why}, not inflated]`); return false; }
        return true;
      },
    });

    let entries;
    try {
      entries = walk(false).concat(walk(true));
    } catch (e) {
      skipped.push(`${job.path} [unreadable zip: ${e.message}]`);
      continue;
    }
    for (const sk of preSkipped) skipped.push(sk);

    for (const e of entries) {
      if (examined >= maxEntries) {
        truncated = true;
        skipped.push(`${job.path}/… [entry cap ${maxEntries} reached]`);
        break;
      }
      examined++;
      const path = `${job.path}/${e.name}`;

      // Nested zip: queue it for expansion instead of discarding it. This is the
      // whole point of the module — the old readers hit this branch and dropped it.
      if (looksZip(e.data, e.name, '')) {
        if (job.depth + 1 > maxDepth) {
          truncated = true;
          skipped.push(`${path} [nested deeper than ${maxDepth}]`);
          continue;
        }
        queue.push({ buf: e.data, path, depth: job.depth + 1 });
        continue;
      }

      if (isMacMetadata(e.name)) { skipped.push(`${path} [macOS metadata]`); continue; }
      // Bytes, not filename — see isPdfBytes.
      if (!isPdfBytes(e.data)) { skipped.push(`${path} [not pdf]`); continue; }
      // safeBlocked, not isBlocked: this is the post-inflate belt to the
      // pre-inflate check, and it must be just as untrusted.
      if (safeBlocked(e.name)) { skipped.push(`${path} [blocked]`); continue; }
      if (e.data.length > maxDocBytes) { skipped.push(`${path} [too large]`); continue; }
      if (totalBytes + e.data.length > maxTotalBytes) {
        truncated = true;
        skipped.push(`${path} [total size cap reached]`);
        continue;
      }

      totalBytes += e.data.length;
      kept.push({ name: e.name, path, data: e.data });
    }
  }

  if (budgetHit) truncated = true;
  if (thrownBy.length) {
    skipped.push(`[isBlocked threw on ${thrownBy.length} name(s), entries KEPT rather than lost: ${thrownBy.slice(0, 3).join('; ')}]`);
  }
  return { kept, skipped, truncated };
}

// ----------------------------------------------------------------------------
// One-line, log-safe summary of a collectPdfs() result.
//
// The naive version printed every kept path in full. With a nested zip that is
// 38 absolute paths on one line and the interesting part (what got dropped and
// why) is buried past the fold. This keeps the kept documents as bare basenames,
// names the containers once, and groups the skips by reason with counts.
// ----------------------------------------------------------------------------
function summarizeCollect(result, rootName) {
  const { kept, skipped, truncated } = result;

  // Every distinct container a kept file came out of, minus the root itself.
  const containers = [];
  for (const k of kept) {
    const dir = k.path.slice(0, k.path.length - k.name.length - 1);
    if (dir && dir !== rootName && !containers.includes(dir)) containers.push(dir);
  }

  // Group "path [reason]" into "reason: n (examples)".
  const byReason = new Map();
  for (const s of skipped) {
    const m = s.match(/\[([^\]]+)\]\s*$/);
    const reason = m ? m[1] : 'skipped';
    const name = s.slice(0, m ? s.length - m[0].length : s.length).trim().split('/').pop();
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(name);
  }
  const skipParts = [];
  for (const [reason, names] of byReason) {
    const shown = names.slice(0, 4).join(', ');
    const more = names.length > 4 ? `, +${names.length - 4} more` : '';
    skipParts.push(`${names.length} ${reason} (${shown}${more})`);
  }

  return `kept ${kept.length} PDF(s), skipped ${skipped.length}`
    + (containers.length ? ` | expanded: ${containers.join(', ')}` : '')
    + (kept.length ? ` | kept: ${kept.map(k => k.name).join(', ')}` : '')
    + (skipParts.length ? ` | skipped: ${skipParts.join('; ')}` : '')
    + (truncated ? ' | TRUNCATED — hit a recursion/size guard, some documents were not read' : '');
}

module.exports = {
  hasCentralDirectory,
  inExcludedFolder,
  inPriorTransactionFolder,
  ZIP_MAGIC,
  PDF_MAGIC,
  looksZip,
  looksPdf,
  isPdfBytes,
  isMacMetadata,
  unzipEntries,
  collectPdfs,
  summarizeCollect,
};
