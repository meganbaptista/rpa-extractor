// checks/brush-ask.js
//
// 86 Dornoch (2026-10-26): the 17G line reached the email as
// "SPQ 17G: The property is marked as a high fire hazard area," and nothing
// else, because reasonOf() cuts a second sentence starting "Please". Megan's
// wording is one question, and it asks the seller to confirm, not to change:
// "in my experience orange county does not have annual brush clearance".
//   node checks/brush-ask.js

const fs = require('fs');
const I = require('../netlify/functions/disclosure-intake-check-background.js')._internal;
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

const src = fs.readFileSync(require.resolve('../netlify/functions/disclosure-intake-check-background.js'), 'utf8');
const m = src.match(/const BRUSH_ASK = '([^']*)'\s*\+\s*'([^']*)';/);
ok('BRUSH_ASK found', !!m, true);
const ask = m ? m[1] + m[2] : '';
const line = I.reviseLineFor({ form: 'SPQ', item: '17G', issue: 'verify_mismatch', reason: ask });
ok('her wording, whole', line, 'SPQ 17G: The property is marked as a high fire hazard area, can you please confirm the seller is not required to complete annual brush clearance?');
ok('no ". Please" second sentence to be cut', /[.;,]\s*please\b/i.test(ask), false);
ok('ends in "?" without an added full stop', /\?$/.test(line) && !/\?\.$/.test(line), true);
ok('a plain verify line still gets its full stop', I.reviseLineFor({ form: 'TDS', item: 'II A', issue: 'verify_mismatch', reason: 'Confirm the 220 volt wiring location' }), 'TDS II A: Confirm the 220 volt wiring location.');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall brush-ask checks pass');
process.exit(failed ? 1 : 0);
