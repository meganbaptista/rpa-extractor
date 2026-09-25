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
const { applySplit, tallyBrands, packetContext, rejoinSplitForms, resolveSigners, tokensForLabel,
        rejoinOutOfSequence } = A._internal;
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

// --- WHO WAS REQUIRED TO SIGN, read off the printed lines -------------------
// THE WORST BUG THIS PIPELINE HAS PRODUCED. On 1333 S Beverly Glen two
// affiliated business disclosures filed as FX with the sellers' signature
// lines blank: the audit reported required_signers ["B"] because the buyers
// were the only parties who HAD signed. Asking "who signed?" and "who had to
// sign?" as one question lets the second collapse into the first, and it
// collapses the dangerous way every time - FX is the one status a coordinator
// acts on without opening the file. Megan: "it broke them up and then marked
// one as FX when it wasn't."
//
// So the requirement is now computed from the transcribed lines, and a BLANK
// line counts. The model's own answer can only ADD a requirement, never
// subtract one.
const L = (label, signed) => ({ label, signed });
const signers = (audit, code = '') => {
  const r = resolveSigners(audit, code);
  return `${r.required_signers.sort().join('+') || '-'} / ${r.present_signers.sort().join('+') || '-'}`;
};

// Page 10 of that delivery, verbatim: two blank Seller lines, two signed Buyer
// lines, and a model that reported only B as required.
ok('a blank signature line still makes its party required',
  signers({ signature_lines: [L('Seller', false), L('Seller', false), L('Buyer', true), L('Buyer', true)],
            required_signers: ['B'], present_signers: ['B'] }),
  'B+S / B');
// Page 43: four lines all reading "Buyer's or Seller's Signature", two signed.
// Ambiguous labels require BOTH parties, which is the conservative reading.
ok('an ambiguous label requires both parties',
  signers({ signature_lines: [L("Buyer's or Seller's Signature", true), L("Buyer's or Seller's Signature", true),
                              L("Buyer's or Seller's Signature", false), L("Buyer's or Seller's Signature", false)],
            required_signers: ['B'], present_signers: ['B'] }),
  'B+S / B');
// The "do not pad to all four" property has to survive: it now falls out of
// only counting lines that are actually printed.
ok('a two-party agreement is still two parties',
  signers({ signature_lines: [L('Buyer', true), L("Buyer's Agent", true)],
            required_signers: ['B', 'BA'], present_signers: ['B', 'BA'] }, 'BRBC'),
  'B+BA / B+BA');
// BR is the broker signing in that capacity. A bare "Broker" line is an agent
// line and must not become BR.
ok('an office-manager line is BR',
  signers({ signature_lines: [L('By (Broker/Office Manager)', false), L('Seller', true)],
            required_signers: [], present_signers: ['S'] }),
  'BR+S / S');
ok('a bare Broker line is an agent line, not BR', tokensForLabel('Broker'), ['AGENT']);
// Agent wordings must be checked before the bare party, or "(Buyer's Agent's
// signature)" matches Buyer and routes an agent's signature to the buyer.
ok("a buyer's agent line is BA, not B", tokensForLabel("(Buyer's Agent's signature)"), ['BA']);
// An AVID's inspecting-agent line belongs to whichever side the form is.
ok('a BA AVID inspecting line is the buyer agent',
  signers({ signature_lines: [L('Inspection Performed By', true), L('Seller', false), L('Buyer', true)],
            required_signers: [], present_signers: ['BA', 'B'] }, 'AVID-BA'),
  'B+BA+S / B+BA');
ok('an LA AVID inspecting line is the listing agent',
  signers({ signature_lines: [L('Inspection Performed By', true), L('Seller', true), L('Buyer', false)],
            required_signers: [], present_signers: ['LA', 'S'] }, 'AVID-LA'),
  'B+LA+S / LA+S');
// The model's answer is a second pair of eyes on the requirement, one way only.
ok('the model can add a requirement the lines missed',
  signers({ signature_lines: [L('Buyer', true)], required_signers: ['B', 'BA'], present_signers: ['B'] }),
  'B+BA / B');
ok('but cannot claim a signer that was never required',
  signers({ signature_lines: [L('Buyer', true)], required_signers: ['B'], present_signers: ['B', 'LA'] }),
  'B / B');
