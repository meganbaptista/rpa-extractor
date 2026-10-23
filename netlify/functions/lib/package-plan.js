// netlify/functions/lib/package-plan.js
//
// THE BUYER PACKAGE PLANNER (stage 1 of the automatic buyer package). Pure: no
// I/O, no AI. Given what the intake job identified in a delivery (the map
// step: per file, forms with a C.A.R. code or a title, and their pages), it
// decides where every page goes: a package section in Megan's order, a
// separate attachment, or LEFT OUT with a written reason. Every delivered page
// is accounted for exactly once; anything it cannot place with confidence is
// placed conservatively (with the seller's documents) AND listed as a warning
// for Megan, never guessed and never dropped ("I just never want to leave a
// random document out and get in trouble", 2026-10-23).
//
// The rules are the buyer-package RULEBOOK (her rules, 2026-10-21..23):
//   - nothing the listing side sent is removed except: DSDT, the full NHD
//     report / prelim / vendor wildfire report (separate attachments), the
//     state booklets 1-4 of 6 (never in; the email links them), the NHD
//     invoice (never), and long seller reports (separate "Seller Report - ...")
//   - order: TDS (+overflow) / SPQ (+overflow) -> reports and documents from
//     the seller -> NHD statement right before the FHDS -> additional forms ->
//     AVIDs (listing agent's, then ours) -> advisories (listing brokerage's
//     own forms first, then C.A.R.) -> our brokerage's pages -> other /
//     contract items at the end
//   - never two copies of the same form
//
// The map's spans are not always right (5733 E Stillwater #2: a 1-page text
// overflow addendum was mapped as 7 pages, swallowing part of a report). Known
// C.A.R. forms are capped at their real length; the rest becomes an
// unidentified block (placed with the seller's documents, warned).

// ---------------------------------------------------------------------------
// What a form IS, from its code or title.

const SECTION = {
  SELLER: 1,       // TDS, SPQ and their overflow / addenda
  REPORTS: 2,      // reports and documents from the seller
  FORMS: 3,        // NHD statement, FHDS, SFLS, PSD, LPD, WCMD, WHSD ...
  AVIDS: 4,
  ADVISORIES: 5,   // listing brokerage's own forms first, then C.A.R.
  OURS: 6,         // our brokerage's pages (drop-ins)
  OTHER: 7,        // contract / escrow items and anything else, at the end
};

// Real lengths of single-page C.A.R. forms the map tends to over-extend.
const KNOWN_LEN = { TOA: 1, ADM: 1, APD: 1, WCMD: 1, WHSD: 1, SFLS: 1, PSD: 1, SPT: 1, WFA: 1, AEA: 1, AC: 1, AAA: 1 };

const ADDITIONAL_FORM_CODES = new Set(['FHDS', 'SFLS', 'PSD', 'LPD', 'WCMD', 'WHSD', 'TA', 'SOLAR', 'WBSA', 'RCSD', 'RCSD-S', 'ESD', 'SPRP', 'EQ']);
const ADVISORY_CODES = new Set(['MCA', 'SBSA', 'WFDA', 'BHAA', 'DIA', 'FHDA', 'WFA', 'AC', 'AAA', 'PVOH', 'RPOA', 'SVRA', 'ABA', 'BIA', 'HOA']);
const CONTRACT_CODES = new Set(['RFR', 'BIE', 'BIW', 'SPT', 'BUO', 'SXA', 'FIRPTA', 'QS', 'CR', 'NBP', 'ADM']);

