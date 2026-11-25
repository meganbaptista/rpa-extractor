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

console.log('spq-7f-rules: 7F as the form reads; "see attached" never chased blind; no "no explanation" for an answer found');
