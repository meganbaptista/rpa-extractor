// netlify/functions/lib/package-assemble.js
//
// THE BUYER PACKAGE ASSEMBLER (stage 2 of the automatic buyer package). The
// planner (lib/package-plan.js) decides where every page goes; this builds it:
//
//   1. findDuplicates / findWrongProperty: the two facts the planner cannot
//      know from form titles, found by comparing page TEXT. 5733 E Stillwater
//      #2 (2026-10-23): four separate attachments repeated pages already inside
//      the combined PDF, and the NHD report AND the NHD statement inside the
//      combined PDF were for 5722, not 5733.
//   2. buildPdf: the package and each separate attachment, pages copied as they
//      are. A damaged file pdf-lib cannot copy is rendered as images instead
//      (1222 N Kings Rd #8). NEVER compressed: pypdf compression blanked pages
//      on 2647 E Wilson and REMOVED SIGNATURES on 6051 Scenic.
//   3. checks: every output page rendered; a near-blank page whose source page
//      had words is a problem. Size: Gmail takes 25MB after encoding (raw x
//      1.37), so the package plus attachments aim under 17MB raw. Over that,
//      the heaviest single pages are re-rendered as images (Scenic's AC was
//      10.8MB on its own); if still over, it is a warning for Megan, and
//      nothing is dropped.
//   4. fileToDealFolder: everything at the TOP of the deal folder (never a
//      subfolder: those mean "uploaded to the broker platform"). Megan's own
//      "Disclosures - <address>.pdf" is never overwritten: once she has a
//      package, hers is the source of truth. Used deal-folder sources go to
//      TRASH FOLDER only when asked (live).
//
// No Drive/Gmail/Blobs calls are made here except in fileToDealFolder, which
// takes the drive client. Everything else takes `deps`:
//   getBytes(src) -> Buffer      src = { type: 'file', n } | { type: 'extra', key } | { type: 'drive', id, name }
//   pageTexts(buf) -> [{ num, text }]
//   render(buf, pageNumbers, scale) -> [{ pageNumber, base64 }]   (png)
//   pageCount(buf) -> number
//   ink(base64png) -> 0..1 share of non-white pixels (optional; no blank check without it)

const { PDFDocument } = require('pdf-lib');

const GMAIL_RAW_TARGET = 17 * 1024 * 1024;
const RENDER_SCALE = 2;          // damaged pages and heavy-page re-renders
const CHECK_SCALE = 0.35;        // blank check thumbnails
const BLANK_INK = 0.002;         // below this share of dark pixels = blank
const MIN_WORDS = 25;            // a page needs this many words to be compared

// ---------------------------------------------------------------------------
// Text facts.

const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 2);

/** Word 3-grams of a page: robust to line breaks and small OCR drift. */
function shingles(text) {
  const w = words(text);
  const s = new Set();
  for (let i = 0; i + 2 < w.length; i++) s.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return { set: s, words: w.length };
}

function overlap(a, b) {
  if (!a.set.size || !b.set.size) return 0;
  let hit = 0;
  for (const x of a.set) if (b.set.has(x)) hit++;
  return hit / Math.min(a.set.size, b.set.size);
}

const span = (pages) => {
  const p = [...new Set(pages)].sort((a, b) => a - b);
  const runs = [];
  for (const x of p) {
    const r = runs[runs.length - 1];
    if (r && x === r[1] + 1) r[1] = x; else runs.push([x, x]);
  }
  const txt = runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
  return p.length === 1 ? `page ${txt}` : `pages ${txt}`;
};

/**
 * Whole files (or extras) whose readable pages ALL appear inside another,
 * bigger delivered file. Image-only files (no words) are never called
 * duplicates: nothing to compare, so they stay in.
 *   sources: [{ n | key, name, texts: [{ num, text }] }]
 * Returns planner flags: [{ n | key, of: '<name> pages a-b' }].
 */
