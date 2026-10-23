// checks/seller-answer-rules.js
//
// The listing review's hard consistency rules (lib/seller-answer-rules.js).
// Question wording is Process Street's "DISCLOSURE PACKAGE FOR SELLER" form;
// the answer patterns are real deals (2026-10): 1131 Alta Loma #415 (condo,
// C2 + 15D No), 11545 Dona Cecilia (C2 Yes, 15D No), 1407 Santanella (C2 No,
// 15D Yes). No seller data.
//   node checks/seller-answer-rules.js

const R = require('../netlify/functions/lib/seller-answer-rules.js');
const review = require('../netlify/functions/disclosure-review-background.js')._internal;

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

// A slice of the form, in form order. Each test overrides answers by key.
function form(ans = {}) {
  const f = (key, label) => ({ id: key, label, value: ans[key] || '' });
  return [
    f('hoa', 'Property within an HOA?'),
    f('fire', 'High Fire Hazard Area?'),
    f('c1', 'C1: Substances, materials, or products which may be an environmental hazard?'),
    f('c1x', 'C1: Please explain here:'),
    f('c2', 'C2: Does the property share any features in common with an adjoining landowners such as walls, fences, & driveways'),
    f('c2x', 'C2: Please share the features shared in common below:'),
    f('c3', 'C3: Are you aware of any encroachments, easements, or similar matters that may affect your interest in the subject property?'),
    f('c3x', 'C3: Please describe here:'),
    f('c12', "C12: Are there CC&R's or other deed restrictions or obligations?"),
    f('c12x', 'C12: Please explain here:'),
    f('c13', "C13: Is there a Homeowner's Association (HOA) which has authority over the property?"),
    f('6g', '6G: Are you aware of Whether the Property is (i) a condominium or (ii) located in a planned unit development or other common interest subdivision'),
    f('6gx', '6G: Please explain here'),
    f('7a', '7A: Are you aware of any alterations, modifications, replacements, improvements, remodeling or material repairs on the Property?'),
    f('7ax', '7A: Please explain including the type and extent of work, who did the work, the date(s) of the work'),
    f('7e', '7E: Was the property built before 1978?'),
    f('7ex', '7E: Please explain here:'),
    f('11a', '11A: Are you aware of any past or present pets on or in the Property?'),
    f('11ax', '11A: Please explain here:'),
    f('13c', '13C: Are you aware of a pool heater on the Property?'),
    f('13cop', '13C: Is it operational?'),
    f('14b', "14B: Are you aware of any Homeowner's Association (HOA) which has any authority over the subject property?"),
    f('14bx', '14B: Please explain here:'),
    f('14d', "14D: Are you aware of any CC&R's or other deed restrictions or obligations?"),
    f('14dx', '14D: Please explain here:'),
    f('14e', '14E: Are you aware of any pending or proposed dues increases, special assessments, rules changes, insurance availability issues, or litigation by or against the HOA?'),
    f('15d', '15D: Are you aware of features of the property shared in common with adjoining landowners, such as walls, fences and driveways'),
    f('15dx', '15D: Please explain here:'),
    f('15e', '15E: Are you aware of any encroachments, easements, boundary disputes, or similar matters?'),
    f('15ex', '15E: Please explain here:'),
    f('17g', '17G: Are you aware of any existing or proposed Government requirements affecting the Property that tall grass, brush or other vegetation be cleared'),
    f('17gx', '17G: Please explain here:'),
    // Another form in the same workflow reuses "C2:" for a different question.
    f('vlqC2', 'C2: Are you aware of any room additions, structural modifications, or any other alterations or repairs made without necessary permits?'),
  ];
}
const run = (ans, address = '1131 Alta Loma Rd #415, West Hollywood, CA 90069', prior = []) => {
  const ordered = form(ans);
  return R.sellerAnswerMandates({ ordered, fields: ordered.filter((x) => x.value), address, prior });
};
const rules = (ms) => ms.map((m) => `${m.rule}: ${m.section}`);

