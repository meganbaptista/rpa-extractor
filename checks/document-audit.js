// checks/document-audit.js
//
// Pins the audit stage's pure parts, with no PDF and no model call.
//   node checks/document-audit.js
//
// lib/page-strips.js decides WHERE each document is; this stage decides WHAT
// each one is and who still has to sign it. Three things here are code rather
// than prompt, and all three can file a form under the wrong name if they are
// wrong: how documents are batched into calls, what happens when the audit
// disputes a boundary, and the brokerage evidence an AVID's side is read from.

const A = require('../netlify/functions/lib/document-audit.js');
const { applySplit, tallyBrands, packetContext } = A._internal;
const split = require('../netlify/functions/disclosure-split-background.js');
const { statusSuffix, formLabel } = split._internal;

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

const doc = (pages, o = {}) => ({ pages, title: '', brand: '', carCode: '', footerName: '', notes: [], ...o });

// --- batching ---------------------------------------------------------------
// Caps on ATTENTION, not tokens: the whole design rests on each block being
// small enough to be read properly.
ok('batches by document count',
  A.groupForAudit([doc([1]), doc([2]), doc([3]), doc([4]), doc([5]), doc([6])], 5, 100)
    .map((g) => g.length),
  [5, 1]);
ok('and by page count',
  A.groupForAudit([doc([1, 2, 3]), doc([4, 5, 6]), doc([7])], 100, 6).map((g) => g.length),
  [2, 1]);
// A document is never cut across calls - a block that is half a document
// defeats the point of asking one question per document.
ok('an oversized document goes alone rather than being cut',
  A.groupForAudit([doc([1, 2, 3, 4, 5, 6, 7, 8]), doc([9])], 5, 6).map((g) => g.map((d) => d.pages.length)),
  [[8], [1]]);
ok('no documents, no calls', A.groupForAudit([]), []);

// --- a disputed boundary ----------------------------------------------------
// This is the ONE place a model is allowed to change a page span, so the
// proposal is checked hard: a half-understood split files half a form under a
// confident name, which is worse than the dispute it came from.
const block = doc([18, 19, 20], { title: 'ABA', carCode: 'ABA' });
ok('a clean proposal splits the block',
  applySplit(block, [1, 2]).map((d) => d.pages), [[18], [19], [20]]);
ok('one cut', applySplit(block, [2]).map((d) => d.pages), [[18, 19], [20]]);
ok('duplicates and disorder are tolerated',
  applySplit(block, [2, 2, 1]).map((d) => d.pages), [[18], [19], [20]]);
ok('a position outside the block is refused', applySplit(block, [5]), null);
ok('the block\'s own last position is refused', applySplit(block, [3]), null);
ok('zero is refused', applySplit(block, [0]), null);
ok('nonsense is refused', applySplit(block, ['x', null]), null);
ok('no proposal at all means no split', applySplit(block, []), null);
ok('a one-page block cannot be split', applySplit(doc([7]), [1]), null);

// The strip labels described the whole block, so after a split only the first
// piece can still claim them - otherwise three documents file under one title.
{
  const pieces = applySplit(block, [1, 2]);
  ok('only the first piece keeps the title and code',
    pieces.map((d) => `${d.title}/${d.carCode}`), ['ABA/ABA', '/', '/']);
  ok('a declared length does not survive a split',
    pieces.map((d) => d.declaredLength), [0, 0, 0]);
  ok('and every piece says it came out of a disputed block',
    pieces.every((d) => d.notes.some((n) => /split out of pages 18-20/.test(n))), true);
}

// --- the brokerage evidence an AVID's side is read from ---------------------
// An AVID is the listing agent's or the buyer's agent's, and the only way to
// tell is whose brokerage performed the inspection. On the Beverly Glen packet
// the same AVID came back AVID-BA twice and AVID-LA once until the evidence
// was given as counts.
ok('the form PUBLISHER is not a brokerage',
  tallyBrands([doc([1], { brand: 'CALIFORNIA ASSOCIATION OF REALTORS' }),
               doc([2], { brand: 'California Association of Realtors' }),
               doc([3], { brand: 'CALIFORNIA ASSOCIATION OF REALTORS®' }),
               doc([4], { brand: 'Coldwell Banker Realty' })]),
  [['Coldwell Banker Realty', 1]]);
ok('casing and a trademark mark do not make one firm into three',
  tallyBrands([doc([1], { brand: 'Coldwell Banker Realty' }),
               doc([2], { brand: 'COLDWELL BANKER REALTY' }),
               doc([3], { brand: 'Coldwell Banker Realty®' })]),
  [['Coldwell Banker Realty', 3]]);
// The real case: one firm branding itself at three lengths lost 8 documents to
// 4 by being counted as three separate firms.
ok('a firm branding itself at several lengths is counted once',
  tallyBrands([doc([1], { brand: "Christie's International Real Estate" }),
               doc([2], { brand: "AKG | Christie's International Real Estate" }),
               doc([3], { brand: "AKG | Christie's International Real Estate" }),
               doc([4], { brand: "Christie's International Real Estate SoCal" }),
               doc([5], { brand: 'Coldwell Banker Realty' }),
               doc([6], { brand: 'Coldwell Banker Realty' })]),
  [["Christie's International Real Estate", 4], ['Coldwell Banker Realty', 2]]);
ok('a clear majority is named as the assembling side',
  /most likely the assembling side/.test(packetContext(
    [doc([1], { brand: 'A Realty' }), doc([2], { brand: 'A Realty' }), doc([3], { brand: 'B Realty' })])),
  true);
// A tie must NOT produce a confident answer: guessing an AVID's side names the
// wrong agent on a signed disclosure.
ok('a tie refuses to name a side',
  /do not guess/.test(packetContext(
    [doc([1], { brand: 'A Realty' }), doc([2], { brand: 'B Realty' })])),
  true);
ok('no brands at all says so',
  /no brokerage names were read/.test(packetContext([doc([1]), doc([2])])), true);

// --- the filename a document actually lands under ---------------------------
// What Megan sees in the folder. The BA AVID is the case that started this:
// she hand-names it "BA AVID - need SS", and the old splitter called it FX.
const nameOf = (f) => `${formLabel(f)} - ${statusSuffix(f)}.pdf`;
ok('the BA AVID arrives needing the seller',
  nameOf({ code: 'AVID-BA', name: 'Agent Visual Inspection Disclosure',
           required_signers: ['BA', 'S', 'B'], present_signers: ['BA', 'B'] }),
  'AVID-BA - Agent Visual Inspection Disclosure - NeedSS.pdf');
ok('a cooperating broker addendum keeps its brokerage in the name',
  nameOf({ code: '', name: 'Coldwell Banker Contract Addendum and Other Greater Los Angeles Area Disclosures',
           required_signers: ['B', 'S'], present_signers: ['B'] }),
  'Coldwell Banker Contract Addendum and Other Greater Los Angeles Area Disclosures - NeedSS.pdf');
ok('a fully executed form says so',
  nameOf({ code: 'TDS', name: 'Real Estate Transfer Disclosure Statement',
           required_signers: ['S', 'B', 'LA', 'BA'], present_signers: ['S', 'B', 'LA', 'BA'] }),
  'TDS - Real Estate Transfer Disclosure Statement - FX.pdf');
// No required signers is not "everyone signed" - that rounding is what stamped
// a form nobody could reason about as fully executed.
ok('a document the audit could not reason about goes to review, not FX',
  statusSuffix({ code: '', name: 'Affiliated Business Arrangement Disclosure Statement',
                 required_signers: [], present_signers: [] }),
  'NeedReview');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
