// checks/upkeep-rule.js
//
// "Maintenance is not a problem": SPQ problem questions (8A, 11B-D, 13A, 13E)
// are not chased to Yes on the strength of routine service or an upgrade.
//   node checks/upkeep-rule.js
//
// The reasons below are the review's own wording on real packages, 2026-10-21.

const { isUpkeepNotProblem } = require('../netlify/functions/disclosure-intake-check-background.js')._internal;

let failed = 0;
function ok(label, got, want) {
  if (got !== want) { failed++; console.error(`FAIL  ${label}\n      got  ${got}\n      want ${want}`); }
  else console.log(`pass  ${label}`);
}
const flag = (item, reason, extra = {}) => ({ form: 'SPQ', item, issue: 'answer_contradicts_package', should_be: 'Yes', marked: 'No', reason, ...extra });

// --- Megan said these were a reach: route to CHECK BEFORE SENDING --------------
ok('Westminster 13E: sprinklers redone, pool equipment replaced',
  isUpkeepNotProblem(flag('13E', 'the SPQ addendum discloses backyard sprinkler irrigation lines redone and pool equipment replaced in 2014')), true);
ok('Westminster 13E, old intake wording',
  isUpkeepNotProblem(flag('13E', 'the seller discloses that the pool deck, coping, pebble tech and pool equipment were replaced in 2014 and the backyard sprinkler irrigation lines were redone in 2014')), true);
ok('Westminster 11D: monthly MOXI pest control',
  isUpkeepNotProblem(flag('11D', 'the seller discloses monthly MOXI pest control in the 7C explanation')), true);
ok('Westminster 11D, job wording',
  isUpkeepNotProblem(flag('11D', 'the SPQ addendum discloses ongoing monthly MOXI pest control')), true);
ok('the item number with a space', isUpkeepNotProblem(flag('11 D', 'the seller discloses monthly pest control service')), true);

// --- real problems: still chased -------------------------------------------------
ok('Eastborne 11D: termites treated by special assessment',
  isUpkeepNotProblem(flag('11D', 'The seller discloses on the item 6 explanation line that termite issues were treated and paid for by a special assessment')), false);
ok('Eastborne 11B: termite issues',
  isUpkeepNotProblem(flag('11B', 'The seller discloses on the item 6 explanation line that a unit had termite issues that were treated and paid for by a special assessment')), false);
ok('Scenic 8A: roof leak (a leak is a problem even if repaired)',
  isUpkeepNotProblem(flag('8A', 'the seller discloses a roof leak in the item 10 explanation, and 8A asks about past roof defects even if repaired')), false);
ok('a replaced part that had FAILED is a problem',
  isUpkeepNotProblem(flag('13E', 'the pool pump failed and was replaced in 2023')), false);
ok('rodents, even with "service"',
  isUpkeepNotProblem(flag('11D', 'the seller discloses rodent exclusion service after mice were found in the attic')), false);

// --- out of scope: untouched -----------------------------------------------------
ok('a question that is not a problem question', isUpkeepNotProblem(flag('7A', 'the seller discloses new windows installed')), false);
ok('a TDS item', isUpkeepNotProblem({ ...flag('13E', 'pool equipment replaced'), form: 'TDS' }), false);
ok('a different issue type', isUpkeepNotProblem({ ...flag('13E', 'pool equipment replaced'), issue: 'yes_no_explanation' }), false);
ok('should be No, not Yes', isUpkeepNotProblem(flag('13E', 'pool equipment replaced', { should_be: 'No' })), false);
ok('no upkeep words at all', isUpkeepNotProblem(flag('13E', 'the TDS lists the pool as present')), false);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall upkeep-rule checks pass');
process.exit(failed ? 1 : 0);