// 1131 Alta Loma #415: a condo with C2 and 15D answered No.
const condo = { hoa: 'Yes', c2: 'No', c3: 'No', c12: 'Yes', c12x: 'HOA', c13: 'Yes', '6g': 'Yes', '6gx': "It's a condo building.", '14b': 'Yes', '14bx': 'HOA', '14d': 'Yes', '14dx': 'HOA', '14e': 'No', '15d': 'No', '15e': 'No', '15ex': '‹C3: Please describe here:›' };
const m415 = run(condo);
ok('#415: shared walls asks about both C2 and 15D, nothing else', rules(m415), ['sharedWalls: TDS C2; SPQ 15D']);
ok('#415: the ask names both forms in plain words', /Transfer Disclosure Statement and the Seller Property Questionnaire/.test(m415[0].ask), true);
ok('#415: the review does not drop it (matched by section)', review.materialHasMandate([{ section: 'TDS C2' }], m415[0]), true);
ok('a single-family home with C2 + 15D No is fine', rules(run(condo, '11545 Dona Cecilia Dr, Studio City, CA 91604').filter((x) => x.rule !== 'hoaConsistency')), []);
ok('a condo answered Yes is fine', rules(run({ ...condo, c2: 'Yes', c2x: 'Walls', '15d': 'Yes', '15dx': 'Walls' })), []);
ok('another form\'s "C2:" question (permits) is not read as TDS C2', rules(run({ ...condo, c2: 'Yes', c2x: 'Walls', '15d': 'Yes', '15dx': 'Walls', vlqC2: 'No' })), []);

// TDS and SPQ disagree on the same question.
ok('Dona Cecilia: C2 Yes "Fences", 15D No (copied "Fences") -> one "make them match" ask, not "you wrote an explanation"',
  rules(run({ c2: 'Yes', c2x: 'Fences', '15d': 'No', '15dx': 'Fences' }, '11545 Dona Cecilia Dr, Studio City, CA 91604')), ['mirrorMismatch: TDS C2; SPQ 15D']);
ok('Santanella: C2 No, 15D Yes -> make them match',
  rules(run({ c2: 'No', '15d': 'Yes', '15dx': 'fences' }, '1407 Santanella Ter, Newport Beach, CA 92625')), ['mirrorMismatch: TDS C2; SPQ 15D']);
ok('C3 and 15E disagree -> make them match', rules(run({ c3: 'Yes', c3x: 'easement', '15e': 'No', '15ex': 'easement' }, '1 Main St, LA')), ['mirrorMismatch: TDS C3; SPQ 15E']);

// HOA consistency (buyer audit rule (d)).
ok('HOA property with 14D No -> asked to be Yes', rules(run({ ...condo, c2: 'Yes', c2x: 'Walls', '15d': 'Yes', '15dx': 'Walls', '14d': 'No', '14dx': '' })), ['hoaConsistency: SPQ 14D']);
ok('14E (dues increases, assessments) can be No in an HOA', rules(run({ ...condo, c2: 'Yes', c2x: 'Walls', '15d': 'Yes', '15dx': 'Walls', '14e': 'No' })), []);
ok('no HOA anywhere -> HOA items left alone', rules(run({ hoa: 'No', c12: 'No', c13: 'No' }, '1 Main St, LA')), []);

// Yes with no explanation (buyer audit rule (b)) and its exceptions.
ok('7A Yes with a blank explanation -> asked for one', rules(run({ '7a': 'Yes' }, '1 Main St, LA')), ['yesNoExplanation: SPQ 7A']);
ok('a pool heater Yes / operational Yes needs no explanation', rules(run({ '13c': 'Yes', '13cop': 'Yes' }, '1 Main St, LA')), []);
ok('7E (built before 1978) Yes alone needs no explanation', rules(run({ '7e': 'Yes' }, '1 Main St, LA')), []);
ok('"N/A" as an explanation is blank', rules(run({ '11a': 'Yes', '11ax': 'N/A' }, '1 Main St, LA')), ['yesNoExplanation: SPQ 11A']);

