// checks/wilson-rules.js
//
// Megan's cuts from the 2647 E Wilson email to the agent (2026-10-23): SPQ 7A
// for work 7B covers, solar age/install date vs a permit record, and the net
// metering tier wording. Each is tested on her real finding AND on rewordings,
// because a rule built from one sentence broke on the next (6H, TDS B).
// The lines she KEPT must still be chased.
//   node checks/wilson-rules.js

const I = require('../netlify/functions/disclosure-intake-check-background.js')._internal;
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }
const cut = (f) => I.is7ACoveredBy7B(f) || I.isSolarDateVsRecord(f) || I.isMeteringTierWording(f);
const c = (o) => ({ issue: 'answer_contradicts_package', ...o });

// Her real findings (2647 E Wilson).
ok('7A, real: tankless water heater / 7B', cut(c({ form: 'SPQ', item: '7A', discrepancy_type: 'document', marked: 'No', should_be: 'Yes', reason: "the permit report and the seller's own 7B, 7D and item 7 explanation show replacements and improvements made during the seller's ownership", document: 'the Permit Timeline Report (permit PLUM26-0308, tank water heater replaced with tankless, status Corrections Required)' })), true);
ok('SOLAR 1C, real: age vs 2015 permit', cut(c({ form: 'SOLAR', item: '1C', marked: 'Yes', reason: 'the seller states the system is about 7 years old and was installed 5/2018, but the permit report shows the photovoltaic system permit was finaled in March 2015', document: 'the Permit Timeline Report' })), true);
ok('SOLAR 3B(1), real: install date vs permit', cut(c({ form: 'SOLAR', item: '3B(1)', marked: '5/2018', reason: 'the seller lists installation as 5/2018 and an age of 7 years in 1C, but the only solar permit on record was finaled March 30, 2015' })), true);
ok('SOLAR 3B(2)(A), real: "i/o" tier', cut({ form: 'SOLAR', item: '3B(2)(A)', issue: 'explanation_unclear', marked: 'Yes', reason: 'the net energy metering tier or rate is written as "i/o", which does not identify a tier or rate' }), true);

// Reworded.
ok('7A reworded: "solar panels were added"', cut(c({ form: 'SPQ', item: '7A', marked: 'No', reason: 'the seller notes solar panels were added in 2019, which is an improvement' })), true);
ok('7A reworded: "see 7B"', cut(c({ form: 'SPQ', item: '7A', marked: 'No', reason: 'work described under 7B is also an alteration' })), true);
ok('SOLAR date reworded: county records', cut(c({ form: 'SOLAR', item: '1C', marked: '10 years', reason: 'county records show the system installed in 2012, not 10 years ago' })), true);
ok('SOLAR tier reworded: "3B (2)(A)"', cut({ form: 'SOLAR', item: '3B (2)(A)', issue: 'unanswered', marked: 'blank', reason: 'tier left blank' }), true);

// What she KEPT, still chased.
ok('kept: SOLAR 3D(2) blank', cut({ form: 'SOLAR', item: '3D(2)', issue: 'unanswered', marked: 'blank', reason: '3D is marked No, so the seller must describe how the system is attached to the roof, but the line is blank' }), false);
ok('kept: SOLAR 3H no details', cut({ form: 'SOLAR', item: '3H', issue: 'yes_no_explanation', marked: 'Yes', reason: '3H is marked Yes but no system details such as number of panels are given' }), false);
ok('kept: SPQ 7E built 1960', cut(c({ form: 'SPQ', item: '7E', marked: 'No', should_be: 'Yes', reason: 'the property was built in 1960' })), false);
ok('kept: 7A for a remodel (no efficiency work)', cut(c({ form: 'SPQ', item: '7A', marked: 'No', should_be: 'Yes', reason: 'the item 7 explanation describes a kitchen remodel and new flooring' })), false);
ok('kept: SOLAR lease vs a document (no dates)', cut(c({ form: 'SOLAR', item: '1B', marked: 'Owned', reason: 'the purchase agreement shows the system is leased' })), false);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall wilson-rules checks pass');
process.exit(failed ? 1 : 0);
