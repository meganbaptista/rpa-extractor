// Keeva's side for an email subject (2026-11-19): matched like the sheet,
// two of our deals at one address with different sides = 'both', failure = null.
const assert = require('assert');
const deals = [
  { address: '25732 Via Viento, Mission Viejo, CA 92691', side: 'buyer' },
  { address: '1635 N Ogden Dr, Los Angeles, CA 90046', side: 'buyer' },
  { address: '1635 N Ogden Dr, Los Angeles, CA 90046', side: 'seller' },
  { address: '1419 Pacific Ave, Venice, CA', side: 'seller' },
];
let calls = 0;
global.fetch = async (url, opts) => {
  calls++;
  assert.ok(/deal-side\?all=1$/.test(url), url);
  assert.strictEqual(opts.headers['x-keeva-audit-key'], 'k');
  return { ok: true, json: async () => ({ deals }) };
};
const store = { get: async () => ({ key: 'k' }) };
const { keevaSideForSubject: side } = require('./../netlify/functions/lib/deal-side.js');
(async () => {
  assert.strictEqual(await side('Fwd: Your Inspection Report (25732 Via Viento, Mission Viejo, CA 92691)', store), 'buyer');
  assert.strictEqual(await side('RE: 1635 N Ogden Dr - docs', store), 'both');
  assert.strictEqual(await side('419 Pacific update', store), null, 'whole-token match only');
  assert.strictEqual(await side('no address here', store), null);
  assert.strictEqual(calls, 1, 'held for 10 minutes');
  console.log('router-keeva-side: ok');
})().catch((e) => { console.error(e); process.exit(1); });
