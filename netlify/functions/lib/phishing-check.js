// netlify/functions/lib/phishing-check.js
//
// ============================================================================
// "DON'T CLICK THIS" — a warning label for emails whose LINKS look like phishing.
// ============================================================================
// Megan, 2026-10-09: her parents' company was hacked, and spam that looks like
// escrow mail lands in the inbox for someone to click. She wants the router to
// flag those so Belle does not "willy nilly click into them", mostly the ones
// with links. She ruled OUT the "property is not one of our deals" signal: on
// opening emails it would be wrong too often.
//
// Pure: takes the router's message (headers, html body, attachments) and returns
// { suspicious, reasons }. No network, no model call, so it costs nothing and
// is testable with plain objects. It never deletes or moves anything; the
// router only ADDS a label and keeps the email unread and in the queue.
//
// STRONG signs flag on their own. WEAK signs (common in real marketing mail)
// only flag in pairs, which keeps newsletters and Zillow alerts from crying
// wolf.
// ============================================================================

/** Redirect wrappers mail gateways put around every link. Unwrapped first. */
function unwrap(href) {
  let u = String(href || '').trim();
  for (let i = 0; i < 3; i++) {
    let next = u;
    try {
      const url = new URL(u);
      const host = url.hostname.toLowerCase();
      if (/safelinks\.protection\.outlook\.com$/.test(host) && url.searchParams.get('url')) {
        next = url.searchParams.get('url');
      } else if (/^(www\.)?google\.[a-z.]+$/.test(host) && url.pathname === '/url') {
        next = url.searchParams.get('q') || url.searchParams.get('url') || u;
      } else if (/urldefense\.proofpoint\.com$/.test(host) && url.searchParams.get('u')) {
        // Proofpoint v2: "-" is "%", "_" is "/".
        next = decodeURIComponent(url.searchParams.get('u').replace(/-/g, '%').replace(/_/g, '/'));
      } else if (/urldefense\.com$/.test(host) && /\/v3\/__/.test(url.pathname + url.search)) {
        const m = (url.pathname + url.search).match(/\/v3\/__(.+?)__;/);
        if (m) next = m[1];
      }
    } catch (e) { return u; }
    if (next === u) break;
    u = next;
  }
  return u;
}

function hostOf(href) {
  try { return new URL(href).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; }
}

