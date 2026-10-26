// checks/broker-signature.js
//
// 1407 Santanella (2026-10-26): "the system marks the ABA as FX even if we are
// missing the broker signature". The audit DID report the broker (BR) as
// required and absent; the splitter's signer mapping had no entry for BR, so it
// was dropped from both lists and the ABA filed FX.
//   node checks/broker-signature.js

const S = require('../netlify/functions/disclosure-split-background.js')._internal;
const DA = require('../netlify/functions/lib/document-audit.js')._internal;
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

// The real Santanella read.
const lines = [
  { label: 'Agent for Broker 1', signed: true }, { label: 'Agent for Broker 2', signed: true },
  { label: 'By (Broker/Office Manager)', signed: false }, { label: 'By (Broker/Office Manager)', signed: false },
  { label: 'Seller', signed: true }, { label: 'Seller', signed: false },
  { label: 'Buyer', signed: true }, { label: 'Buyer', signed: true },
];
const r = DA.resolveSigners({ name: 'Additional Broker Acknowledgement and Addendum', signature_lines: lines, required_signers: ['LA', 'S', 'B', 'BR'], present_signers: ['LA', 'S', 'B'] }, 'ABA');
ok('broker is required', r.required_signers.includes('BR'), true);
ok('broker is not present', r.present_signers.includes('BR'), false);
ok('the ABA files NeedBroker(s), not FX', S.statusSuffix({ code: 'ABA', name: 'Additional Broker Acknowledgement', ...r }), 'NeedBroker(s)');
ok('BR survives normalizing', S.normSigners(['B', 'S', 'LA', 'BR']).join(), 'B,S,LA,BR');

// The model wrongly calls the broker present while a broker line is blank.
const r2 = DA.resolveSigners({ name: 'Additional Broker Acknowledgement and Addendum', signature_lines: lines, required_signers: ['LA', 'S', 'B', 'BR'], present_signers: ['LA', 'S', 'B', 'BR'] }, 'ABA');
ok('a blank broker line overrules "present"', r2.present_signers.includes('BR'), false);

// Both brokers signed: FX.
const signedAll = lines.map((l) => ({ ...l, signed: /seller/i.test(l.label) && l === lines[5] ? true : true }));
const r3 = DA.resolveSigners({ name: 'Additional Broker Acknowledgement and Addendum', signature_lines: signedAll, required_signers: ['LA', 'S', 'B', 'BR'], present_signers: ['LA', 'S', 'B', 'BR'] }, 'ABA');
ok('everyone signed, brokers too: FX', S.statusSuffix({ code: 'ABA', name: 'Additional Broker Acknowledgement', ...r3 }), 'FX');

// Broker plus another party missing.
const r4 = DA.resolveSigners({ name: 'Additional Broker Acknowledgement and Addendum', signature_lines: lines, required_signers: ['LA', 'S', 'B', 'BR'], present_signers: ['LA', 'B'] }, 'ABA');
ok('seller and broker missing', S.statusSuffix({ code: 'ABA', name: 'x', ...r4 }), 'NeedSS+Broker(s)');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall broker-signature checks pass');
process.exit(failed ? 1 : 0);