// An explanation on a No (buyer audit rule (c)).
ok('11A No with "one dog" written -> should it be Yes?', rules(run({ '11a': 'No', '11ax': 'one dog' }, '1 Main St, LA')), ['explainedButNo: SPQ 11A']);
ok('a Process Street placeholder ("‹C3: Please describe here:›") is not an explanation', rules(run({ '15e': 'No', '15ex': '‹C3: Please describe here:›', c3: 'No' }, '1 Main St, LA')), []);
const fire = { topic: 'Fire', section: 'SPQ 17G', sectionRx: /17\s*g/i };
ok('17G already asked by the fire-zone check is not asked twice', rules(run({ '17g': 'No', '17gx': 'Annual brush clearance is required.' }, '1 Main St, LA', [fire])), []);
ok('without the fire check, 17G No with that explanation is asked', rules(run({ '17g': 'No', '17gx': 'Annual brush clearance is required.' }, '1 Main St, LA')), ['explainedButNo: SPQ 17G']);
ok('Yes/No is read strictly ("N/A" is not "No")', [R.yesNo('N/A'), R.yesNo('No'), R.yesNo('Yes')], ['', 'no', 'yes']);

// Every ask goes to the seller: no em dashes (Megan's rule for her emails).
const all = [m415, run({ c2: 'Yes', c2x: 'Fences', '15d': 'No', '15dx': 'Fences' }, 'x'), run({ ...condo, '14d': 'No' }), run({ '7a': 'Yes' }, 'x'), run({ '11a': 'No', '11ax': 'dog' }, 'x')].flat();
ok('no em dashes in any ask', all.some((m) => /—/.test(m.ask + m.why + m.emailHeading)), false);


// Missing property details + 7E vs Year Built (her form's real wording, 2026-10-23).
const F = (label, value = '') => ({ label, value });
const detailForm = (o = {}) => [
  F('Year Built', o.year || ''), F('Is the property\'s water heater powered by Gas (most common), Solar, or Electric?', o.wh ?? 'Gas'),
  F('Is there exhaust fans on your property (typically in bathrooms or kitchens)', o.fans || 'Yes'), F('Where are the exhaust fans? (typically in bathrooms & above kitchen stove)', o.fansWhere ?? 'Bathrooms'),
  F('Is there 220 Volt Wiring in the property? (These plugs are meant for ovens, dryers ...)', o.v220 || 'No'), F('Where is the 220 Volt Wiring? (i.e ovens, dryers, car charger)', o.v220Where ?? ''),
  F('Is there a fireplace(s)?', o.fire || 'No'), F('Where is the fireplace(s)? (i.e living room, bedroom)', o.fireWhere ?? ''),
  F('What type of roof does the property have?', o.roof ?? 'Tile'), F('Approximately how old is the roof? (if you do not know, type "unaware")', o.roofAge ?? 'unaware'),
  F('C1: Substances, materials, or products which may be an environmental hazard?', o.c1 ?? 'No'),
  F('7E: Was the property built before 1978?', o.e7 || ''),
];
const dm = (o) => R.detailsMissing(detailForm(o));
ok('details: all answered -> nothing', dm({}), null);
ok('details: 220 volt Yes with a blank location -> asked', /where the 220 volt wiring is/.test((dm({ v220: 'Yes' }) || {}).ask || ''), true);
ok('details: 220 volt No with a blank location -> fine', dm({ v220: 'No' }), null);
ok('details: fireplace Yes, blank location + blank roof type -> both in one ask', /where the fireplace is and the roof type/.test((dm({ fire: 'Yes', roof: '' }) || {}).ask || ''), true);
ok('details: blank roof type, but the TDS section was never filled -> fine', dm({ roof: '', c1: '' }), null);
ok('details: "unaware" roof age is an answer', dm({ roofAge: 'unaware' }), null);
const y7 = (year, e7) => { const o = detailForm({ year, e7 }); return R.yearBuilt7E(R.questions(o), o.filter((x) => x.value)); };
ok('7E: built 1955, answered No -> should be Yes', /would be "Yes"/.test((y7('1955', 'No') || {}).ask || ''), true);
ok('7E: built 1991, answered Yes -> should be No', /would be "No"/.test((y7('1991', 'Yes') || {}).ask || ''), true);
ok('7E: built 1972, answered Yes -> fine', y7('1972', 'Yes'), null);
ok('7E: no year built on file -> fine', y7('', 'No'), null);
ok('new asks have no em dashes', /\u2014/.test(`${(dm({ v220: 'Yes', roof: '' }) || {}).ask}${(y7('1955', 'No') || {}).ask}`), false);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall seller-answer-rules checks pass');
process.exit(failed ? 1 : 0);