// The mark-only documents have no signature lines at all; their rule lives in
// the splitter's isMarkOnlyDoc.
ok('no printed lines requires nobody',
  signers({ signature_lines: [], required_signers: [], present_signers: [] }), '- / -');
ok('junk in the lines is ignored rather than trusted',
  signers({ signature_lines: [L('', true), L('Date', true), null], required_signers: [], present_signers: [] }),
  '- / -');

// AN UNATTRIBUTABLE MISSING SIGNATURE IS A REVIEW, NOT A CHASE.
// Sotheby's ABA prints four identical "Buyer's or Seller's Signature" lines
// with no names beside them. Two were signed on the Beverly Glen packet and
// the audit called the signers the SELLERS - but their date, 09/18/2026, is
// the buyers' date everywhere else in that delivery. From the page alone it is
// undecidable, and naming the wrong party sends a coordinator to chase the
// other side for a signature their own client owes.
const amb = (audit) => resolveSigners(audit, '').signerAmbiguity;
ok('an unsigned ambiguous line is flagged',
  amb({ signature_lines: [L("Buyer's or Seller's Signature", true), L("Buyer's or Seller's Signature", false)],
        required_signers: [], present_signers: [] }),
  1);
// Ambiguity only matters when something is UNSIGNED. The Christie's version of
// the same page had all four signed, and that is simply complete.
ok('all ambiguous lines signed is not ambiguous at all',
  amb({ signature_lines: [L("Buyer's or Seller's Signature", true), L("Buyer's or Seller's Signature", true)],
        required_signers: ['S', 'B'], present_signers: ['S', 'B'] }),
  0);
ok('an explicit blank line is not ambiguous',
  amb({ signature_lines: [L('Seller', false), L('Buyer', true)],
        required_signers: ['S', 'B'], present_signers: ['B'] }),
  0);

// --- the filename a document actually lands under ---------------------------
// What Megan sees in the folder. The BA AVID is the case that started this:
// she hand-names it "BA AVID - need SS", and the old splitter called it FX.
const nameOf = (f) => `${formLabel(f)} - ${statusSuffix(f)}.pdf`;
// End to end on the file that started this: the requirement read off the
// printed lines, through the status suffix, to the name in the folder.
ok('an unattributable gap files as NeedReview rather than naming a party',
  nameOf({ code: '', name: 'Affiliated Business Disclosure',
           ...resolveSigners({ signature_lines: [L("Buyer's or Seller's Signature", true),
                                                 L("Buyer's or Seller's Signature", true),
                                                 L("Buyer's or Seller's Signature", false),
                                                 L("Buyer's or Seller's Signature", false)],
                               required_signers: ['S'], present_signers: ['S'] }, '') }),
  'Affiliated Business Disclosure - NeedReview.pdf');
ok('but all four signed is fully executed',
  nameOf({ code: '', name: 'Affiliated Business Arrangement Disclosure Statement',
           ...resolveSigners({ signature_lines: [L("Buyer's or Seller's Signature", true),
                                                 L("Buyer's or Seller's Signature", true),
                                                 L("Buyer's or Seller's Signature", true),
                                                 L("Buyer's or Seller's Signature", true)],
                               required_signers: ['S', 'B'], present_signers: ['S', 'B'] }, '') }),
  'Affiliated Business Arrangement Disclosure Statement - FX.pdf');

ok('the Coldwell Banker ABA is NeedSS, not FX',
  nameOf({ code: '', name: 'Affiliated Business Arrangement Disclosure Statement',
           ...resolveSigners({ signature_lines: [L('Seller', false), L('Seller', false),
                                                 L('Buyer', true), L('Buyer', true)],
                               required_signers: ['B'], present_signers: ['B'] }, '') }),
  'Affiliated Business Arrangement Disclosure Statement - NeedSS.pdf');

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

// --- WHOSE DOCUMENT IS IT, FIRST IN THE NAME --------------------------------
// Megan, 2026-09-24: "I would urge for the brokerage name to be before
// 'Affiliate'". A delivery routinely carries three brokerages' affiliated
// business disclosures, all printed from the same C.A.R.-less template and so
// all filing under one name - Beverly Glen gave her that name twice with a
// "(2)" and no way to tell which firm's was which without opening both.
const { brokerageName } = split._internal;

