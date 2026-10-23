// netlify/functions/lib/package-inputs.js
//
// What the buyer package needs to know about the DEAL, read from Megan's live
// compliance Doc (the same Doc the compliance writer keeps). Pure.
//
//   COMPLIANCE AUDIT LIST | 2647 E Wilson Ave, Orange, CA 92867
//   BROKER SYSTEM UPLOAD PLATFORM: COMPASS BUSINESS TRACKER
//   PURCHASE DOCUMENTS
//   * BRBC - followed up
//   DISCLOSURES
//   * WFDA
//   * Brokerage Affiliate Disclosures (If any) - Compass (Orange County Bayside)
//
//   wantedCodes    the DISCLOSURES lines' leading codes (the template drop-in
//                  allowlist decides which of these we may add ourselves)
//   contractItems  the PURCHASE DOCUMENTS lines still open: if one comes back
//                  inside the disclosures (Stillwater: FHDA, WFA, MCA, SIDE ABA)
//                  it is filed as "FX - <line>" instead of going in the package
//   brokerage      the buyer agent's brokerage: the "Brokerage Affiliate
//                  Disclosures - <firm>" line, else the platform line's first word

const HEADING = /^[A-Z][A-Z &/()-]{3,}:?$/;

function sections(docText) {
  const out = {};
  let cur = 'TOP';
  for (const raw of String(docText || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (HEADING.test(line) && !/^\*/.test(line)) { cur = line.replace(/:$/, '').trim(); out[cur] = out[cur] || []; continue; }
    if (/^[*•-]\s*/.test(line)) (out[cur] = out[cur] || []).push(line.replace(/^[*•-]\s*/, '').trim());
    else (out[cur] = out[cur] || []).push(line);
  }
  return out;
}

const codeOf = (line) => {
  const m = String(line).match(/^([A-Z]{2,6}(?:-[A-Z]{1,2})?)(?=[\s\-–:,(]|$)/);
  return m ? m[1] : '';
};

function contractItem(line) {
  const text = String(line).split(/\s+[-–]\s+/)[0].trim();     // drop "- followed up" notes
  const aba = text.match(/^([A-Za-z][A-Za-z&' ]*?)\s+ABA\b/);
  if (aba) return { code: 'ABA', brokerage: aba[1].trim(), name: `FX - ${text.toUpperCase()}` };
  const code = codeOf(text);
  if (!code) return null;
  return { code, name: `FX - ${text.toUpperCase()}` };
}

function parseCompliance(docText) {
  const s = sections(docText);
  const top = (s.TOP || []).join('\n');
  const platformLine = (top.match(/BROKER SYSTEM UPLOAD PLATFORM:\s*(.+)/i) || [])[1] || '';
  const disclosures = s.DISCLOSURES || [];
  const affiliate = disclosures.find((l) => /brokerage affiliate disclosures/i.test(l));
  const firm = affiliate && (affiliate.match(/[-–]\s*([A-Za-z][A-Za-z&' ]+?)(?:\s*\(|$)/) || [])[1];
  const brokerage = (firm || platformLine.split(/\s+/)[0] || '').trim();
  const purchase = (s['PURCHASE DOCUMENTS'] || []).map(contractItem).filter(Boolean);
  return {
    platform: platformLine.trim(),
    brokerage: brokerage ? brokerage[0].toUpperCase() + brokerage.slice(1).toLowerCase() : '',
    wantedCodes: [...new Set(disclosures.map(codeOf).filter(Boolean))],
    contractItems: purchase,
    disclosureLines: disclosures,
  };
}

module.exports = { parseCompliance, sections, contractItem };
