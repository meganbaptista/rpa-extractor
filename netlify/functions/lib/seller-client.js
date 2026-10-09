// netlify/functions/lib/seller-client.js
//
// ============================================================================
// IS THIS SENDER ONE OF OUR SELLER CLIENTS? Proof, not a guess.
// ============================================================================
// Megan, 2026-10-09: a seller's own reports and records belong with Ethan, and
// "how will it know its the seller client?" Every seller gets our "Seller
// Disclosure Package | <address>" email, so an address we sent that email TO
// is a seller client, and the subject names the property. One Gmail search, no
// model call. An address we never sent it to falls back to the classifier's
// clues (personal email, forwarded from their own inbox, ...).
// ============================================================================

const OWN_DOMAINS = String(process.env.ROUTER_OWN_DOMAINS || 'mytcconcierge.com')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
// Subjects of emails we only ever send TO a seller client. NOT "Seller Signed
// Disclosures": on a seller deal that one goes to the BUYER's side, and would
// make every buyer's agent look like a seller. Add others only once confirmed
// seller-only: SELLER_PACKAGE_SUBJECTS="a|b".
const PACKAGE_SUBJECTS = String(process.env.SELLER_PACKAGE_SUBJECTS || 'Seller Disclosure Package')
  .split('|').map((x) => x.trim()).filter(Boolean);

/** "Larry <larry@x.com>" -> "larry@x.com". */
function emailOf(header) {
  const m = String(header || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : '';
}

/**
 * { seller: true, property } when we have sent this address a Seller
 * Disclosure Package; { seller: false } otherwise (or on any error).
 */
async function sellerClientFor(fromHeader, deps = {}) {
  const gmail = deps.gmail || require('./gmail');
  const addr = emailOf(fromHeader);
  if (!addr || OWN_DOMAINS.some((d) => addr.endsWith(`@${d}`))) return { seller: false };
  try {
    const from = OWN_DOMAINS.map((d) => `from:${d}`).join(' OR ');
    const subj = PACKAGE_SUBJECTS.map((x) => `subject:"${x}"`).join(' OR ');
    const q = `(${from}) to:${addr} (${subj})`;
    const hits = await gmail.listMessages({ q, maxPages: 1, pageSize: 5 });
    if (!hits.length) return { seller: false };
    let property = '';
    try {
      const m = await gmail.getMessage(hits[0].id);
      property = String((m.headers || {}).subject || '').split('|').slice(1).join('|').trim();
    } catch (e) { /* the address alone is the proof */ }
    return { seller: true, property };
  } catch (e) {
    return { seller: false };
  }
}

module.exports = { sellerClientFor, emailOf };