const RX = {
  nhdStatement: /natural hazard disclosure statement/i,
  nhdInvoice: /\binvoice\b/i,
  homeWarranty: /home\s*warranty/i,
  booklet: /\b[1-4]\s*(?:_|-|\s)?of\s*(?:_|-|\s)?6\b|residential environmental hazards|protect your family from lead|home energy rating|homeowner'?s guide to earthquake safety/i,
  bookletReceipt: /acknowledg\w* of receipt|consumer information (?:booklets|acknowledg)|receipt for (?:links to )?booklets|6\s*of\s*6|booklet.*(?:receipt|signature)/i,
  eqDisclosure: /residential earthquake risk disclosure/i,
  prelim: /prelim(?:inary)?\b.*\b(?:title|report)|clta preliminary|\bptr\b/i,
  wildfireReport: /wildfire (?:risk )?report|fire risk report/i,
  homeInspection: /home inspection|property inspection report|pre-?listing inspection/i,
  report: /report|inspection|estimate|proposal|letter|permit|termite|wood destroying|work order|improvement|photo|remediation|mitigation|restoration|warranty|invoice\/order|association disclosure|hoa|certificate|clearance/i,
  listingBrokerage: /affiliated business|hold harmless|mold disclosure|local area disclosure|brokerage|realty|real estate|sotheby|compass|coldwell|keller|truline|carolwood|seven gables/i,
  mlsOrProfile: /property details|property profile|\bmls\b|listing (?:report|detail)|vendor enhanced/i,
};

/** One "unit" = a run of pages in one file that is one form or document. */
function classify(unit) {
  const code = String(unit.code || '').toUpperCase();
  const name = String(unit.name || '');
  const pages = unit.pages.length;
  if (code === 'DSDT') return { leave: 'DSDT (always removed)' };
  if (code === 'TDS') return { section: SECTION.SELLER, order: 0, kind: 'TDS' };
  if (code === 'SPQ') return { section: SECTION.SELLER, order: 1, kind: 'SPQ' };
  if (code === 'TOA' || code === 'ADM' || code === 'APD') return { kind: 'ADDENDUM' };   // follows the form before it
  if (code === 'AVID') return { section: SECTION.AVIDS, kind: 'AVID' };
  if (RX.nhdStatement.test(name) && pages <= 3) return { section: SECTION.FORMS, kind: 'NHD_STATEMENT' };
  if (RX.booklet.test(name) && pages > 3) return { leave: 'state booklet (never in; the email links the booklets)' };
  if (code === 'AEA') return { leave: 'amendment of existing agreement terms: a contract item for the buyers to accept, back to Megan', warn: true };
  if (ADDITIONAL_FORM_CODES.has(code) || RX.eqDisclosure.test(name) || RX.bookletReceipt.test(name)) return { section: SECTION.FORMS, kind: code || 'FORM' };
  if (CONTRACT_CODES.has(code)) return { section: SECTION.OTHER, kind: code };
  // Contract documents from the purchase-agreement audit come back signed with
  // the disclosures (5733 E Stillwater #2: FHDA, WFA, the brokerage ABA, MCA).
  // Only a signature check can say they are fully executed: kept, and flagged.
  if (code === 'FHDA' || code === 'WFA') return { section: SECTION.ADVISORIES, order: 1, kind: code, warn: `${code} is a purchase-agreement document: if it came back fully signed, file it as "FX - ${code}" and take it out of the package` };
  if (ADVISORY_CODES.has(code)) return { section: SECTION.ADVISORIES, order: 1, kind: code };
  if (RX.mlsOrProfile.test(name)) return { kind: 'MLS_PROFILE' };   // follows the SFLS it backs up
  if (!code && RX.listingBrokerage.test(name) && !RX.report.test(name)) return { section: SECTION.ADVISORIES, order: 0, kind: 'LISTING_BROKERAGE' };
  if (!code && RX.report.test(name)) return { section: SECTION.REPORTS, kind: 'REPORT' };
  if (code) return { section: SECTION.ADVISORIES, order: 1, kind: code, warn: `C.A.R. form ${code} placed with the advisories: check the spot` };
  return { section: SECTION.REPORTS, kind: 'UNKNOWN', warn: true };
}

