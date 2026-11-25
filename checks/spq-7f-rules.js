// checks/spq-7f-rules.js: SPQ 7F as the form reads it, and "no explanation"
// never raised for an answer the review itself found.
// Megan, 2026-11-24: "you kept flagging it as missing but it wasn't" (8855 St
// Ives, 4527 Winnetka, 8301 Rayford); Notes 1 and 2 apply only "If yes to F(1)".
// The flags below are the real ones from those three reviews.
const assert = require('assert');
const { answeredElsewhere } = require('../netlify/functions/lib/intake-steps.js');
const { citesAnUnseenAttachment } = require('../netlify/functions/disclosure-intake-check-background.js').core;

// St Ives: 7F Yes, its follow-up No -> nothing to ask.
const stIves = { form: 'SPQ', item: '7F', issue: 'yes_no_explanation', reason: '7F is marked Yes (acquired within 18 months) with no explanation, and the follow-up asking whether contractors performed alterations or repairs is marked No. The package discloses a new A/C unit.' };
assert.deepStrictEqual(answeredElsewhere([stIves]), [], 'F(1) No: the Notes do not apply');

// St Ives: a date inside the explanation is not questioned.
const stIvesDate = { form: 'SPQ', item: '7F', issue: 'explanation_unclear', reason: "The explanation 'Purchased the property 12/3/2026' gives a purchase date after the 11/5/2026 date the seller signed the SPQ; please correct the acquisition date." };
assert.deepStrictEqual(answeredElsewhere([stIvesDate]), []);

// Winnetka: explained on the addendum, and a permits file in the package.
const winnetka = [
  { form: 'SPQ', item: '7F', issue: 'yes_no_explanation', reason: 'marked Yes but no explanation is provided, on the form or on the separate explanations sheet' },
  { form: 'SPQ', item: '7F', issue: 'explanation_on_addendum', reason: '7.A (Any alterations...): Yes. See detailed list below.' },
  { form: 'SPQ', item: '7F', issue: 'detail_incomplete', reason: "Note 2 requires a list of the Improvements for which permits were obtained with copies attached, but the addendum only states permits 'will be provided to Buyer,'" },
];
const w = answeredElsewhere(winnetka, ['[SPQ] Seller Property Questionnaire.pdf', 'Permits.pdf']);
assert.deepStrictEqual(w.map((f) => f.issue), ['explanation_on_addendum'], 'found on the addendum, permits file present');

// F(1) Yes and nothing written: still asked (the Notes apply).
const f1Yes = { form: 'SPQ', item: '7F(1)', issue: 'yes_no_explanation', reason: '7F(1) is marked Yes but there is no list of improvements or contractors.' };
assert.strictEqual(answeredElsewhere([f1Yes]).length, 1, 'F(1) Yes with nothing: asked');
// Another question entirely is untouched.
assert.strictEqual(answeredElsewhere([{ form: 'SPQ', item: '6G', issue: 'yes_no_explanation', reason: 'no explanation' }]).length, 1);

// Rayford: "See attached" the review could not find -> VERIFY, not the email.
assert.ok(citesAnUnseenAttachment({ reason: "The explanation reads '7F1. See attached', but no attachment is in the package listing the improvements, the contractor names and contact information, or the permits" }));
assert.ok(citesAnUnseenAttachment({ reason: "the explanation only says 'See attached' and no attachment is in the package; the list of improvements, contractor names and contact information, and permit copies are missing." }));
assert.ok(!citesAnUnseenAttachment({ reason: '6G is marked Yes but the item 6 explanation line is blank' }), 'a plain blank is still chased');

// Rayford: the "See attached" list itself is read now.
const { isSellerAddendum } = require('../netlify/functions/disclosure-intake-check-background.js')._internal;
assert.ok(isSellerAddendum('List of Improvements and Permits\n(Pursuant to Cal. Civ. Code § 1102.6h)\nProperty address: 8301 Rayford Dr'));

// Via Viento (E): a BHAA in the package is not evidence of an HOA.
const bhaa = { form: 'SPQ', item: '14A', issue: 'verify_mismatch', reason: "a Buyers Homeowners' Association Advisory is included in the package while the seller marked SPQ 6G and TDS C12 to C14 No and wrote Section 14 not applicable; please confirm whether the property is subject to an HOA." };
assert.deepStrictEqual(answeredElsewhere([bhaa]), [], 'the BHAA alone does not make an HOA');
const dues = { form: 'SPQ', item: '14A', issue: 'answer_contradicts_package', reason: 'the BHAA and the HOA dues statement in the package show HOA dues of $450 a month, but 14A is marked No.' };
assert.strictEqual(answeredElsewhere([dues]).length, 1, 'real HOA evidence still stands');
// Altadena (Megan: no D): an explanation on the wrong line is still chased.
const misplaced = { form: 'SPQ', item: '19A', issue: 'explanation_misplaced', reason: '19. B: The community is in discussion to bring a public sewer line to the neighborhood.' };
assert.strictEqual(answeredElsewhere([misplaced]).length, 1, 'every Yes needs its own explanation');

// TDS C8 is the exterior grounds, never SPQ 10A's water intrusion (Megan, 2026-11-24, 8855 St Ives).
const { c8OnTheGrounds, c8WithoutItsSubject } = require('../netlify/functions/disclosure-intake-check-background.js').core;
const mixed = c8OnTheGrounds({ form: 'TDS', item: 'C8', issue: 'answer_contradicts_package', reason: 'on SPQ 10A and the Text Overflow Addendum, the seller discloses water intrusion into the garage and states the drainage systems were all corrected based on a prior inspection.' });
assert.ok(/drainage systems were all corrected/.test(mixed.reason) && !/garage|10A|intrusion/i.test(mixed.reason), mixed.reason);
assert.ok(c8WithoutItsSubject({ form: 'TDS', item: 'C8', issue: 'answer_contradicts_package', reason: 'SPQ 10A: garage from upper deck leaking from a/c unit.' }), 'a leak alone is not C8');

console.log('spq-7f-rules: 7F as the form reads; "see attached" never chased blind; no "no explanation" for an answer found');