ok('a co-branded header files under the FIRM, not the team',
  brokerageName({ brokerage: "AKG | Christie's International Real Estate" }),
  "Christie's International Real Estate");
ok('an office suffix is dropped',
  brokerageName({ brokerage: 'Coldwell Banker Realty - Hancock Park' }), 'Coldwell Banker Realty');
ok('a region suffix is dropped',
  brokerageName({ brokerage: "Christie's International Real Estate Southern California" }),
  "Christie's International Real Estate");
ok('an address tail is dropped',
  brokerageName({ brokerage: "Sotheby's International Realty, 650 Madison Avenue" }),
  "Sotheby's International Realty");
// The PUBLISHER is not a brokerage; a C.A.R. form belongs to no firm.
ok('the publisher is never a brokerage',
  brokerageName({ brokerage: 'CALIFORNIA ASSOCIATION OF REALTORS' }), '');

ok("three brokerages' ABAs no longer collide",
  [{ brokerage: 'Coldwell Banker Realty' }, { brokerage: "Christie's International Real Estate" },
   { brokerage: "Sotheby's International Realty" }]
    .map((b) => formLabel({ code: '', name: 'Affiliated Business Arrangement Disclosure Statement', ...b })),
  ['Coldwell Banker Realty - Affiliated Business Arrangement Disclosure Statement',
   "Christie's International Real Estate - Affiliated Business Arrangement Disclosure Statement",
   "Sotheby's International Realty - Affiliated Business Arrangement Disclosure Statement"]);

// A C.A.R. form belongs to no brokerage, so prefixing a TDS with a firm would
// be wrong even when that firm assembled the packet.
ok('a C.A.R. form takes no firm',
  formLabel({ code: 'TDS', name: 'Real Estate Transfer Disclosure Statement', brokerage: 'Coldwell Banker Realty' }),
  'TDS - Real Estate Transfer Disclosure Statement');
// And a title that already names the firm must not say it twice.
ok('a title that already names the firm is left alone',
  formLabel({ code: '', name: 'Privacy Notice for Coldwell Banker Realty Clients', brokerage: 'Coldwell Banker Realty' }),
  'Privacy Notice for Coldwell Banker Realty Clients');
ok('even when the title omits part of the firm name',
  formLabel({ code: '', name: 'Coldwell Banker Contract Addendum and Other Greater Los Angeles Area Disclosures',
              brokerage: 'Coldwell Banker Realty' }),
  'Coldwell Banker Contract Addendum and Other Greater Los Angeles Area Disclosures');

// THE PREFIX MUST NOT BREAK THE RECONCILE. Its alias patterns are anchored at
// the start of the text, so a leading firm name would have stopped
// "Christie's International Real Estate - EQ Booklet Receipt" matching the
// booklet-receipt line: the change that made the FOLDER legible would have
// broken the DOC update.
const { aliasFor } = require('../netlify/functions/lib/compliance-doc.js')._internal;
ok('an alias still resolves past a leading firm name',
  aliasFor("Christie's International Real Estate - EQ Booklet Receipt - FX"), 'eq-booklet');
ok('and without one', aliasFor('EQ Booklet Receipt - FX'), 'eq-booklet');
// The full text is tried first, so a line that genuinely starts with an alias
// is unaffected by the lookahead.
ok('a line starting with an alias is unaffected', aliasFor('LA AVID - NeedB'), 'avid-la');
// The affiliated business disclosure is named four ways across her list and the
// forms; with no alias, "ABA -" never matched the file and the Doc went on
// asking for a form sitting in the folder.
ok('ABA on the list matches the spelled-out form',
  ['ABA -', 'Brokerage Affiliate Disclosures (If any) - Other',
   'Coldwell Banker Realty - Affiliated Business Arrangement Disclosure Statement - NeedSS',
   "Sotheby's International Realty - Affiliated Business Disclosure - NeedSS"].map(aliasFor),
  ['aba', 'aba', 'aba', 'aba']);
ok('but an unrelated form does not become an ABA',
  ['TDS - Real Estate Transfer Disclosure Statement - FX',
   'Coldwell Banker Contract Addendum and Other Greater Los Angeles Area Disclosures - NeedSS'].map(aliasFor),
  ['', '']);

