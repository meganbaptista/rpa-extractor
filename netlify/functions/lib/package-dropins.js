// netlify/functions/lib/package-dropins.js
//
// WHAT WE ADD to a buyer package from the deal folder (stage 2 of the automatic
// buyer package). Pure: the caller lists the deal folder's TOP level (never a
// subfolder: those are already uploaded to the broker platform), reads page
// texts, and maps the Audit Disclosures template with the page-strip reader
// (its text layer is font-broken: 2647 E Wilson's reads as "!"#$"). The
// rulebook, as Megan set it 2026-10-21..23:
//
//   - Property Profile and MLS CLIENT TO SIGN from the deal folder, unless the
//     listing side sent their own with the SFLS (the planner decides that).
//     An MLS page that is only a footer is dropped (she removed it on Star
//     Catcher).
//   - Our agent's AVID whenever one is IN the deal folder, blank included
//     ("our blank BA AVID; blank is correct"); none in Drive = go without it
//     ("if we have no AVID in drive, that means we have not received the
//     AVID, so we just go without it").
//   - The "Blank AAA AC ABA" file, whatever agency forms it holds.
//   - Our brokerage's pages from the template, matching the BUYER agent's
//     brokerage, unless our buyer already signed them with the offer (a
//     "(NEED S)" file: Stillwater's Side/Anvil forms).
//   - Standard forms the compliance list wants that the listing side did not
//     send: from the template, EXCEPT the DIA (never). The LPD is really the
//     listing side's to give, so it is noted for Megan.
//   - Seller reports saved in the deal folder that did not come in this
//     delivery (Wilson's Termite Inspection.pdf): added with the reports and
//     warned, since they did not come with the delivery. Copies of delivered
//     files are caught by the assembler's duplicate check.
//
// Input:
//   dealFiles: [{ id, name, pages, texts?: [{ num, text }] }]    top level, PDFs
//   template:  { id, name, forms: [{ code, name, pages }], texts? } | null   (strip map + page texts)
//   deliveredCodes: ['TDS', 'SPQ', ...]   C.A.R. codes the listing side sent
//   wantedCodes:    ['BHAA', 'LPD', ...]  the compliance list's forms (null = unknown)
//   buyerBrokerage: 'Compass'
// Output: { dropIns, reports, warnings, notes }

const OUR_OUTPUT = /^(disclosures - |audit disclosures|seller report - |buyer report - |fx - |fx\b|rfr\b|receipt for reports|natural hazard disclosure report - |preliminary title report - )/i;
const REPORT = /termite|wood destroying|pest|inspection|permit|roof|sewer|chimney|mold|home warranty|restoration|mitigation|survey|report/i;
const NOT_A_SELLER_REPORT = /prelim|title|natural hazard|\bnhd\b|escrow|\bemd\b|comm\b|commission|page 17|mls|property profile|realist|matrix|tax|trust|grant deed|vesting|buyer/i;
const NEVER_FROM_TEMPLATE = new Set(['DIA', 'DSDT']);
// The only standard forms we add from the template when the listing side did
// not send them: the ones Megan has approved adding (Scenic: BHAA, LPD; Wilson:
// WFDA; SBSA is the same kind of advisory). Wilson's list also wanted MCA and a
// Trust Advisory, and her approved package did NOT add them: so a wanted form
// outside this list is only noted, never added.
const TEMPLATE_OK = new Set(['BHAA', 'LPD', 'WFDA', 'SBSA']);

// Template forms that are C.A.R. standards (anything else on the template,
// after the C.A.R. forms, is the brokerage's own pages or local area forms).
// (4180 Sunnyslope: "SAN FERNANDO VALLEY LOCAL AREA DISCLOSURE ADVISORY" was
// taken for brokerage pages.) Local area forms are the listing side's to send:
// never added from the template (her approved Wilson package left it out).
const LOCAL_AREA = /local area disclosure|addendum to seller property questionnaire/i;

const words = (t) => String(t || '').replace(/[^A-Za-z]+/g, ' ').trim().split(' ').filter((w) => w.length > 2).length;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function pickFile(files, rx) {
  return files.filter((f) => rx.test(f.name || '')).sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''))[0] || null;
}

