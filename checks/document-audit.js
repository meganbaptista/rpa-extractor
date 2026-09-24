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
const { applySplit, tallyBrands, packetContext, rejoinSplitForms } = A._internal;
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
  // The block's own span arithmetic described the MERGED block and stopped
  // being true when it was split. On 834 Victoria Ln "span is 2 page(s) but
  // the document says 1" rode onto both halves of a correctly split pair.
  ok('but a stale span note does not ride onto the pieces',
    applySplit(doc([6, 7], { notes: ['span is 2 page(s) but the document says 1'] }), [1])
      .every((d) => d.notes.length === 1), true);
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

// --- one form filed as two files --------------------------------------------
// The audit sees one block at a time, so it can say "two documents are in this
// block" and can never say "this block and the next are halves of one form".
// 834 Victoria Ln walked into that blind spot: the DIA filed as pages 1,2 plus
// a separate page 3, and the SBSA as a 1-page NeedReview plus a 14-page FX.
// Downstream the reconcile matched the WRONG half and reported the other as a
// document nothing asked for, so a split form reads as two separate problems.
//
// Rejoining is pure arithmetic and deliberately strict: the same code twice in
// one packet is NORMAL (two counter offers, two AVIDs, two brokerages' ABAs),
// so identity alone is never enough - the first half's own printed length must
// exactly account for both.
const form = (code, name, pages, declared, req, pres, doc_no = '') =>
  ({ code, name, pages, doc_no, revision: '', required_signers: req, present_signers: pres,
     strip: { declaredLength: declared } });
const rejoined = (fs) => rejoinSplitForms(fs)
  .map((f) => `${f.code || f.name}:${f.pages[0]}-${f.pages[f.pages.length - 1]}`).join(' ');

ok('the DIA is rejoined from its two pieces',
  rejoined([form('DIA', 'Disclosure Information Advisory', [1, 2], 3, ['S'], ['S']),
            form('DIA', 'Disclosure Information Advisory', [3], 3, ['S', 'B'], ['S', 'B'])]),
  'DIA:1-3');
ok('and so is the SBSA',
  rejoined([form('SBSA', 'Statewide Buyer and Seller Advisory', [8], 15, [], []),
            form('SBSA', 'Statewide Buyer and Seller Advisory',
                 Array.from({ length: 14 }, (_, i) => 9 + i), 15, ['S', 'B'], ['S', 'B'])]),
  'SBSA:8-22');
// A form cut in two leaves one half without the signature block, and on 834
// Victoria that half was the one stamped NeedReview. Taking the half that could
// actually see the signatures is what makes the rejoined status right.
ok('the rejoined form takes the fuller audit',
  rejoinSplitForms([form('SBSA', 'SBSA', [8], 15, [], []),
                    form('SBSA', 'SBSA', Array.from({ length: 14 }, (_, i) => 9 + i), 15, ['S', 'B'], ['S', 'B'])])
    [0].required_signers,
  ['S', 'B']);
ok('two numbered counter offers are NOT merged',
  rejoined([form('SCO', 'Seller Counter Offer', [1, 2], 2, ['S'], ['S'], '1'),
            form('SCO', 'Seller Counter Offer', [3, 4], 2, ['S'], ['S'], '2')]),
  'SCO:1-2 SCO:3-4');
ok('nor two AVIDs whose length does not account for both',
  rejoined([form('AVID', 'AVID', [1, 2, 3], 3, ['S'], ['S']),
            form('AVID', 'AVID', [4, 5, 6], 3, ['S'], ['S'])]),
  'AVID:1-3 AVID:4-6');
// Two brokerages' ABAs, back to back, neither printing a length - the real
// Beverly Glen pages 17 and 18.
ok('nor two same-named documents that declare no length',
  rejoined([form('', 'Affiliated Business Arrangement Disclosure Statement', [17], 0, [], []),
            form('', 'Affiliated Business Arrangement Disclosure Statement', [18], 0, [], [])]),
  'Affiliated Business Arrangement Disclosure Statement:17-17 Affiliated Business Arrangement Disclosure Statement:18-18');
ok('nor halves that do not touch',
  rejoined([form('DIA', 'DIA', [1, 2], 3, ['S'], ['S']),
            form('TDS', 'TDS', [3], 0, ['S'], ['S']),
            form('DIA', 'DIA', [4], 3, ['S'], ['S'])]),
  'DIA:1-2 TDS:3-3 DIA:4-4');

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
