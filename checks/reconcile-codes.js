// checks/reconcile-codes.js
//
// The reconcile step must never tell Megan a compliance-list code is "not a
// standard CAR form code" (12273 Donald Reed, 2026-10-23: BHAA, the Buyer's
// Homeowners' Association Advisory). The prompt carries a glossary; this is
// the backstop.
//   node checks/reconcile-codes.js

const I = require('../netlify/functions/disclosure-intake-check-background.js')._internal;

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

const out = I.rewriteCodeRemarks([
  { item: 'BHAA', note: "'BHAA' is not a standard CAR form code." },
  { item: 'PSD', note: 'PSD is an unrecognized form code' },
  { item: 'SPQ 7E', note: 'Yes, pre-1978 build' },
]);
ok('a remark about the code becomes a usable check', out[0].note, 'could not match this to a received form; check by hand whether it arrived');
ok('"unrecognized form code" too', out[1].note, out[0].note);
ok('a real verify note is untouched', out[2], { item: 'SPQ 7E', note: 'Yes, pre-1978 build' });
for (const code of ['BHAA', 'WFDA', 'PSD', 'RCSD', 'TA', 'FHDS', 'DSDT', 'WHSD', 'AAA', 'ABA']) {
  ok(`the glossary explains ${code}`, new RegExp(`\\b${code}\\b`).test(I.LIST_CODE_GLOSSARY), true);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall reconcile-codes checks pass');
process.exit(failed ? 1 : 0);