// --- ONE DOCUMENT DELIVERED ACROSS NON-ADJACENT PAGES ----------------------
// Megan expects this never to happen - "nobody would send documents out of
// sequence" - and she is right about what SHOULD arrive. The 1333 S Beverly
// Glen package did it twice, and she confirmed the pairing after looking:
// "Page 17 is alone and goes with page 27, 18 is also alone and goes with 42
// and 43." Filed as fragments those cost twice: three files for two forms, and
// the reconcile then matches one piece and reports the other as a document
// nothing asks for - one form reading as two problems.
//
// Both rules below are gated hard, because joining the WRONG pages is worse
// than leaving fragments a person can see.
const piece = (pages, o = {}) => ({
  code: '', name: '', brokerage: '', parent_code: '', doc_no: '',
  required_signers: [], present_signers: [], signature_lines: [], pages,
  ...o,
  strip: { title: '', brand: '', footerName: '', ...(o.strip || {}) },
});
const joined = (fs) => rejoinOutOfSequence(fs)
  .map((f) => `[${f.pages.join(',')}]`).join(' ');
const TEMPLATE = 'Brokerage Matters/Affiliated Business Disclosure/So Cal 010926.docx';

// THE SOTHEBY'S CASE. Pages 18, 42 and 43 print the identical footer, and were
// the only pages in that packet carrying both it and no DocuSign banner.
ok('a shared footer template joins 18 + 42 + 43',
  joined([
    piece([18], { name: 'Affiliated Business Arrangement Disclosure Statement',
                  strip: { title: 'AFFILIATED BUSINESS ARRANGEMENT DISCLOSURE STATEMENT', footerName: TEMPLATE } }),
    piece([21], { code: 'RCSD-S', name: 'RCSD' }),
    piece([42, 43], { name: 'Affiliated Business Disclosure', strip: { footerName: TEMPLATE } }),
  ]),
  '[18,42,43] [21]');
// The joined form takes the name from the titled piece and the signature
// verdict from the piece that actually has the signature lines.
{
  const [f] = rejoinOutOfSequence([
    piece([18], { name: 'Affiliated Business Arrangement Disclosure Statement',
                  strip: { title: 'ABA', footerName: TEMPLATE } }),
    piece([42, 43], { name: 'Affiliated Business Disclosure', required_signers: ['B', 'S'],
                      present_signers: ['B'], strip: { footerName: TEMPLATE } }),
  ]);
  ok('the joined form is named from the titled piece',
    f.name, 'Affiliated Business Arrangement Disclosure Statement');
  ok('and audited from the piece that carries the signatures',
    `${f.required_signers.join('+')} / ${f.present_signers.join('+')}`, 'B+S / B');
  ok('and says it was delivered out of sequence', /out of sequence/.test(f.review), true);
}
// THE GUARD THAT MATTERS: the footer string is the source WORD TEMPLATE path,
// which every affiliated business disclosure Anywhere generates carries -
// Sotheby's, Coldwell Banker, Corcoran, Century 21. Alone it would fuse two
// separate disclosures. Exactly one piece may carry a title.
ok('two titled pieces on one template are two documents',
  joined([piece([18], { name: 'A', strip: { title: 'ABA', footerName: TEMPLATE } }),
          piece([42], { name: 'B', strip: { title: 'ABA', footerName: TEMPLATE } })]),
  '[18] [42]');
ok('pieces already running together are left alone',
  joined([piece([8, 9], { name: 'ABA', strip: { title: 'ABA', footerName: TEMPLATE } }),
          piece([10], { strip: { footerName: TEMPLATE } })]),
  '[8,9] [10]');
// A C.A.R. form prints its own PAGE m OF n and is contiguous by construction.
ok('a C.A.R. form is never fused',
  joined([piece([1], { code: 'TDS', strip: { title: 'TDS', footerName: TEMPLATE } }),
          piece([9], { code: 'TDS', strip: { footerName: TEMPLATE } })]),
  '[1] [9]');

// THE CHRISTIE'S CASE. Pages 17 and 27 share no footer key at all. What pairs
// them is that each is defective in a way the other explains: 17 is a titled
// disclosure with NO signature lines, 27 is nothing BUT signature lines, and
// both are Christie's. signature_lines is what makes that checkable.
const SIG = [{ label: "Buyer's or Seller's Signature", signed: true }];
ok('an orphan page of signatures joins the document that has none',
  joined([
    piece([17], { name: 'ABA', brokerage: "Christie's", strip: { title: 'ABA', brand: "Christie's" } }),
    piece([26], { name: 'PTR Advisory', brokerage: "Christie's", signature_lines: SIG,
                  strip: { title: 'PTR ADVISORY', brand: "AKG | Christie's" } }),
    piece([27], { brokerage: "Christie's", signature_lines: SIG, strip: { brand: "Christie's" } }),
  ]),
  '[17,27] [26]');
