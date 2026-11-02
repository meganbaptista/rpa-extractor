// 2643 34th St, 2026-11-02 (placeholder names, no real deal data):
// 1. a prior sale's forms (signed 2018) are not reviewed as this seller's;
// 2. "no C.A.R. Form SOLAR is included" is dropped when the package has one.
const assert = require('node:assert');
const { _internal: I } = require('../netlify/functions/disclosure-intake-check-background.js');

const now = Date.UTC(2026, 10, 2);
const old = I.historicalFormCodes([
  { code: 'TDS', signed: '8/8/2018', seller: 'A Seller' },
  { code: 'SPQ', signed: '8/8/2018', seller: 'A Seller' },
  { code: 'WDO', signed: '', seller: '' },
], now);
assert.deepStrictEqual([...old].sort(), ['SPQ', 'TDS'], '2018 TDS and SPQ are a prior sale');
assert.strictEqual(old.has('WDO'), false, 'undated reads as current');
const mixed = I.historicalFormCodes([{ code: 'TDS', signed: '8/8/2018' }, { code: 'TDS', signed: '10/20/2026' }], now);
assert.strictEqual(mixed.has('TDS'), false, 'a current copy in the batch keeps the flags');

const present = new Set(['TDS', 'SPQ', 'SOLAR']);
const solar = { form: 'SPQ', item: '8B', reason: 'SPQ 8B is marked Yes for a solar power system, but no C.A.R. Form SOLAR is included in the package and the explanation describes a rooftop pool water heating structure' };
assert.strictEqual(I.claimsPresentFormMissing(solar, present), 'SOLAR');
assert.strictEqual(I.claimsPresentFormMissing(solar, new Set(['TDS', 'SPQ'])), '', 'really missing: kept');
assert.strictEqual(I.claimsPresentFormMissing({ reason: 'Form SOLAR is not included in this package' }, present), 'SOLAR');
assert.strictEqual(I.claimsPresentFormMissing({ reason: 'the location is left blank' }, present), '');
console.log('prior-sale-flags: ok');
