// netlify/functions/lib/mime.js
//
// A raw RFC 822 email: an HTML body plus file attachments, for
// gmail.updateDraftRaw. Pure, so checks/buyer-email.js can parse what it builds.

const crypto = require('crypto');

const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n');

/** RFC 2047 for a header with non-ASCII ("Homeowner’s"), plain otherwise. */
function headerValue(v) {
  const s = String(v || '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/**
 * headers:     { To, Cc, Bcc, Subject, 'In-Reply-To', References } (blanks dropped)
 * html:        the body
 * attachments: [{ filename, contentType, data: Buffer }]
 */
function buildMime({ headers = {}, html = '', attachments = [] }) {
  const boundary = `----=_mtc_${crypto.randomBytes(12).toString('hex')}`;
  const lines = [];
  for (const [k, v] of Object.entries(headers)) {
    if (v && String(v).trim()) lines.push(`${k}: ${k === 'Subject' ? headerValue(v) : String(v).trim()}`);
  }
  lines.push('MIME-Version: 1.0');
  if (!attachments.length) {
    lines.push('Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '');
    lines.push(wrap76(Buffer.from(html, 'utf8').toString('base64')));
    return lines.join('\r\n');
  }
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '');
  lines.push(`--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '');
  lines.push(wrap76(Buffer.from(html, 'utf8').toString('base64')));
  // EVERY ATTACHMENT GETS ITS OWN ID. Without one, Gmail fills in a blank
  // "Content-ID: <>" on every attachment when the draft is sent. Gmail shows the
  // files by name, so it looks right to Megan, but Outlook, Apple Mail and many
  // office mail systems treat attachments with the same ID as ONE file: the
  // agent on 6051 Scenic Ave (2026-10-23) saw the last attachment, the prelim,
  // three times. (Her Zapier-drafted home warranty emails had the same blank IDs.)
  for (const a of attachments) {
    const name = String(a.filename || 'attachment').replace(/"/g, '');
    const id = `f_${crypto.randomBytes(8).toString('hex')}`;
    lines.push(`--${boundary}`,
      `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${id}>`,
      `X-Attachment-Id: ${id}`, '');
    lines.push(wrap76(Buffer.from(a.data).toString('base64')));
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

module.exports = { buildMime, headerValue };
