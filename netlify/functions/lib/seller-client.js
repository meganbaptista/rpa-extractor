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

/** "larry rutkowski <larry@x.com>" -> "larry"; falls back to the address's first word. */
function firstNameOf(header) {
  const display = String(header || '').replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  let w = '';
  if (display && !/@/.test(display)) {
    w = display.includes(',') ? display.split(',')[1].trim().split(/\s+/)[0] : display.split(/\s+/)[0];
  } else {
    w = (emailOf(header).split('@')[0] || '').split(/[._\d-]+/)[0];
  }
  w = String(w || '').toLowerCase().replace(/[^\p{L}'-]/gu, '');
  return w.length >= 2 ? w : '';
}

/** The names in a greeting line: "Hi Larry and Susan," -> "Larry and Susan". */
function greetingOf(text) {
  const m = String(text || '').match(/^\s*(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))\s+([^,\n!:]{2,80})/im);
  return m ? m[1] : '';
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
    /**
     * BEING ON THE EMAIL IS NOT ENOUGH; BEING GREETED IS. The listing AGENT is
     * often in the To line of our package email too: Shannon Parks (Anvil) was
     * proven a "seller client" and her buyer's mold report named "Seller
     * Report" (33852 Del Obispo, 2026-10-09). The package opens "Hi <seller>,",
     * so the sender's first name must be in that greeting. No readable
     * greeting = not proven (the classifier's clues still apply).
     */
    const first = firstNameOf(fromHeader);
    if (!first) return { seller: false };
    for (const hit of hits.slice(0, 3)) {
      let m;
      try { m = await gmail.getMessage(hit.id); } catch (e) { continue; }
      const greet = greetingOf(m.newestText || m.bodyText || '');
      if (greet && new RegExp(`\\b${first}\\b`, 'i').test(greet)) {
        const property = String((m.headers || {}).subject || '').split('|').slice(1).join('|').trim();
        return { seller: true, property };
      }
    }
    return { seller: false };
  } catch (e) {
    return { seller: false };
  }
}

module.exports = { sellerClientFor, emailOf, firstNameOf, greetingOf };
