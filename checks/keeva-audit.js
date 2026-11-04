// The audit's summary for Keeva (2026-11-03). Placeholder values; no network.
const assert = require('node:assert');
const { auditSummary, postToKeeva } = require('../netlify/functions/lib/keeva-audit');
const s = auditSummary({
  payload: { overall_status: 'outstanding', summary: 'x', still_needed_lines: 'MCA\nSBSA', outdated_versions_lines: '', response_flags_lines: 'SPQ 5B: a\nTDS C1: b', verify_lines: 'NHD signature: check' },
  address: '1 Main St, Los Angeles, CA 90001', job: { id: 'j_1', source: { subject: 'Re: disclosures', from: 'agent@example.com' } }, effects: { draft: 'r123' },
});
assert.deepStrictEqual(s.stillNeeded, ['MCA', 'SBSA']);
assert.strictEqual(s.flags.length, 2);
assert.strictEqual(s.draftMade, true);
assert.strictEqual(auditSummary({ payload: {}, address: 'a', job: { id: 'j' }, effects: { draft: 'held: Drive link unread' } }).draftMade, false, 'a held draft is not a draft');
(async () => {
  delete process.env.KEEVA_AUDIT_KEY;
  assert.strictEqual(await postToKeeva(null, s, () => {}), false, 'no key: skipped, never thrown');
  console.log('keeva-audit: summary built, skipped without a key');
})().catch((e) => { console.error(e); process.exit(1); });
