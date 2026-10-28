// netlify/functions/lib/revision-local.js
//
// LOCAL AREA DISCLOSURES FROM OUR OWN PACKAGE (Megan, 2026-10-26, 2506
// Westminster: "moving forward, we can always just add the OC local area from
// our own package"; 2026-10-27: yes, except a local form that needs the
// seller's answers). When a revision still has the local area disclosures
// open, the revision step takes them from the deal's Audit Disclosures
// template (printed with THIS property's address), appends them to the
// revised PDF, gives them a line in the buyer email, and leaves them off the
// follow-up to the listing side.
//
// NEVER for a form the SELLER fills in (Keeva's local-disclosure registry):
// Santa Clarita / SCV (and the Antelope Valley form it replaced) has seller
// paragraphs, Santa Monica's stormwater (BMP) form has 9 seller questions.
// Those stay a request to the listing side.

const SELLER_FILLS = /santa\s*clarita|\bscv\b|antelope\s*valley|santa\s*monica/i;
const RX_LOCAL = /local\s+area\s+disclosures?/i;

/** The open items we can add ourselves, and the ones that stay a request. */
function localItems(items) {
  const open = (items || []).filter((v) => v.status === 'open' && RX_LOCAL.test(String(v.item || '')));
  return { ours: open.filter((v) => !SELLER_FILLS.test(v.item)), theirs: open.filter((v) => SELLER_FILLS.test(v.item)) };
}

/** "Orange County Local Area Disclosures" -> "The Orange County local area disclosures, for your review and signature." */
function buyerLine(item) {
  const region = String(item || '').replace(/[-–:].*$/, '').replace(RX_LOCAL, '').replace(/\s+/g, ' ').trim();
  return `The ${region ? `${region} ` : ''}local area disclosures, for your review and signature.`;
}

/**
 * The local area pages in a PDF: by page text (a run starting at a page that
 * names "LOCAL AREA DISCLOSURES", continuing while pages carry it, which the
 * form's footer does on every page), else by the page reader's map.
 *   texts: [{ num, text }]; formPages: [{ name, pages }] | null
 */
function localPages(texts, formPages) {
  // The form prints "LOCAL AREA DISCLOSURES" in capitals on every page (title
  // and footer); the SBSA's "Local Disclosures and Advisories" text must not count.
  const hits = (texts || []).filter((t) => /LOCAL AREA DISCLOSURES/.test(String(t.text || ''))).map((t) => t.num).sort((a, b) => a - b);
  if (hits.length) {
    const run = [hits[0]];
    for (const p of hits.slice(1)) { if (p === run[run.length - 1] + 1) run.push(p); else break; }
    return run;
  }
  const f = (formPages || []).find((x) => RX_LOCAL.test(String(x.name || '')) && !SELLER_FILLS.test(String(x.name || '')));
  return f ? [...f.pages] : [];
}

/**
 * Find them in the deal folder's Audit Disclosures template. deps: { drive,
 * findDealFolder, pageTexts, strips, pickPages, render }. Returns
 * { bytes, pages, source } or null (with why) when they cannot be found.
 */
async function fromOurPackage(address, deps) {
  const deal = await deps.findDealFolder(deps.drive, address);
  if (!deal || !deal.folder) return { why: 'no deal folder found' };
  const tpl = deal.files.filter((f) => /^audit disclosures/i.test(String(f.name || '')))
    .sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')))[0];
  if (!tpl) return { why: 'no Audit Disclosures template in the deal folder' };
  const buf = await deps.drive.download(tpl.id);
  const texts = await deps.pageTexts(buf).catch(() => []);
  let pages = localPages(texts, null);
  if (!pages.length && deps.strips) {
    const n = (texts && texts.length) || 0;
    const rows = await deps.strips.readAllStrips(buf, n || (await deps.pageCount(buf)), tpl.name);
    const formPages = deps.strips.documentsFromStrips(rows.filter((r) => !r.unread)).map((d) => ({ name: d.title || d.carCode || d.footerName || '', pages: d.pages }));
    pages = localPages([], formPages);
  }
  if (!pages.length) return { why: `no local area disclosures found in ${tpl.name}` };
  return { bytes: await deps.pickPages(buf, pages, { render: deps.render }), pages: pages.length, source: `${tpl.name} pages ${pages[0]}-${pages[pages.length - 1]}` };
}

module.exports = { localItems, buyerLine, localPages, fromOurPackage, SELLER_FILLS };