/** "mail.docusign.net" -> "docusign.net"; keeps two labels for co.uk-style TLDs. */
function baseDomain(host) {
  const parts = String(host || '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const twoLevel = /^(co|com|org|net|gov|ac)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2;
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

/** Every <a href> in the html, with its visible text. */
function linksOf(html) {
  const out = [];
  const re = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = m[2].replace(/&amp;/g, '&').trim();
    if (!/^https?:/i.test(href)) continue;
    const text = m[3].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    out.push({ href, real: unwrap(href), text });
  }
  return out;
}

// Click-tracking services legitimate newsletters route every link through. A
// visible "zillow.com" that really goes to one of these is normal, not a trick.
const CLICK_TRACKERS = /(^|\.)(list-manage\.com|sendgrid\.net|mandrillapp\.com|hubspotlinks\.com|hs-sites\.com|hubspotemail\.net|rs6\.net|mailgun\.org|mailchimp\.com|mcusercontent\.com|exacttarget\.com|klaviyo\.com|sparkpostmail\.com|cmail\d*\.com|createsend\d*\.com|mjt\.lu|awstrack\.me|ct\.sendgrid\.net|lnks?\.gd|e2ma\.net|constantcontact\.com|mailjet\.com|postmarkapp\.com|salesforce\.com|pardot\.com|marketo\.com|mktoweb\.com|bombbomb\.com|follow-up-boss\.com|followupboss\.com|kvcore\.com|boomtownroi\.com)$/i;

// Endings a shown web address actually uses. Anything else ("My.TC.Concierge")
// is a name with dots in it, not a site.
const REAL_TLD = /\.(com|net|org|edu|gov|us|io|co|biz|info|me|app|ai|realty|realtor|homes|house|properties|estate|law|legal|title|bank|ca|uk|co\.uk|de|mx|tv|ly|gl|ms|link|site|online|top|xyz|click|zip|mov)$/i;

// Short links hide where they go.
const SHORTENERS = /^(bit\.ly|tinyurl\.com|t\.ly|rebrand\.ly|ow\.ly|is\.gd|cutt\.ly|shorturl\.at|rb\.gy|buff\.ly|tiny\.cc|s\.id|v\.gd|qrco\.de|shorturl\.com)$/i;

// Free hosting and form builders that phishing pages live on. Real escrow,
// title and DocuSign mail does not send you to these.
const FREE_HOSTING = /(^|\.)(firebaseapp\.com|web\.app|pages\.dev|workers\.dev|glitch\.me|weebly\.com|wixsite\.com|godaddysites\.com|squarespace\.com|ngrok\.io|ngrok-free\.app|r2\.dev|blob\.core\.windows\.net|azurewebsites\.net|herokuapp\.com|netlify\.app|vercel\.app|github\.io|000webhostapp\.com|ipfs\.io|dweb\.link|forms\.gle|jotform\.com|typeform\.com|notion\.site|canva\.site|sites\.google\.com|my\.canva\.site|linktr\.ee|surveymonkey\.com)$/i;

// Brands phishing borrows, and the domains their real links live on.
const BRANDS = [
  { name: 'DocuSign', words: /docu\s*sign/i, domains: /(^|\.)(docusign\.(com|net))$/i },
  { name: 'Dropbox', words: /dropbox/i, domains: /(^|\.)(dropbox\.com|dropboxusercontent\.com|db\.tt)$/i },
  { name: 'Microsoft / OneDrive / SharePoint', words: /onedrive|sharepoint|office\s*365|microsoft\s*365|outlook\s+web/i, domains: /(^|\.)(microsoft\.com|sharepoint\.com|onedrive\.live\.com|1drv\.ms|live\.com|office\.com|microsoftonline\.com|office365\.com)$/i },
  { name: 'Adobe', words: /adobe\s*(sign|acrobat|document\s*cloud|pdf)/i, domains: /(^|\.)(adobe\.com|adobesign\.com|echosign\.com|acrobat\.com)$/i },
  { name: 'Google Drive', words: /google\s*(drive|docs)/i, domains: /(^|\.)(google\.com|drive\.google\.com|docs\.google\.com|goo\.gl)$/i },
  { name: 'Dotloop', words: /dotloop/i, domains: /(^|\.)dotloop\.com$/i },
  { name: 'Skyslope', words: /skyslope/i, domains: /(^|\.)skyslope\.com$/i },
  { name: 'Qualia', words: /\bqualia\b/i, domains: /(^|\.)(qualia\.com|qualia\.io)$/i },
  { name: 'CertifID', words: /certifid/i, domains: /(^|\.)certifid\.com$/i },
];

// The words on a button that gets you to a document or a login.
const CTA = /\b(view|review|open|access|download|sign|see|get|retrieve|read)\b.{0,25}\b(document|file|folder|pdf|message|envelope|invoice|statement|attachment|docs?)s?\b|^\s*(view|review|open|access|download|sign\s+now|log\s*in|sign\s*in|verify)\b/i;

// "You have a document waiting, click to view" style wording.
const LURE = /\b(view|open|access|review)\s+(the\s+)?(secure\s+)?(document|file|message|attachment|pdf|invoice|statement)s?\b|\bshared\s+(a\s+)?(file|document|folder)\s+with\s+you\b|\bsecure(d)?\s+(message|document|file|portal)\b|\b(new\s+)?voice\s*-?\s*mail\b|\bclick\s+(here|below)\s+to\s+(view|open|access|download|sign|review)\b|\bdocument\s+(is\s+)?(ready|waiting|pending)\s+(for\s+)?(your\s+)?(review|signature)\b|\bverify\s+your\s+(account|email|identity|mailbox)\b|\bpassword\s+(expires?|expired|reset)\b|\bmailbox\s+(is\s+)?(full|storage)\b/i;

const MONEY = /\bwir(e|ing)\s+(instructions?|transfer|funds|details)\b|\b(updated|new|changed|revised)\s+(bank(ing)?|wire|account)\s+(details|info(rmation)?|instructions)\b/i;

const DANGEROUS_ATTACHMENT = /\.(html?|shtml|svg|xhtml|hta|js|vbs|wsf|exe|scr|bat|cmd|iso|img|lnk|one)$/i;

/** The domain of an address in a header: "Amy <amy@abc.com>" -> "abc.com". */
function addrDomain(header) {
  const m = String(header || '').match(/@([A-Za-z0-9.-]+)/);
  return m ? baseDomain(m[1].toLowerCase()) : '';
}

/** The newest message only: Gmail and Outlook quoted history is dropped, so an
 * old message in the thread cannot flag the new one. */
function newestHtml(html) {
  let s = String(html || '');
  const cuts = [/<div[^>]+class="[^"]*gmail_quote/i, /<blockquote\b/i, /<div[^>]+id="(divRplyFwdMsg|appendonsend)"/i, /<hr[^>]*>\s*<div[^>]*>\s*<font[^>]*>\s*<b>From:/i];
  let cut = s.length;
  for (const re of cuts) { const m = s.match(re); if (m && m.index < cut) cut = m.index; }
  return s.slice(0, cut);
}

