// checks/package-plan.js
//
// The buyer-package planner (lib/package-plan.js) on the page maps of two real
// deliveries Megan approved by hand on 2026-10-23 (titles and page spans only,
// no names): 2647 E Wilson Ave and 5733 E Stillwater Ave #2. Each check is a
// rule from the buyer-package rulebook that the hand builds had to get right.
//   node checks/package-plan.js

const P = require('../netlify/functions/lib/package-plan.js');
const wilson = require('./lib/plan-wilson.json');
const stillwater = require('./lib/plan-stillwater.json');
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }
const total = (f) => f.reduce((s, x) => s + x.pages, 0);
const labels = (plan) => plan.units.map((u) => u.label);
const at = (plan, rx) => plan.units.findIndex((u) => rx.test(u.label));

// ---- Wilson ----
const w = P.planPackage({ files: wilson.files, extras: [], dropIns: {} });
ok('Wilson: every delivered page placed or left out', w.accounted.size, total(wilson.files));
ok('Wilson: TDS opens the package', at(w, /TRANSFER DISCLOSURE/i), 0);
ok('Wilson: SPQ right after the TDS', at(w, /PROPERTY QUESTIONNAIRE/i), 1);
ok('Wilson: permit report is ONE unit (map split it in 4)', labels(w).filter((l) => /permit timeline/i.test(l)).length, 1);
ok('Wilson: NHD report attached, not merged', w.attachments.some((a) => /Natural Hazard Disclosure Report/.test(a.name)), true);
ok('Wilson: NHD statement is in the package', at(w, /NATURAL HAZARD DISCLOSURE STATEMENT/i) > 0, true);
ok('Wilson: no form code in a buyer-facing label', labels(w).concat(w.attachments.map((a) => a.name)).some((l) => /\b(TDS|SPQ|AVID|SBSA|FHDS|DSDT|NHD|BHAA)\b/.test(l)), false);

// ---- Stillwater ----
const sx = [{ key: 'x0', name: '47. Termite Report.pdf', pages: 7 }, { key: 'x1', name: '52. Home Inspection - Previous Buyer.pdf', pages: 108 }, { key: 'x2', name: '52. Pre-Listing Home Inspection - Seller.pdf', pages: 74 }];
const dups = [{ n: 1, of: 'combined pages 89-92' }, { n: 3, of: 'combined page 31' }, { n: 5, of: 'combined pages 32-61' }, { key: 'x0', of: 'combined pages 93-98' }];
const s = P.planPackage({ files: stillwater.files, extras: sx, dropIns: { profile: { type: 'deal' }, mls: { type: 'deal' } }, flags: { duplicates: dups } });
ok('Stillwater: every delivered page placed or left out', s.accounted.size, total(stillwater.files));
ok('Stillwater: TDS then SPQ first', `${at(s, /TRANSFER DISCLOSURE/i)},${at(s, /PROPERTY QUESTIONNAIRE/i)}`, '0,1');
ok('Stillwater: DSDT left out', s.leftOut.some((l) => /DSDT/.test(l.why)), true);
ok('Stillwater: amendment goes back to Megan, not in the package', s.leftOut.some((l) => /AMENDMENT/i.test(l.what)), true);
ok('Stillwater: four duplicate files placed once', s.leftOut.filter((l) => /^duplicate of/.test(l.why)).length, 4);
ok('Stillwater: termite work order stays with its report', labels(s).some((l) => /^WORK ORDER/i.test(l)), false);
ok('Stillwater: NHD statement right before the fire-hardening disclosure', at(s, /FIRE HARDENING/i) - at(s, /NATURAL HAZARD DISCLOSURE STATEMENT/i), 1);
ok('Stillwater: both home inspections attached separately', s.attachments.filter((a) => /^Seller Report - .*Inspection/.test(a.name)).length, 2);
ok('Stillwater: restoration pages are one separate report, not two', s.attachments.filter((a) => /^Seller Report - /.test(a.name) && !/Inspection/.test(a.name)).length, 1);
ok('Stillwater: no attachment named twice', new Set(s.attachments.map((a) => a.name)).size, s.attachments.length);
ok('Stillwater: our profile and MLS skipped (listing side sent theirs)', s.leftOut.filter((l) => /^our (Property Profile|MLS)/.test(l.what)).length, 2);
ok('Stillwater: FHDA/WFA flagged as possible FX', ['FHDA', 'WFA'].every((c) => s.warnings.some((x) => x.startsWith(c))), true);
ok('Stillwater: preliminary report attached', s.attachments.some((a) => /Preliminary Title Report/.test(a.name)), true);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall package-plan checks pass');
process.exit(failed ? 1 : 0);