// Gated hard, because this one is inference rather than a printed key.
ok('two orphans is ambiguous, so nothing moves',
  joined([piece([17], { name: 'ABA', brokerage: 'X', strip: { title: 'ABA', brand: 'X' } }),
          piece([27], { brokerage: 'X', signature_lines: SIG, strip: { brand: 'X' } }),
          piece([37], { brokerage: 'X', signature_lines: SIG, strip: { brand: 'X' } })]),
  '[17] [27] [37]');
ok('two candidate parents is ambiguous too',
  joined([piece([17], { name: 'one', brokerage: 'X', strip: { title: 'ABA', brand: 'X' } }),
          piece([18], { name: 'two', brokerage: 'X', strip: { title: 'ABA', brand: 'X' } }),
          piece([27], { brokerage: 'X', signature_lines: SIG, strip: { brand: 'X' } })]),
  '[17] [18] [27]');
ok('a different brokerage is not a parent',
  joined([piece([17], { name: 'ABA', brokerage: 'Christies', strip: { title: 'ABA', brand: 'Christies' } }),
          piece([27], { brokerage: 'Sothebys', signature_lines: SIG, strip: { brand: 'Sothebys' } })]),
  '[17] [27]');
ok('an orphan before any parent is not joined',
  joined([piece([5], { brokerage: 'X', signature_lines: SIG, strip: { brand: 'X' } }),
          piece([17], { name: 'ABA', brokerage: 'X', strip: { title: 'ABA', brand: 'X' } })]),
  '[5] [17]');
// A document that HAS its own signature lines is complete and needs no orphan.
ok('a document with its own signature lines is not a parent',
  joined([piece([17], { name: 'ABA', brokerage: 'X', signature_lines: SIG, strip: { title: 'ABA', brand: 'X' } }),
          piece([27], { brokerage: 'X', signature_lines: SIG, strip: { brand: 'X' } })]),
  '[17] [27]');
ok('an empty packet is fine', joined([]), '');

// --- TWO BOOKLET RECEIPTS IN ONE PACKAGE ------------------------------------
// 1333 S Beverly Glen carried both: the standard C.A.R. receipt on page 25 and
// Christie's "Receipt for Links to Booklets" on page 32. Both are genuinely
// booklet receipts, the audit correctly named them both "EQ Booklet Receipt",
// and the second filed as "(2)" - which says nothing about which is which.
// The C.A.R. one is the one belonging to no firm. Megan: "maybe we change this
// version to say CAR EQ Booklet Receipt... and then the others can reference
// the brokerage".
ok('the C.A.R. receipt names itself',
  formLabel({ code: '', name: 'EQ Booklet Receipt', brokerage: '' }),
  'CAR EQ Booklet Receipt');
ok("and a brokerage's names its firm instead",
  formLabel({ code: '', name: 'EQ Booklet Receipt', brokerage: "AKG | Christie's International Real Estate" }),
  "Christie's International Real Estate - EQ Booklet Receipt");
// Naming them apart must not stop either matching her compliance line, or the
// Doc would go on asking for a receipt sitting in the folder. "CAR " is not a
// firm name, so the leading-firm lookahead cannot strip it.
{
  const { fileKey } = require('../netlify/functions/lib/compliance-doc.js');
  ok('both still answer the same list line',
    ['CAR EQ Booklet Receipt - FX.pdf',
     "Christie's International Real Estate - EQ Booklet Receipt - FX.pdf"].map((f) => fileKey(f).key),
    ['eq-booklet', 'eq-booklet']);
  ok('as does her wording of it',
    aliasFor('Earthquake Booklet Receipt (check if we got the brokerage version) -'), 'eq-booklet');
}
// The rule is exact: it must not rewrite a differently-named receipt.
ok('a differently named receipt is left alone',
  formLabel({ code: '', name: 'Receipt for Links to Booklets', brokerage: '' }),
  'Receipt for Links to Booklets');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