/** Whole files that are themselves a report to attach, leave out, or plan. */
function classifyFile(file) {
  const name = String(file.name || '');
  const first = ((file.forms || [])[0] || {}).name || '';
  if (RX.nhdInvoice.test(name) && /nhd|natural hazard|disclosure source|mynhd|priority/i.test(name)) return { leave: 'NHD invoice (always left out)' };
  if (RX.prelim.test(name) || RX.prelim.test(first)) return { attach: 'Preliminary Title Report' };
  // A home warranty the seller ordered (2647 E Wilson: an order confirmation):
  // never in the package, saved and attached as a seller report (Megan 10/23).
  if (RX.homeWarranty.test(name) || RX.homeWarranty.test(first)) return { attach: 'Seller Report - Home Warranty' };
  if (RX.wildfireReport.test(name)) return { attach: 'Wildfire Report' };
  if (/\bnhd\b|natural hazard/i.test(name) && file.pages > 5) return { attach: 'Natural Hazard Disclosure Report', nhdReport: true };
  if (RX.booklet.test(name) && file.pages > 3) return { leave: 'state booklet (never in; the email links the booklets)' };
  return null;
}

// ---------------------------------------------------------------------------

/**
 * input = {
 *   address,
 *   files:  [{ n, name, pages, forms: [{ name, code, pages: [1-based] }] }]   (audited docs, map step)
 *   extras: [{ key, name, pages? }]            (kept but not audited: reports by name)
 *   dropIns: { profile, mls, ourAvid, ourBrokerage: [{ label, src, pages }], forms: [{ code, label, src, pages }] }
 *            (lib/package-dropins.js; null when absent)
 *   flags:  { wrongProperty: [{ n, why }] }    (from the assembler's text checks)
 *   longReportPages: 20                        (a seller report longer than this is attached separately)
 * }
 * Returns { units, attachments, leftOut, warnings, guide, accounted }.
 */