function planDropIns({ dealFiles = [], template = null, deliveredCodes = [], wantedCodes = null, buyerBrokerage = '' }) {
  const dropIns = { profile: null, mls: null, ourAvid: null, ourBrokerage: [], forms: [] };
  const reports = [];
  const warnings = [];
  const notes = [];
  const pdfs = dealFiles.filter((f) => /\.pdf$/i.test(f.name || ''));
  const delivered = new Set(deliveredCodes.map((c) => String(c).toUpperCase()));

  // Property Profile + MLS.
  // At the top, or (Megan 2026-10-23: "sometimes it ends up there") in the FX
  // PURCHASE AGREEMENT subfolder as "Property Profile" / "FX - Property Profile".
  const profile = pickFile(pdfs.filter((f) => !f.inFx), /^property profile\b/i)
    || pickFile(pdfs.filter((f) => f.inFx), /^(fx\s*-\s*)?property profile\b/i);
  if (profile) dropIns.profile = { type: 'drive', id: profile.id, name: profile.name };
  const mls = pickFile(pdfs, /^mls client to sign\b/i);
  if (mls) {
    let pages = null;
    if (mls.texts && mls.texts.length > 1) {
      const real = mls.texts.filter((t) => words(t.text) >= 30).map((t) => t.num);
      if (real.length && real.length < mls.texts.length) {
        pages = real;
        notes.push(`MLS CLIENT TO SIGN: left out page(s) ${mls.texts.filter((t) => !real.includes(t.num)).map((t) => t.num).join(', ')} (footer only)`);
      }
    }
    dropIns.mls = { type: 'drive', id: mls.id, name: mls.name, ...(pages ? { pages } : {}) };
  } else if (!profile) {
    warnings.push('no Property Profile or MLS CLIENT TO SIGN in the deal folder: the package goes without them unless the listing side sent theirs');
  }

  // Our agent's AVID: whatever is in the deal folder (blank is correct).
  const avid = pickFile(pdfs, /\bavid\b/i);
  if (avid) dropIns.ourAvid = { type: 'drive', id: avid.id, name: avid.name };

  // Agency forms file.
  const agency = pickFile(pdfs, /^blank\s+(aaa|ac|aba)\b/i);
  if (agency) dropIns.ourBrokerage.push({ label: agency.name.replace(/(\.pdf)+$/i, ''), src: { type: 'drive', id: agency.id, name: agency.name }, pages: null });

  // Our brokerage's own file in the deal folder ("Equity Union DISC.pdf") beats
  // the template's pages: it is the buyer agent's firm by name.
  const firmWord = String(buyerBrokerage || '').split(/\s+/)[0];
  const firmFile = firmWord ? pdfs.find((f) => new RegExp(`^${firmWord.replace(/[^A-Za-z0-9]/g, '')}\\b.*\\b(disc|disclosures?)\\b`, 'i').test(f.name || '')) : null;

  // Template: our brokerage pages + missing standard forms.
  const signedWithOffer = pdfs.filter((f) => /\(need s\)/i.test(f.name || ''));
  if (template && template.forms && template.forms.length) {
    const src = { type: 'drive', id: template.id, name: template.name };
    const forms = [...template.forms].sort((a, b) => a.pages[0] - b.pages[0]);
    const lastCar = Math.max(0, ...forms.filter((f) => f.code).map((f) => f.pages[f.pages.length - 1]));
    const brokerage = forms.filter((f) => !f.code && f.pages[0] > lastCar && !LOCAL_AREA.test(f.name || ''));
    if (firmFile) {
      if (signedWithOffer.length) notes.push(`our brokerage's forms were signed with the offer (${signedWithOffer.map((f) => f.name).join(', ')}): not added again`);
      else dropIns.ourBrokerage.push({ label: firmFile.name.replace(/(\.pdf)+$/i, ''), src: { type: 'drive', id: firmFile.id, name: firmFile.name }, pages: null });
    } else if (brokerage.length) {
      if (signedWithOffer.length) {
        notes.push(`our brokerage's forms were signed with the offer (${signedWithOffer.map((f) => f.name).join(', ')}): not added again`);
      } else {
        const pagesOf = new Set(brokerage.flatMap((f) => f.pages));
        const word = new RegExp(`\\b${String(buyerBrokerage).split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '')}\\b`, 'i');
        const named = buyerBrokerage && (brokerage.some((f) => word.test(f.name || ''))
          || (template.texts || []).some((t) => pagesOf.has(t.num) && word.test(t.text || '')));
        if (buyerBrokerage && !named) warnings.push(`the template's brokerage pages do not name ${buyerBrokerage}: check they are the buyer agent's brokerage before sending`);
        const pages = brokerage.flatMap((f) => f.pages).sort((a, b) => a - b);
        dropIns.ourBrokerage.push({ label: `${buyerBrokerage || 'Our brokerage'} forms (template)`, src, pages });
      }
    }
    if (wantedCodes) {
      for (const code of wantedCodes.map((c) => String(c).toUpperCase())) {
        if (delivered.has(code) || NEVER_FROM_TEMPLATE.has(code)) continue;
        if (!TEMPLATE_OK.has(code)) continue;
        const f = forms.find((x) => String(x.code || '').toUpperCase() === code);
        if (!f) { warnings.push(`the compliance list wants ${code}, the listing side did not send it, and the template does not have it`); continue; }
        dropIns.forms.push({ code, label: `${f.name || code} (template)`, src, pages: f.pages });
        if (code === 'LPD') notes.push('LPD added from our template: it is really the listing side\'s to provide, mention it to them');
      }
    }
  } else if (wantedCodes && wantedCodes.some((c) => !delivered.has(String(c).toUpperCase()) && !NEVER_FROM_TEMPLATE.has(String(c).toUpperCase()))) {
    warnings.push('no Audit Disclosures template in the deal folder: missing standard forms and our brokerage pages were not added');
  }

  // Seller reports saved in the deal folder.
  for (const f of pdfs.filter((x) => !x.inFx)) {
    if (OUR_OUTPUT.test(f.name) || NOT_A_SELLER_REPORT.test(f.name) || !REPORT.test(f.name)) continue;
    if (f === avid || f === agency || f === firmFile || /\(need s\)/i.test(f.name)) continue;
    // The planner warns about it unless the duplicate check finds it was delivered too.
    reports.push({ key: `d:${f.id}`, name: f.name, pages: f.pages, src: { type: 'drive', id: f.id, name: f.name }, fromDealFolder: true });
  }

  return { dropIns, reports, warnings, notes };
}

module.exports = { planDropIns, range };
