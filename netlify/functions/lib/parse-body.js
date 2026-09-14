// ─── REQUEST BODY PARSING, WITH A DIAGNOSTIC ─────────────────────────────────
// Every handler in this repo parses its request body like this:
//
//     try { body = JSON.parse(event.body || '{}'); }
//     catch { console.error('[x] invalid JSON body'); return { statusCode: 400 }; }
//
// which cannot be debugged from the logs. It names the symptom and throws away
// every fact that would identify the cause, so all you get is a 3ms 400 with no
// other output — and the realistic causes need DIFFERENT fixes:
//
//   1. BASE64. Netlify sets event.isBase64Encoded and hands over base64 whenever
//      the request's Content-Type is not on its text allowlist. A Zapier "Custom
//      Request" with no Content-Type header, or any multipart post, arrives this
//      way, and JSON.parse fails on byte one. NOT a caller error: the JSON is
//      fine, it just has not been decoded yet.
//   2. FORM-ENCODED. Zapier's Webhooks POST action defaults Payload Type to
//      "Form", which sends a=1&b=2 rather than JSON. Also fixable here.
//   3. TRUNCATION. Netlify caps a function request body at roughly 6MB. Inline
//      base64 PDFs blow past that (which is why this function prefers document
//      URLs), and a cut-off body fails as an unterminated string — indis-
//      tinguishable from malformed JSON unless you look at the length.
//   4. A BAD INTERPOLATION. A hand-built JSON payload in Zapier's Data box with
//      a mapped field spliced into it breaks the moment that field contains a
//      double quote or a newline. Disclosure text contains both routinely: the
//      17G brush-clearance question alone has quotes around "Yes".
//
// So: decode 1 and 2 instead of failing on them, and when the body genuinely
// cannot be parsed, say which of 3 or 4 it is.

// How much of the body to echo into the log. Enough to recognise a payload and
// spot a truncation, short enough to stay readable and to keep a large base64
// document out of the log lines.
const ECHO = 140;

// Control characters that are illegal INSIDE a JSON string literal but that
// JSON.parse does NOT describe as such, so they need catching by inspection.
// Tab, LF and CR are excluded on purpose: they are legal WHITESPACE between
// tokens, so their mere presence proves nothing — and when one of them IS the
// problem (a multi-line Zapier field spliced into a string), V8 says so
// explicitly, which controlCharacter() below checks first. Written as escapes
// on purpose: the literal characters would be invisible in this source.
const RAW_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

// V8's wording for an unescaped newline/tab/control byte inside a string.
const CONTROL_ERROR = /bad control character|invalid control character|unescaped control/i;

// How much context to show either side of the position V8 reports. On a 50KB
// payload the first 140 characters say nothing about a break 40KB in, and the
// position alone is not something you can eyeball in Zapier's Data box.
const NEAR = 70;

// Netlify/AWS reject the request above ~6MB, but a body that arrives just under
// the wire can still have been cut short upstream. Treat anything in this range
// as truncation-suspicious when it also fails to parse.
const SIZE_SUSPICIOUS = 5.5 * 1024 * 1024;

function headerOf(event, name) {
  const headers = (event && event.headers) || {};
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return String(headers[key] || '');
  }
  return '';
}

// A one-line summary of what actually arrived, for the failure log.
function describe(raw, event, contentType) {
  const bits = [
    `${raw.length} chars`,
    `content-type=${contentType || '(none)'}`,
  ];
  if (event && event.isBase64Encoded) bits.push('isBase64Encoded=true');
  bits.push(`starts=${JSON.stringify(raw.slice(0, ECHO))}`);
  if (raw.length > ECHO * 2) bits.push(`ends=${JSON.stringify(raw.slice(-ECHO))}`);
  return bits.join(' | ');
}

// V8 reports the character offset where parsing broke. Quote the text around it
// with a caret, so the log shows the actual offending characters rather than
// leaving a number to be counted out by hand.
function nearPosition(raw, message) {
  const match = /position (\d+)/i.exec(message);
  if (!match) return '';
  const at = Number(match[1]);
  if (!Number.isFinite(at) || at > raw.length) return '';
  const from = Math.max(0, at - NEAR);
  const before = raw.slice(from, at);
  const after = raw.slice(at, at + NEAR);
  return ` near=${JSON.stringify(before)} >>HERE>> ${JSON.stringify(after)}`;
}