function planPackage(input) {
  const out = { units: [], attachments: [], leftOut: [], warnings: [] };
  const longPages = input.longReportPages || 20;
  // Wrong-property files, extras, or pages inside a file (5733 E Stillwater #2:
  // the NHD report AND the NHD statement inside the combined PDF were for 5722).
  const wrongAll = (input.flags || {}).wrongProperty || [];
  const wrong = new Map(wrongAll.filter((w) => w.n != null && !w.pages).map((w) => [w.n, w.why]));
  const wrongExtras = new Map(wrongAll.filter((w) => w.key != null).map((w) => [w.key, w.why]));
  const wrongPages = new Map();
  for (const w of wrongAll.filter((x) => x.n != null && x.pages)) for (const p of w.pages) wrongPages.set(`${w.n}:${p}`, w.why);
  // Whole files (or extras) that repeat pages already in another delivered file
  // (5733 E Stillwater #2: four separate attachments were copies of pages inside
  // the combined PDF). Found by the assembler's text comparison; placed once.
  const dupFiles = new Map(((input.flags || {}).duplicates || []).filter((x) => x.n != null).map((x) => [x.n, x.of]));
  const dupExtras = new Map(((input.flags || {}).duplicates || []).filter((x) => x.key != null).map((x) => [x.key, x.of]));
  const dupList = (input.flags || {}).duplicates || [];
  // Pages that are only signature lines (Stillwater p100: the termite work
  // order's "X____ BUYER" lines, mapped onto the next document): they stay with
  // the document before them.
  const tails = new Set(((input.flags || {}).tails || []).map((t) => `${t.n}:${t.page}`));
  // Purchase-agreement documents the contract audit was waiting on, found in the
  // delivery (Stillwater: FHDA, WFA, our brokerage's ABA, MCA, all fully signed):
  // filed as "FX - <name>" at the top of the deal folder, never in the package.
  const fxPages = new Map();
  for (const f of (input.flags || {}).fx || []) for (const p of f.pages) fxPages.set(`${f.n}:${p}`, f.name);
  out.fx = [];
  const seenCodes = new Set();
  let nhdStatementPlaced = false;
  let nhdReport = null;

  const accounted = new Map();   // `${n}:${page}` -> where
  const account = (n, pages, where) => { for (const p of pages) accounted.set(`${n}:${p}`, where); };

  for (const file of input.files || []) {
    if (wrong.has(file.n)) {
      out.leftOut.push({ what: file.name, why: `wrong property: ${wrong.get(file.n)}` });
      out.warnings.push(`${file.name}: ${wrong.get(file.n)}; left out and flagged`);
      account(file.n, range(file.pages), 'left out (wrong property)');
      continue;
    }
    if (dupFiles.has(file.n)) {
      out.leftOut.push({ what: file.name, why: `duplicate of ${dupFiles.get(file.n)} (already in the package once)` });
      account(file.n, range(file.pages), 'left out (duplicate)');
      continue;
    }
    const fc = classifyFile(file);
    if (fc && fc.leave) { out.leftOut.push({ what: file.name, why: fc.leave }); account(file.n, range(file.pages), 'left out'); continue; }
    if (fc && fc.attach) {
      out.attachments.push({ name: fc.attach, src: { type: 'file', n: file.n } });
      account(file.n, range(file.pages), `attached separately (${fc.attach})`);
      if (fc.nhdReport) nhdReport = file;
      continue;
    }

    // Split the file into units, capping known single-page forms.
    const units = [];
    for (const f of file.forms || []) {
      const pages = [...f.pages].sort((a, b) => a - b);
      const cap = KNOWN_LEN[String(f.code || '').toUpperCase()];
      if (cap && pages.length > cap) {
        units.push({ ...f, pages: pages.slice(0, cap) });
        units.push({ name: '', code: '', pages: pages.slice(cap), split: `mapped as part of ${f.code} but past its ${cap} page(s)` });
      } else units.push({ ...f, pages });
    }
    const claimed = new Set(units.flatMap((u) => u.pages));
    const loose = range(file.pages).filter((p) => !claimed.has(p));
    if (loose.length) units.push({ name: '', code: '', pages: loose, split: 'pages no form claimed' });
    units.sort((a, b) => a.pages[0] - b.pages[0]);
    // Signature-only tail pages go back to the document before them.
    for (let i = 1; i < units.length; i++) {
      const u = units[i]; const prevU = units[i - 1];
      while (u.pages.length && tails.has(`${file.n}:${u.pages[0]}`) && u.pages[0] === prevU.pages[prevU.pages.length - 1] + 1) prevU.pages.push(u.pages.shift());
      if (!u.pages.length) { units.splice(i, 1); i--; }
    }
    // MERGE what the map split: consecutive pieces of the same titled document
    // (Wilson's permit report came back as 4), and an unidentified run that
    // sits right next to a report (Stillwater's restoration report pages 31-36
    // before its photo report 37-61) joins that report.
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const isReport = (u) => !u.code && RX.report.test(u.name || '');
    const isBlank = (u) => !u.code && !String(u.name || '').trim();
    for (let i = 0; i < units.length - 1;) {
      const a = units[i]; const b = units[i + 1];
      const touching = b.pages[0] === a.pages[a.pages.length - 1] + 1;
      const sameDoc = touching && !a.code && !b.code && norm(a.name) && norm(a.name) === norm(b.name);
      const blankThenReport = touching && isBlank(a) && isReport(b);
      const reportThenBlank = touching && isReport(a) && isBlank(b);
      // A termite company's work order belongs to its report (Stillwater p99).
      const workOrder = touching && /termite|wood destroying/i.test(a.name || '') && /work order/i.test(b.name || '');
      if (sameDoc || blankThenReport || reportThenBlank || workOrder) {
        units.splice(i, 2, { name: isBlank(a) ? b.name : a.name, code: '', pages: [...a.pages, ...b.pages], merged: blankThenReport || reportThenBlank || workOrder });
        continue;
      }
      i++;
    }

    let prev = null;
    for (const u of units) {
      const c = classify(u);
      const label = u.name || u.code || '(untitled)';
      const fxName = u.pages.map((p) => fxPages.get(`${file.n}:${p}`)).find(Boolean);
      if (fxName) {
        out.fx.push({ name: fxName, src: { type: 'file', n: file.n, pages: [...u.pages] } });
        out.leftOut.push({ what: `${file.name}, p${span(u.pages)} (${label})`, why: `purchase-agreement document: filed as "${fxName}", not part of the disclosures` });
        out.warnings.push(`"${fxName}" filed from ${file.name} p${span(u.pages)}: check every signature is there and tick it on the compliance list`);
        account(file.n, u.pages, `filed (${fxName})`);
        prev = null;
        continue;
      }
      const wrongWhy = u.pages.map((p) => wrongPages.get(`${file.n}:${p}`)).find(Boolean);
      if (wrongWhy) {
        out.leftOut.push({ what: `${file.name}, p${span(u.pages)} (${label})`, why: `wrong property: ${wrongWhy}; ask the listing side for the right one` });
        out.warnings.push(`${label} (${file.name} p${span(u.pages)}): ${wrongWhy}; left out, ask the listing side for the right one`);
        account(file.n, u.pages, 'left out (wrong property)');
        prev = null;
        continue;
      }
      if (c.leave) {
        out.leftOut.push({ what: `${file.name}, p${span(u.pages)} (${label})`, why: c.leave });
        if (c.warn) out.warnings.push(`${label} (${file.name} p${span(u.pages)}): ${c.leave}`);
        account(file.n, u.pages, 'left out');
        prev = null;
        continue;
      }
      if ((c.kind === 'ADDENDUM' || c.kind === 'MLS_PROFILE' || (c.kind === 'UNKNOWN' && u.split && prev && prev.kind === 'REPORT')) && prev) {
        // Overflow / addenda / the SFLS's backing printouts / the tail of a report stay with what they follow.
        prev.pages.push(...u.pages);
        if (c.kind === 'UNKNOWN') out.warnings.push(`${file.name} p${span(u.pages)}: ${u.split}; kept with "${prev.label}"`);
        account(file.n, u.pages, `with ${prev.label}`);
        continue;
      }
      if (c.kind === 'ADDENDUM') c.section = SECTION.SELLER, c.order = 2;
      if (c.kind === 'MLS_PROFILE') { c.section = SECTION.FORMS; }
      if (c.kind === 'NHD_STATEMENT') nhdStatementPlaced = true;
      const code = String(u.code || '').toUpperCase();
      if (code && seenCodes.has(code) && !['TOA', 'ADM', 'AVID'].includes(code)) {
        out.warnings.push(`a second ${code} (${file.name} p${span(u.pages)}): both kept; check which one goes`);
      }
      if (code) seenCodes.add(code);
      if (c.warn) out.warnings.push(typeof c.warn === 'string' ? c.warn : `${file.name} p${span(u.pages)}: could not tell what "${label}" is; placed with the seller's documents`);
      const unit = { section: c.section, order: c.order || 0, kind: c.kind, code, label, src: { type: 'file', n: file.n }, pages: [...u.pages], file: file.name, seq: out.units.length };
      out.units.push(unit);
      account(file.n, u.pages, `section ${c.section}`);
      prev = unit;
    }
  }

  // Reports kept but not audited (skipped by name): long ones attached separately.
  for (const x of input.extras || []) {
    if (wrongExtras.has(x.key)) { out.leftOut.push({ what: x.name, why: `wrong property: ${wrongExtras.get(x.key)}` }); out.warnings.push(`${x.name}: ${wrongExtras.get(x.key)}; left out and flagged`); continue; }
    if (dupExtras.has(x.key)) { out.leftOut.push({ what: x.name, why: `duplicate of ${dupExtras.get(x.key)} (already in the package once)` }); continue; }
    if (x.fromDealFolder) out.warnings.push(`"${x.name}" is from the deal folder, not this delivery: added with the seller's reports, check it belongs`);
    const fc = classifyFile({ name: x.name, pages: x.pages || 0, forms: [] });
    if (fc && fc.leave) { out.leftOut.push({ what: x.name, why: fc.leave }); continue; }
    if (fc && fc.attach) { out.attachments.push({ name: fc.attach, src: x.src || { type: 'extra', key: x.key } }); continue; }
    const long = RX.homeInspection.test(x.name) || (x.pages || 0) > longPages;
    if (long) out.attachments.push({ name: sellerReportName(x.name), src: x.src || { type: 'extra', key: x.key } });
    else out.units.push({ section: SECTION.REPORTS, order: 0, kind: 'REPORT', code: '', label: x.name.replace(/\.pdf$/i, ''), src: x.src || { type: 'extra', key: x.key }, pages: null, file: x.name, seq: out.units.length });
  }

  // Long seller reports inside the delivery go out as separate attachments too.
  for (const u of out.units.filter((v) => v.kind === 'REPORT' && v.pages && (v.pages.length > longPages || RX.homeInspection.test(v.label) || RX.homeWarranty.test(v.label)))) {
    if (RX.homeWarranty.test(u.label)) u.label = 'Home Warranty';
    else u.label = reportTitle(u, dupList, input.files || []) || u.label;
    out.attachments.push({ name: sellerReportName(u.label), src: { ...u.src, pages: u.pages } });
    out.leftOut.push({ what: `${u.file}, p${span(u.pages)} (${u.label})`, why: `${u.label === 'Home Warranty' ? 'home warranty' : 'long seller report'}: attached separately as "${sellerReportName(u.label)}"` });
    u.section = null;
  }

  // NHD statement: when none came separately, pull it out of the full report.
  if (!nhdStatementPlaced && nhdReport) {
    const st = (nhdReport.forms || []).find((f) => RX.nhdStatement.test(f.name || ''));
    if (st) out.units.push({ section: SECTION.FORMS, order: 0, kind: 'NHD_STATEMENT', code: '', label: 'Natural Hazard Disclosure Statement (from the NHD report)', src: { type: 'file', n: nhdReport.n }, pages: [st.pages[0]], file: nhdReport.name, seq: out.units.length });
    else out.warnings.push('no NHD statement page found in the NHD report: add it by hand');
  }

  // Drop-ins.
  const d = input.dropIns || {};
  const hasListingMls = out.units.some((u) => u.kind === 'SFLS' && u.pages && u.pages.length > 1);
  if (d.profile && !hasListingMls) out.units.push({ section: SECTION.FORMS, order: 0, kind: 'PROFILE', label: 'Property Profile (drop-in)', src: d.profile, seq: out.units.length });
  else if (d.profile) out.leftOut.push({ what: 'our Property Profile', why: 'the listing side sent their own printout with the square footage disclosure (never two copies)' });
  if (d.mls && !hasListingMls) out.units.push({ section: SECTION.FORMS, order: 0, kind: 'MLS', label: 'MLS CLIENT TO SIGN (drop-in)', src: d.mls, seq: out.units.length });
  else if (d.mls) out.leftOut.push({ what: 'our MLS CLIENT TO SIGN', why: 'the listing side sent their own MLS printout (never two copies)' });
  if (d.ourAvid) out.units.push({ section: SECTION.AVIDS, order: 1, kind: 'OUR_AVID', label: "Our agent's AVID (drop-in, blank is correct)", src: d.ourAvid, seq: out.units.length });
  // Standard forms the compliance list wants that the listing side did not send,
  // from the deal's Audit Disclosures template (BHAA, LPD, WFDA ...; never DIA).
  for (const f of d.forms || []) {
    const c = classify({ code: f.code, name: f.label, pages: f.pages || [1] });
    if (c.leave) continue;
    out.units.push({ section: c.section || SECTION.ADVISORIES, order: c.order || 0, kind: c.kind || f.code, code: f.code, label: f.label, src: f.src, pages: f.pages || null, file: 'Audit Disclosures template', seq: out.units.length });
  }
  for (const b of d.ourBrokerage || []) out.units.push({ section: SECTION.OURS, order: 0, kind: 'OURS', label: b.label, src: b.src, pages: b.pages, seq: out.units.length });

  // Order: section, then within section the rulebook's sub-order.
  const formRank = (u) => {
    if (u.section !== SECTION.FORMS) return 0;
    if (u.kind === 'NHD_STATEMENT') return 0;
    if (u.kind === 'FHDS') return 1;
    if (u.kind === 'SFLS' || u.kind === 'PROFILE' || u.kind === 'MLS') return 2 + (u.kind === 'SFLS' ? 0 : u.kind === 'PROFILE' ? 0.1 : 0.2);
    // The booklet acknowledgement closes the additional forms (her Stillwater order).
    if (u.kind === 'CIA' || /consumer information acknowledg/i.test(u.label || '')) return 4;
    return 3;
  };
  const avidRank = (u) => (u.kind === 'OUR_AVID' ? 1 : 0);
  // The NHD statement goes right before the FHDS; with no FHDS it still leads
  // the additional forms (= right after the seller's section, before any AVID).
  out.units = out.units.filter((u) => u.section)
    .sort((a, b) => a.section - b.section || (a.order || 0) - (b.order || 0) || formRank(a) - formRank(b) || avidRank(a) - avidRank(b) || a.seq - b.seq);

  out.accounted = accounted;
  out.guide = guideSections(out.units);
  return out;
}

