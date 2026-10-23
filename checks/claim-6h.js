// checks/claim-6h.js
//
// SPQ 6H (insurance claims) explained by a claim, lawsuit or settlement is not
// chased (Megan, 12273 Donald Reed: "the lawsuit is the insurance claim").
// It slipped through on 2026-10-23 because the review wrote one long sentence
// and the title strip ran to the next period, taking "lawsuit" with it.
//   node checks/claim-6h.js

const I = require('../netlify/functions/disclosure-intake-check-background.js')._internal;

let failed = 0;
function ok(label, got, want) {
  if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`);
}
const f = (reason, issue = 'yes_no_explanation') => ({ form: 'SPQ', item: '6H', issue, reason });

ok('2026-10-23 wording (one sentence) is explained', I.isClaimExplained6H(f('6H (insurance claims within the past 5 years) is marked Yes, but the only item 6 explanation describes a settled landlord and tenant lawsuit and does not identify any insurance claim.')), true);
ok('2026-10-22 wording (semicolon) is explained', I.isClaimExplained6H(f('6H is marked Yes but no insurance claim is described; the item 6 explanation describes only a settled landlord and tenant lawsuit')), true);
ok('the "unclear" wording is explained too', I.isClaimExplained6H(f('6H (insurance claims within the past 5 years) is marked Yes; the explanation mentions a settlement but is vague.', 'explanation_unclear')), true);
ok('a BLANK 6H explanation is still chased', I.isClaimExplained6H(f('6H (insurance claims within the past 5 years) is marked Yes but the item 6 explanation line is blank.')), false);
ok('a bare "no explanation" is still chased', I.isClaimExplained6H(f('6H is marked Yes but no explanation is written.')), false);
ok('another SPQ item is untouched', I.isClaimExplained6H({ ...f('a settled lawsuit'), item: '6G' }), false);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall claim-6h checks pass');
process.exit(failed ? 1 : 0);