// Name the cause, not just the parse error. Order matters: truncation is checked
// before the generic "malformed" verdict because a truncated body throws the
// same class of error as a hand-mangled one.
function diagnose(raw, err, event, contentType) {
  const message = (err && err.message) || String(err);
  const truncated = /unexpected end of (?:json input|input)|unterminated string/i.test(message);
  let cause;

  if (truncated && raw.length >= SIZE_SUSPICIOUS) {
    cause = `BODY TRUNCATED at ${(raw.length / 1024 / 1024).toFixed(2)}MB — Netlify caps a function `
      + 'request body near 6MB. Send documents as fetchable urls instead of inline base64.';
  } else if (truncated) {
    cause = 'BODY ENDS MID-JSON — the caller sent an incomplete payload (a template that was cut '
      + 'off, or a stream that closed early).';
  } else if (CONTROL_ERROR.test(message) || RAW_CONTROL.test(raw)) {
    cause = 'RAW CONTROL CHARACTER inside a JSON string — almost always a multi-line value spliced '
      + 'into a hand-built payload. Escape the newlines, or build the payload from mapped fields '
      + 'rather than by hand.';
  } else if (/^[^[{"]/.test(raw)) {
    cause = 'BODY IS NOT JSON — it does not even begin with { or [. Check the caller is posting a '
      + 'JSON payload (Zapier: Payload Type = Json) and not form or plain text.';
  } else {
    cause = 'MALFORMED JSON — most often an unescaped double quote from an interpolated field.';
  }

  return `${cause} [JSON.parse: ${message}]${nearPosition(raw, message)} `
    + describe(raw, event, contentType);
}

// Zapier's "Form" payload type, and anything else that posts a=1&b=2.
// Two shapes show up in practice:
//   payload={"a":1}   a single field holding the real JSON
//   {"a":1}=          raw JSON pasted into the Data box's NAME column
// Both are recoverable. Otherwise the decoded fields are returned as the body,
// which is what a genuinely form-based caller meant to send.
function parseFormEncoded(raw) {
  const params = new URLSearchParams(raw);
  const entries = [...params.entries()];
  if (entries.length === 0) return null;

  if (entries.length === 1) {
    const [key, value] = entries[0];
    for (const candidate of [value, key]) {
      const text = String(candidate || '').trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        try {
          return { body: JSON.parse(text), note: 'body arrived form-encoded, recovered the JSON from it' };
        } catch { /* fall through to the flat-fields reading below */ }
      }
    }
  }

  const fields = {};
  for (const [key, value] of entries) fields[key] = value;
  return { body: fields, note: `body arrived form-encoded, read ${entries.length} flat field(s)` };
}

/**
 * Parse a Netlify function request body.
 *
 * Returns { ok: true, body, note } — note is a non-empty string only when the
 * body needed recovering (base64 or form-encoded), so it is worth logging.
 * Returns { ok: false, diagnostic } when it cannot be parsed; the diagnostic
 * names the likely cause and echoes what arrived. Log it and return 400.
 *
 * Never throws.
 */
function parseRequestBody(event) {
  const contentType = headerOf(event, 'content-type');
  const notes = [];

  let raw = (event && event.body) || '';
  if (typeof raw !== 'string') raw = String(raw);

  // Netlify hands over base64 whenever the content type is not recognised as
  // text. Decoding is the whole fix for that case.
  //
  // The /^[[{]/ guard is deliberate. base64-decoding a body that is ALREADY
  // readable JSON produces non-empty binary garbage rather than an error, so an
  // over-eager or mis-set isBase64Encoded flag would corrupt a perfectly good
  // payload and report it as malformed. JSON never starts with anything but
  // { or [, and neither is valid as the first character of base64, so this
  // cannot mistake real base64 for JSON.
  if (event && event.isBase64Encoded && raw && !/^\s*[[{]/.test(raw)) {
    let decoded;
    try {
      decoded = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      decoded = '';
    }
    // Buffer.from is famously lenient: it does not throw on non-base64, it
    // silently skips the bad characters. So verify the decode produced
    // something plausible rather than trusting that it did not throw.
    if (!decoded.trim()) {
      return {
        ok: false,
        diagnostic: 'isBase64Encoded=true but the body did not base64-decode to anything. '
          + describe(raw, event, contentType),
      };
    }
    raw = decoded;
    notes.push('body arrived base64-encoded (no JSON content-type on the request), decoded it');
  }

  // A UTF-8 BOM ahead of the "{" is invalid JSON and invisible in any log.
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
    notes.push('stripped a UTF-8 BOM from the body');
  }

  raw = raw.trim();
  if (!raw) return { ok: true, body: {}, note: '' };

  if (/application\/x-www-form-urlencoded/i.test(contentType)
      || (!/^[[{]/.test(raw) && /^[^=&\s]+=/.test(raw))) {
    const recovered = parseFormEncoded(raw);
    if (recovered) {
      notes.push(recovered.note);
      return { ok: true, body: recovered.body, note: notes.join('; ') };
    }
  }

  try {
    const body = JSON.parse(raw);
    // JSON.parse("null") and JSON.parse("4") both succeed and neither is a
    // payload. Destructuring null throws, so reject it here rather than three
    // frames deeper with a useless stack.
    if (!body || typeof body !== 'object') {
      return {
        ok: false,
        diagnostic: `body parsed but is ${body === null ? 'null' : typeof body}, not an object. `
          + describe(raw, event, contentType),
      };
    }
    return { ok: true, body, note: notes.join('; ') };
  } catch (err) {
    return { ok: false, diagnostic: diagnose(raw, err, event, contentType) };
  }
}

module.exports = { parseRequestBody };