/**
 * A better name for a separate seller report than the map's page title: what
 * the delivered copies of the same pages were called (Stillwater: the map said
 * "Photo Report" for pages that came separately as "Mitigation Letter" and
 * "Roman Restoration"; Megan named it "Restoration Report").
 */
const REPORT_NAMES = [
  [/restor|mitigation|remediation|water damage/i, 'Restoration Report'],
  [/home inspection|property inspection|pre-?listing inspection/i, 'Home Inspection'],
  [/termite|wood destroying|pest/i, 'Termite Report'],
  [/roof/i, 'Roof Report'],
  [/sewer|lateral/i, 'Sewer Report'],
  [/chimney/i, 'Chimney Report'],
  [/mold/i, 'Mold Report'],
  [/permit/i, 'Permit Report'],
];
function reportTitle(u, dups, files) {
  if (!u.pages || u.src.type !== 'file') return '';
  const names = [u.label];
  const fileName = new Map(files.map((f) => [f.n, f.name]));
  for (const d of dups) {
    if (d.ofN !== u.src.n || !d.pages || !d.pages.some((p) => u.pages.includes(p))) continue;
    names.unshift(d.n != null ? fileName.get(d.n) || '' : d.name || '');
  }
  for (const [rx, title] of REPORT_NAMES) if (names.some((n) => rx.test(n))) return title;
  return '';
}

