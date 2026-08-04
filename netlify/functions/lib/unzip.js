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

function looksPdf(buf, name) {
  if (buf && buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC)) return true;
  return /\.pdf$/i.test(name || '');
}

// Minimal ZIP reader: walk the central directory and inflate each entry. Handles
// stored (method 0) and deflate (method 8) — i.e. every normal zip. Skips
// directories, zip64-only entries, and anything it can't inflate.
//
// `name` is deliberately reduced to the basename. Downstream blocklists match on
// filename patterns, and a folder path (or a parent zip name) leaking into that
// string would let one badly named container block everything inside it.
function unzipEntries(buf) {
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
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry
    if (compSize === 0xffffffff || localOffset === 0xffffffff) continue; // zip64, skip
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
function collectPdfs(buf, rootName, opts) {
  const o = opts || {};
  const maxDepth = o.maxDepth != null ? o.maxDepth : DEFAULT_MAX_DEPTH;
  const maxEntries = o.maxEntries != null ? o.maxEntries : DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = o.maxTotalBytes != null ? o.maxTotalBytes : DEFAULT_MAX_TOTAL_BYTES;
  const maxDocBytes = o.maxDocBytes != null ? o.maxDocBytes : Infinity;
  const isBlocked = typeof o.isBlocked === 'function' ? o.isBlocked : null;

  const kept = [];
  const skipped = [];
  let truncated = false;
  let examined = 0;
  let totalBytes = 0;

  // Work queue of zips still to open. Start with the outer one.
  const queue = [{ buf, path: rootName || 'archive.zip', depth: 0 }];

  while (queue.length) {
    const job = queue.shift();
    let entries;
    try {
      entries = unzipEntries(job.buf);
    } catch (e) {
      skipped.push(`${job.path} [unreadable zip: ${e.message}]`);
      continue;
    }

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

      if (!looksPdf(e.data, e.name)) { skipped.push(`${path} [not pdf]`); continue; }
      if (isBlocked && isBlocked(e.name)) { skipped.push(`${path} [blocked]`); continue; }
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

  return { kept, skipped, truncated };
}

module.exports = {
  ZIP_MAGIC,
  PDF_MAGIC,
  looksZip,
  looksPdf,
  unzipEntries,
  collectPdfs,
};