const rank = (s) => (s.n != null ? 0 : String(s.key).startsWith('d:') ? 2 : 1);
function findDuplicates(sources, { threshold = 0.8 } = {}) {
  const sh = sources.map((s) => ({ ...s, pages: (s.texts || []).map((t) => ({ num: t.num, ...shingles(t.text) })) }));
  const out = [];
  for (const a of sh) {
    const readable = a.pages.filter((p) => p.words >= MIN_WORDS);
    if (!readable.length) continue;
    for (const b of sh) {
      // The copy kept is the bigger file; at equal size, a delivered file beats
      // an extra beats a deal-folder file, then the earlier delivered file wins.
      if (b === a || b.pages.length < a.pages.length) continue;
      if (b.pages.length === a.pages.length && !(rank(b) < rank(a) || (rank(b) === rank(a) && b.n != null && a.n != null && b.n < a.n))) continue;
      const hits = [];
      for (const p of readable) {
        const m = b.pages.find((q) => q.words >= MIN_WORDS && overlap(p, q) >= threshold);
        if (!m) break;
        hits.push(m.num);
      }
      if (hits.length === readable.length) {
        out.push({ ...(a.n != null ? { n: a.n } : { key: a.key, name: a.name }), of: `${b.name} ${span(hits)}`, ofN: b.n, pages: [...new Set(hits)].sort((x, y) => x - y) });
        break;
      }
    }
  }
  return out;
}

/**
 * Pages that name a DIFFERENT house number on the deal's street (Stillwater:
 * "5722 E Stillwater" on a 5733 deal). Only reports and statements that name
 * the property are judged; a page with the right number anywhere on it is
 * fine (a neighbour mentioned in passing is not a wrong report).
 * Returns planner flags: [{ n | key, pages, why }] (pages = every page of the
 * file when the first readable pages are all wrong = the whole file).
 */