function sellerReportName(name) {
  const base = String(name || '').replace(/\.pdf$/i, '').replace(/^\d+\.\s*/, '').replace(/\s+-\s+(seller|buyer)$/i, '').trim();
  return `Seller Report - ${base.replace(/\b\w/g, (c) => c.toUpperCase())}`;
}

/** The calm layout's three (or four) page ranges, labels in plain English. */
function guideSections(units) {
  const groups = [
    { secs: [SECTION.SELLER], label: "The seller's disclosures about the condition of the home" },
    { secs: [SECTION.REPORTS, SECTION.FORMS, SECTION.AVIDS], label: null },
    { secs: [SECTION.ADVISORIES, SECTION.OURS], label: null },
    { secs: [SECTION.OTHER], label: null },
  ];
  const has = (s) => units.some((u) => u.section === s);
  groups[1].label = [has(SECTION.REPORTS) ? 'Documents from the seller' : '', has(SECTION.FORMS) ? 'additional forms' : '',
    has(SECTION.AVIDS) ? (units.some((u) => u.kind === 'AVID') && units.some((u) => u.kind === 'OUR_AVID') ? 'the visual inspections by the listing agent and our agent'
      : units.some((u) => u.kind === 'AVID') ? "the listing agent's visual inspection" : "our agent's visual inspection") : '']
    .filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' and $1').replace(/^a/, 'A');
  groups[2].label = has(SECTION.OURS) ? (has(SECTION.ADVISORIES) ? "Standard advisories and our brokerage's forms" : "Our brokerage's forms") : 'Standard advisories';
  groups[3].label = 'Other documents';
  return groups.filter((g) => g.secs.some(has)).map((g) => ({ sections: g.secs, label: g.label }));
}

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const span = (pages) => (pages.length === 1 ? `${pages[0]}` : `${pages[0]}-${pages[pages.length - 1]}`);

module.exports = { planPackage, classify, classifyFile, sellerReportName, guideSections, SECTION };