// Our own outgoing mail (reminders, Zaps sending as Megan) is never phishing to us.
const OWN_DOMAINS = String(process.env.ROUTER_OWN_DOMAINS || 'mytcconcierge.com')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

function check(message) {
  const h = (message && message.headers) || {};
  if (OWN_DOMAINS.includes(addrDomain(h.from))) return { suspicious: false, reasons: [], strong: [], weak: [] };
  const html = newestHtml((message && message.bodyHtml) || '');
  const text = `${h.subject || ''}\n${(message && message.newestText) || (message && message.bodyText) || ''}`;
  const strong = [];
  const weak = [];
  const fromDomain = addrDomain(h.from);

  const links = linksOf(html);
  // Plain-text mail has no <a> tags; its bare URLs still count for the host checks.
  if (!links.length) {
    for (const m of String((message && message.bodyText) || '').matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
      links.push({ href: m[0], real: unwrap(m[0]), text: '' });
    }
  }

  for (const l of links) {
    const host = hostOf(l.real);
    if (!host) continue;
    const base = baseDomain(host);

    // A link that SAYS one site and GOES to another. The strongest sign there is.
    // Only text that really reads as a web address: "www.", "http", or a known
    // ending. Megan's signature "@My.TC.Concierge" (her Instagram handle) was
    // read as the domain "tc.concierge" and her own email got flagged.
    const shown = l.text.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/\S*)?\b/i);
    const looksLikeAddress = shown && (/^(https?:\/\/|www\.)/i.test(l.text.trim()) || REAL_TLD.test(shown[1]));
    if (looksLikeAddress && !/@/.test(l.text)) {
      const shownBase = baseDomain(shown[1].toLowerCase().replace(/^www\./, ''));
      if (shownBase && base && shownBase !== base && !CLICK_TRACKERS.test(host)) {
        strong.push(`a link shows "${shown[1]}" but actually goes to ${host}`);
      }
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) strong.push(`a link goes to a bare IP address (${host})`);
    if (/(^|\.)xn--/.test(host)) strong.push(`a link uses a disguised look-alike domain (${host})`);
    if (/\.(zip|mov|top|xyz|click|country|gq|tk|ml|cf|ga|rest|cam)$/i.test(host)) weak.push(`a link goes to an unusual domain (${host})`);
    if (SHORTENERS.test(host)) weak.push(`a link is shortened (${host}), so you cannot see where it goes`);
    if (FREE_HOSTING.test(host)) weak.push(`a link goes to free web hosting (${host}), where fake login pages usually live`);
  }

  // Borrowing a brand: the email talks DocuSign / Dropbox / OneDrive, and the
  // BUTTON ("Review Document", "View File") goes somewhere else. Only the button
  // counts: an escrow officer writing "I'll send it by DocuSign" above a
  // signature full of her own company's links is normal.
  for (const b of BRANDS) {
    if (!b.words.test(text) || b.domains.test(fromDomain)) continue;
    for (const l of links) {
      if (!CTA.test(l.text)) continue;
      const host = hostOf(l.real);
      if (!host || CLICK_TRACKERS.test(host) || b.domains.test(host)) continue;
      strong.push(`it says ${b.name}, but its "${l.text.slice(0, 40)}" button goes to ${host}`);
      break;
    }
  }

  if (links.length && LURE.test(text)) {
    const attached = ((message && message.attachments) || []).length > 0;
    weak.push(attached ? 'it asks you to click to view a document' : 'it asks you to click to view a document, and nothing is attached');
  }
  if (links.length && MONEY.test(text)) weak.push('it mentions wiring money or changed bank details');

  for (const a of (message && message.attachments) || []) {
    if (DANGEROUS_ATTACHMENT.test(a.filename || '')) strong.push(`attachment "${a.filename}" is a file type used to deliver fake login pages or malware`);
  }

  // Gmail's own sender checks.
  const auth = String(h['authentication-results'] || '');
  if (/\bdmarc=fail\b/i.test(auth)) strong.push('Gmail could not verify the sender (DMARC failed), so the From address may be faked');
  else if (/\bspf=fail\b/i.test(auth) && !/\bdkim=pass\b/i.test(auth)) weak.push('Gmail could not fully verify the sender');

  const replyDomain = addrDomain(h['reply-to']);
  if (links.length && replyDomain && fromDomain && replyDomain !== fromDomain) {
    weak.push(`replies would go to ${replyDomain}, not the sender's ${fromDomain}`);
  }

  const reasons = [...new Set(strong)].concat([...new Set(weak)]);
  const suspicious = strong.length > 0 || new Set(weak).size >= 2;
  return { suspicious, reasons: suspicious ? reasons : [], strong: [...new Set(strong)], weak: [...new Set(weak)] };
}

module.exports = { check, unwrap, linksOf, baseDomain };
