// checks/review-flag-rules.js: answers we never send back for revision.
// Megan, 2026-11-24 (2238 W 28th St): the Earthquake statement ("as long as
// they check the boxes we are fine. we look super AI doing that") and the
// "additional dwelling units" header box: still asked, but as ONE line naming the page 1 box.
const assert = require('assert');
const { isEarthquakeStatement: eq, isHeaderAduBox: adu, aduHeaderBox } = require('../netlify/functions/lib/intake-steps.js');
const { onePerQuestion } = require('../netlify/functions/lib/agent-voice.js');

for (const f of ['Earthquake', 'Residential Earthquake Risk Disclosure Statement', 'RERDS', 'EQ']) assert.ok(eq(f), f);
for (const f of ['TDS', 'SPQ', 'Environmental Hazards and Earthquake Safety Booklet Receipt']) assert.ok(!eq(f), f);

assert.ok(adu({ form: 'SPQ', item: 'additional dwelling units', reason: 'the TDS header box for a property with additional dwelling units is checked' }));
assert.ok(adu({ form: 'SPQ', item: 'ADU box', reason: 'the matching SPQ page 1 header box is unchecked' }));
assert.ok(!adu({ form: 'SPQ', item: '8E', reason: 'ADU built without a permit' }), 'the ADU answer itself is still reviewed');
assert.ok(!adu({ form: 'TDS', item: 'C12', reason: 'HPOZ noted' }));
// The two ADU header flags become ONE ask that names the box (Megan: "there is no reference to what question").
const two = [
  { form: 'SPQ', item: 'additional dwelling units', marked: 'blank', should_be: 'Yes', reason: 'the TDS header box ... is checked, and SPQ 8E discloses a permitted ADU', other_form: 'TDS' },
  { form: 'SPQ', item: 'ADU box', marked: 'blank', should_be: '', reason: 'the matching SPQ page 1 header box is unchecked', other_form: 'TDS' },
].map(aduHeaderBox);
const one = onePerQuestion(two);
assert.strictEqual(one.length, 1);
assert.strictEqual(one[0].item, 'page 1 "Additional Dwelling Units" box');
assert.strictEqual(one[0].should_be, 'checked');
console.log('review-flag-rules: Earthquake statement never chased; the ADU header box is one clear ask');
