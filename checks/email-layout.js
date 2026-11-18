// checks/email-layout.js
//
// Every drafted email starts at the top and has one blank line before the
// signature (Megan, 2026-11-17: "my biggest gripe with AI emails, they format
// the first line so far down"; "make sure this edit is done on ALL drafted
// emails").
//   node checks/email-layout.js

const { flushTop, trimEnd, trimStart } = require('../netlify/functions/lib/email-layout.js');
const { buildMime } = require('../netlify/functions/lib/mime.js');
const { withSignature } = require('../netlify/functions/lib/signature.js');
const fs = require('fs');
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}:\n  got  ${got}\n  want ${want}`); } else console.log(`pass  ${label}`); }

ok('first paragraph flush, rest untouched',
  flushTop('<p style="font-family:Arial">Hello Team!</p><p>More</p>'),
  '<p style="margin-top:0;font-family:Arial">Hello Team!</p><p>More</p>');
ok('empty lines at the top dropped', flushTop('<br>\n<p>&nbsp;</p><p>Hi</p>'), '<p style="margin-top:0">Hi</p>');
ok('inside a wrapper', flushTop('<div dir="ltr"><p>Hi</p></div>'), '<div dir="ltr"><p style="margin-top:0">Hi</p></div>');
ok('idempotent', flushTop(flushTop('<p>Hi</p>')), '<p style="margin-top:0">Hi</p>');
ok('text at the top left alone', flushTop('Hi there<p>x</p>'), 'Hi there<p>x</p>');
ok('trailing blank lines trimmed', trimEnd('<p>Thanks</p><br><br><p>&nbsp;</p>\n'), '<p>Thanks</p>');
ok('leading signature blanks trimmed', trimStart('<div dir="ltr"><br><br>Megan</div>'), '<div dir="ltr">Megan</div>');

const signed = withSignature('<br><p>Hello Team!</p><p>Thanks</p><br><br>', '<div>Megan</div>');
ok('withSignature: flush top, no stacked blank lines', signed, '<p style="margin-top:0">Hello Team!</p><p>Thanks</p>\n<br>-- <br><div>Megan</div>');

const raw = buildMime({ headers: { To: 'a@b.com', Subject: 'x' }, html: '<p>Hello</p>' });
const body = Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
ok('buildMime flushes the top', body, '<p style="margin-top:0">Hello</p>');

const gmailSrc = fs.readFileSync(require.resolve('../netlify/functions/lib/gmail.js'), 'utf8');
ok('gmail.createDraft flushes the top', /flushTop\(htmlBody\)/.test(gmailSrc), true);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nemail layout: all drafted emails start at the top, one blank line before the signature');
