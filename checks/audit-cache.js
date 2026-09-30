// checks/audit-cache.js
//
// The same contract is audited once; a changed one, another firm's, or an
// audit after its prompt changed is audited fresh.   node checks/audit-cache.js

const { auditCacheKey, isExperiment, AUDIT_VERSION } = require('../netlify/functions/lib/audit-cache.js');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

const pdf = Buffer.from('%PDF-1.7 a contract packet').toString('base64');
const edited = Buffer.from('%PDF-1.7 a contract packet, corrected SMCO').toString('base64');

ok('the same bytes, the same key', auditCacheKey(pdf), auditCacheKey(pdf));
ok('a changed packet is audited fresh', auditCacheKey(pdf) === auditCacheKey(edited), false);
ok("another firm's identical packet is its own", auditCacheKey(pdf, 'firm-a') === auditCacheKey(pdf, 'firm-b'), false);
ok('no tenant is "default"', auditCacheKey(pdf).split(':')[1], 'default');
ok('the key carries the audit version', auditCacheKey(pdf).startsWith(`${AUDIT_VERSION}:`), true);
ok('a tenant id cannot smuggle a separator', auditCacheKey(pdf, 'a:b/c').split(':').length, 3);

ok('a plain run uses the cache', isExperiment({ uploadId: 'x', totalChunks: 1 }), false);
ok('manual overrides are an experiment', isExperiment({ overrides: { buyerCount: 3 } }), true);
ok('a prompt override is an experiment', isExperiment({ prompt_override: 'try this' }), true);
ok('empty overrides are not', isExperiment({ overrides: {} }), false);

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall audit-cache checks pass');