function findWrongProperty(sources, address) {
  const m = String(address || '').match(/^\s*(\d+)\s+(?:[NSEW]\.?\s+)?([A-Za-z][A-Za-z']+)/);
  if (!m) return [];
  const num = m[1]; const street = m[2].toLowerCase();
  const rx = new RegExp(`\\b(\\d{2,6})\\s+(?:[nsew]\\.?\\s+)?${street}\\b`, 'gi');
  const out = [];
  for (const s of sources) {
    const bad = [];
    let good = 0;
    for (const t of s.texts || []) {
      const nums = [...String(t.text || '').matchAll(rx)].map((x) => x[1]);
      if (!nums.length) continue;
      if (nums.includes(num)) { good++; continue; }
      bad.push({ num: t.num, other: nums[0] });
    }
    if (!bad.length) continue;
    const whole = !good;
    const other = bad[0].other;
    out.push({
      ...(s.n != null ? { n: s.n } : { key: s.key }),
      ...(whole ? {} : { pages: bad.map((b) => b.num) }),
      why: `it is for ${other} ${m[2]}, not ${num} ${m[2]}`,
    });
  }
  return out;
}

/**
 * Pages that are only signature lines: under 20 words of text, all signature
 * words, AND near-empty when rendered. The look matters: Stillwater p100 has
 * only "X____ BUYER" tags in its text layer, but it is the scanned first page
 * of the HOA disclosure statement (14% ink) and must not join the termite
 * report. With no renderer nothing is moved. Returns [{ n, page }].
 *   deps: { getBytes, render, ink } (ink defaults to defaultInk())
 */
const TAIL_MAX_INK = 0.04;
async function findTails(sources, deps) {
  if (!deps || !deps.render) return [];
  const ink = deps.ink || defaultInk();
  if (!ink) return [];
  const cands = findTailCandidates(sources);
  const out = [];
  for (const c of cands) {
    const [im] = await deps.render(await deps.getBytes({ type: 'file', n: c.n }), [c.page], 0.35);
    if (im && (await ink(im.base64)) < TAIL_MAX_INK) out.push(c);
  }
  return out;
}
function findTailCandidates(sources) {
  const SIG = /^(x|buyer|buyers|seller|sellers|date|initials|signature|by|and|the)$/;
  const out = [];
  for (const s of sources) {
    if (s.n == null) continue;
    for (const t of s.texts || []) {
      const w = String(t.text || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
      if (w.length >= 2 && w.length < 20 && w.every((x) => SIG.test(x)) && w.some((x) => /buyer|seller/.test(x))) out.push({ n: s.n, page: t.num });
    }
  }
  return out;
}

/**
 * Purchase-agreement documents the contract audit is still waiting on, found
 * in the delivery. items = [{ code: 'FHDA' }, { code: 'ABA', brokerage: 'Side', name: 'FX - SIDE ABA' }]
 * (from the deal's compliance list). An ABA counts only when its first page
 * names OUR brokerage (the listing brokerage's ABA is a disclosure: Seven
 * Gables, Stillwater p88). Returns planner flags: [{ n, pages, name }].
 */
const FX_TITLES = {
  FHDA: /fair housing and discrimination/i,
  WFA: /wire fraud/i,
  MCA: /market conditions advisory/i,
  ABA: /affiliated business arrangement/i,
  PRBS: /possible representation of more than one buyer/i,
  BIA: /buyer.s investigation advisory/i,
};
function findContractDocs(files, sources, items) {
  const out = [];
  const taken = new Set();
  for (const it of items || []) {
    const code = String(it.code || '').toUpperCase();
    const rx = FX_TITLES[code];
    for (const f of files) {
      const texts = (sources.find((s) => s.n === f.n) || {}).texts || [];
      for (const form of f.forms || []) {
        const hit = String(form.code || '').toUpperCase() === code || (rx && rx.test(form.name || ''));
        if (!hit || taken.has(`${f.n}:${form.pages[0]}`)) continue;
        if (it.brokerage) {
          const first = (texts.find((t) => t.num === form.pages[0]) || {}).text || '';
          if (!new RegExp(`\\b${String(it.brokerage).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(first.slice(0, 600))) continue;
        }
        taken.add(`${f.n}:${form.pages[0]}`);
        out.push({ n: f.n, pages: [...form.pages], name: it.name || `FX - ${code}` });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building.

const srcKey = (src) => (src.type === 'file' ? `f${src.n}` : src.type === 'extra' ? `x${src.key}` : `d${src.id}`);

/**
 * parts: [{ src, pages|null (1-based; null = whole file), label }] -> one PDF.
 * Returns { bytes, pages, ranges: [[first, last]] per part (1-based), rebuilt: [labels] }.
 */
async function buildPdf(parts, deps) {
  const out = await PDFDocument.create();
  const cache = new Map();
  const ranges = [];
  const rebuilt = [];
  const sources = [];
  for (const part of parts) {
    const k = srcKey(part.src);
    if (!cache.has(k)) {
      const buf = await deps.getBytes(part.src);
      let doc = null;
      // A file can LOAD and still have a broken page tree, so that even counting
      // its pages throws "Expected instance of PDFDict" (20701 Schoolcraft,
      // 2026-10-23): treat it as damaged here, so it is rebuilt from images.
      try { doc = await PDFDocument.load(buf, { ignoreEncryption: true }); doc.getPageCount(); } catch { doc = null; }
      cache.set(k, { buf, doc });
    }
    const { buf, doc } = cache.get(k);
    const total = doc ? doc.getPageCount() : await deps.pageCount(buf);
    const want = (part.pages && part.pages.length ? part.pages : Array.from({ length: total }, (_, i) => i + 1)).filter((p) => p >= 1 && p <= total);
    if (part.pages && want.length !== part.pages.length) throw new Error(`${part.label}: pages ${part.pages.join(',')} not all in a ${total}-page file`);
    const first = out.getPageCount() + 1;
    let copied = false;
    if (doc) {
      try {
        const pages = await out.copyPages(doc, want.map((p) => p - 1));
        pages.forEach((p) => out.addPage(p));
        copied = true;
      } catch { copied = false; }
    }
    if (!copied) {
      // Pages added before the failure were not added (copyPages is all-or-nothing).
      await addRendered(out, buf, want, deps);
      rebuilt.push(part.label);
    }
    ranges.push([first, out.getPageCount()]);
    for (const p of want) sources.push({ src: part.src, page: p, label: part.label });
  }
  return { bytes: Buffer.from(await out.save()), pages: out.getPageCount(), ranges, rebuilt, sources };
}

async function addRendered(out, buf, pageNumbers, deps, scale = RENDER_SCALE) {
  const imgs = await deps.render(buf, pageNumbers, scale);
  if (imgs.length !== pageNumbers.length) throw new Error(`rendered ${imgs.length} of ${pageNumbers.length} pages`);
  for (const im of imgs.sort((a, b) => a.pageNumber - b.pageNumber)) {
    const png = await out.embedPng(Buffer.from(im.base64, 'base64'));
    const w = png.width / scale; const h = png.height / scale;
    out.addPage([w, h]).drawImage(png, { x: 0, y: 0, width: w, height: h });
  }
}

/** The plan -> package parts (in order) and attachment parts. */
function partsFromPlan(plan) {
  const pkg = plan.units.map((u) => ({ src: u.src, pages: u.pages || u.src.pages || null, label: u.label }));
  const attachments = plan.attachments.map((a) => ({ name: a.name, parts: [{ src: { ...a.src, pages: undefined }, pages: a.src.pages || null, label: a.name }] }));
  return { pkg, attachments };
}

// ---------------------------------------------------------------------------
// Checks.

/**
 * Share of dark pixels in a png, via @napi-rs/canvas (already on the site:
 * pdf-parse renders with it). Loaded lazily; null when it is not available,
 * and the blank check then says it did not run.
 */
function defaultInk() {
  let canvas;
  try { canvas = require('@napi-rs/canvas'); } catch { return null; }
  return async (base64) => {
    const img = await canvas.loadImage(Buffer.from(base64, 'base64'));
    const c = canvas.createCanvas(img.width, img.height);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 600 && d[i + 3] > 0) dark++;
    return dark / (d.length / 4);
  };
}

/**
 * Render every page small; a near-blank page whose SOURCE page had words is a
 * problem (a blank page in the source is just a blank page).
 */
async function blankPages(built, deps, textOf) {
  if (deps.ink === undefined) deps.ink = defaultInk();
  if (!deps.ink) return { checked: false, problems: [] };
  const problems = [];
  const nums = Array.from({ length: built.pages }, (_, i) => i + 1);
  for (let i = 0; i < nums.length; i += 20) {
    const imgs = await deps.render(built.bytes, nums.slice(i, i + 20), CHECK_SCALE);
    for (const im of imgs) {
      if ((await deps.ink(im.base64)) >= BLANK_INK) continue;
      const s = built.sources[im.pageNumber - 1];
      const srcWords = s ? words(await textOf(s.src, s.page)).length : 0;
      if (srcWords >= 5) { problems.push({ page: im.pageNumber, label: s.label, why: `page ${im.pageNumber} (${s.label}) came out blank but the original page has text` }); continue; }
      // A scanned original has no text to compare: look at it instead.
      if (s && deps.getBytes) {
        const [orig] = await deps.render(await deps.getBytes(s.src), [s.page], CHECK_SCALE).catch(() => []);
        if (orig && (await deps.ink(orig.base64)) >= BLANK_INK * 5) problems.push({ page: im.pageNumber, label: s.label, why: `page ${im.pageNumber} (${s.label}) came out blank but the original page is not` });
      }
    }
  }
  return { checked: true, problems };
}

/** Bytes of each page on its own (only called when over the size target). */
async function pageWeights(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    const one = await PDFDocument.create();
    const [p] = await one.copyPages(doc, [i]);
    one.addPage(p);
    out.push({ page: i + 1, bytes: (await one.save()).length });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/**
 * Re-render the given pages of a PDF as images, everything else copied as is.
 * Only ever for pages that are pathologically heavy, and the result is still
 * blank-checked by the caller.
 */
async function rerenderPages(bytes, pageNumbers, deps) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const heavy = new Set(pageNumbers);
  for (let i = 1; i <= src.getPageCount(); i++) {
    if (heavy.has(i)) { await addRendered(out, bytes, [i], deps); continue; }
    const [p] = await out.copyPages(src, [i - 1]);
    out.addPage(p);
  }
  return Buffer.from(await out.save());
}

/**
 * Replace the given output pages with images of their ORIGINAL pages. For a
 * page pdf-lib copied without its content (20701 Schoolcraft, 2026-10-23: the
 * wildfire advisory came out blank, its original reads fine). Keeps `sources`.
 */
async function repairFromSource(built, pageNumbers, deps) {
  const src = await PDFDocument.load(built.bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const fix = new Set(pageNumbers);
  for (let i = 1; i <= src.getPageCount(); i++) {
    const s = built.sources[i - 1];
    if (fix.has(i) && s) { await addRendered(out, await deps.getBytes(s.src), [s.page], deps); continue; }
    const [p] = await out.copyPages(src, [i - 1]);
    out.addPage(p);
  }
  return { ...built, bytes: Buffer.from(await out.save()) };
}

/** Blank check, then repair from the originals, then check again. */
async function checkAndRepair(built, deps, textOf, label, warnings, problems) {
  const first = await blankPages(built, deps, textOf);
  if (!first.checked || !first.problems.length) return { built, checked: first.checked };
  const pages = first.problems.map((p) => p.page);
  const fixed = await repairFromSource(built, pages, deps);
  const again = await blankPages(fixed, deps, textOf);
  const still = new Set(again.problems.map((p) => p.page));
  const repaired = first.problems.filter((p) => !still.has(p.page));
  if (repaired.length) warnings.push(`${label}: ${repaired.length === 1 ? 'page' : 'pages'} ${repaired.map((p) => `${p.page} (${p.label})`).join(', ')} came out blank and ${repaired.length === 1 ? 'was' : 'were'} rebuilt from the original: check ${repaired.length === 1 ? 'it reads' : 'they read'}`);
  for (const p of again.problems) problems.push(`${label} ${p.why}`);
  return { built: fixed, checked: true };
}

// ---------------------------------------------------------------------------
// The whole build.

/**
 * plan (from planPackage) -> { pkg: { bytes, pages, ranges }, attachments: [{ name, bytes, pages }],
 *   problems: [..] (blank pages: do NOT file), warnings: [..], size }.
 */
async function assemble(plan, deps, { address = '' } = {}) {
  const warnings = [];
  const problems = [];
  const { pkg: pkgParts, attachments: attParts } = partsFromPlan(plan);
  const textCache = new Map();
  const textOf = async (src, page) => {
    const k = srcKey(src);
    if (!textCache.has(k)) textCache.set(k, await deps.pageTexts(await deps.getBytes(src)));
    const t = textCache.get(k).find((x) => x.num === page);
    return t ? t.text : '';
  };

  let pkg = await buildPdf(pkgParts, deps);
  const atts = [];
  for (const a of attParts) {
    const b = await buildPdf(a.parts, deps);
    atts.push({ name: a.name, bytes: b.bytes, pages: b.pages, sources: b.sources, rebuilt: b.rebuilt });
  }
  for (const r of pkg.rebuilt) warnings.push(`"${r}" could not be copied as is (damaged file) and was rebuilt from images: check it reads`);
  for (const a of atts) for (const r of a.rebuilt) warnings.push(`attachment "${a.name}" was rebuilt from images (damaged file): check it reads`);

  // Page count must equal what the plan placed.
  const planned = pkgParts.reduce((s, p) => s + (p.pages ? p.pages.length : 0), 0);
  const wholeFiles = pkgParts.filter((p) => !p.pages).length;
  if (!wholeFiles && planned !== pkg.pages) problems.push(`the package has ${pkg.pages} pages but the plan placed ${planned}`);

  // Size.
  const raw = () => pkg.bytes.length + atts.reduce((s, a) => s + a.bytes.length, 0);
  const size = { before: raw(), rerendered: [] };
  if (raw() > GMAIL_RAW_TARGET) {
    const weights = await pageWeights(pkg.bytes);
    const heavy = weights.filter((w) => w.bytes > 2 * 1024 * 1024).slice(0, 5).map((w) => w.page);
    if (heavy.length) {
      const bytes = await rerenderPages(pkg.bytes, heavy, deps);
      if (bytes.length < pkg.bytes.length) {
        pkg = { ...pkg, bytes };
        size.rerendered = heavy;
        warnings.push(`the package was too big for Gmail, so ${span(heavy)} (the heaviest) were re-rendered as images: check they read`);
      }
    }
  }
  size.after = raw();
  size.gmailOk = size.after * 1.37 <= 25 * 1024 * 1024;
  if (!size.gmailOk) warnings.push(`package + attachments are ${(size.after / 1048576).toFixed(1)}MB, over Gmail's limit once encoded: move an attachment to a link (Megan decides which)`);

  // Blank pages (package and attachments): repaired from the originals when
  // possible; a page still blank after that is a problem (do not use).
  const blank = await checkAndRepair(pkg, deps, textOf, 'package', warnings, problems);
  pkg = { ...pkg, bytes: blank.built.bytes };
  for (let i = 0; i < atts.length; i++) {
    const r = await checkAndRepair(atts[i], deps, textOf, `attachment "${atts[i].name}"`, warnings, problems);
    atts[i] = { ...atts[i], bytes: r.built.bytes };
  }
  if (!blank.checked) warnings.push('blank-page check did not run (no image reader): look through the package before sending');

  const fx = [];
  for (const f of plan.fx || []) {
    const b = await buildPdf([{ src: { ...f.src, pages: undefined }, pages: f.src.pages, label: f.name }], deps);
    fx.push({ name: `${f.name}.pdf`, bytes: b.bytes, pages: b.pages });
  }

  return {
    name: `Disclosures - ${address}.pdf`,
    fx,
    pkg: { bytes: pkg.bytes, pages: pkg.pages, ranges: pkg.ranges },
    attachments: atts.map((a) => ({ name: `${a.name}.pdf`, bytes: a.bytes, pages: a.pages })),
    problems, warnings, size,
  };
}

// ---------------------------------------------------------------------------
// Filing.

/**
 * Save at the TOP of the deal folder. Nothing is overwritten: an existing
 * package means Megan already has one (hers wins), an existing attachment of
 * the same name is left alone. `trash` = Drive ids of deal-folder files the
 * package was built from, moved to TRASH FOLDER (only after the package saved).
 */
async function fileToDealFolder(drive, deal, built, { trash = [] } = {}) {
  const res = { saved: [], kept: [], trashed: [], note: '' };
  if (!deal || !deal.folder) { res.note = 'no deal folder found: nothing saved'; return res; }
  const have = new Set(deal.files.map((f) => f.name));
  if (have.has(built.name)) {
    res.kept.push(built.name);
    res.note = `"${built.name}" is already in the deal folder: left as it is (hers is the one to use)`;
    return res;
  }
  await drive.uploadMultipart({ name: built.name, parents: [deal.folder.id], bytes: built.pkg.bytes });
  res.saved.push(built.name);
  for (const a of built.attachments.concat(built.fx || [])) {
    if (have.has(a.name)) { res.kept.push(a.name); continue; }
    await drive.uploadMultipart({ name: a.name, parents: [deal.folder.id], bytes: a.bytes });
    res.saved.push(a.name);
  }
  if (trash.length) {
    const bin = await drive.ensureFolder('TRASH FOLDER', deal.folder.id);
    for (const t of trash) {
      await drive.moveFile(t.id, { addParents: [bin.id], removeParents: [deal.folder.id] });
      res.trashed.push(t.name);
    }
  }
  return res;
}

module.exports = {
  findDuplicates, findWrongProperty, findTails, findTailCandidates, findContractDocs, buildPdf, partsFromPlan, assemble, fileToDealFolder,
  blankPages, repairFromSource, checkAndRepair, defaultInk, pageWeights, rerenderPages, shingles, overlap, GMAIL_RAW_TARGET,
};
