// checks/page-strips.js
//
// Pins the document-boundary rules without rendering a PDF or calling a model.
//   node checks/page-strips.js
//
// Why this file exists. The splitter used to hand a whole packet to one model
// call and ask for the complete split map. On the 65-page 1333 S Beverly Glen
// delivery it returned a plausible, incomplete answer - 73 of 110 pages filed,
// the cooperating broker's disclosures and the buyer agent's AVID silently
// absent. Coverage was an implicit property of that answer, so 37 unfiled
// pages looked exactly like none.
//
// page-strips.js replaces it with: transcribe the labels at the edge of each
// page (a model, batched small), then work out spans IN CODE. Everything
// asserted below is that second half, which means it is testable, and every
// single rule here was added because a real packet broke without it.

const S = require('../netlify/functions/lib/page-strips.js');
const { footerDocName, footerNameChanged, footerNamesAgree } = S._internal;

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

/** A strip row with everything empty except what a case is about. */
const row = (page, o = {}) =>
  ({ page, title: '', brand: '', carCode: '', carName: '', m: 0, n: 0,
     counter: '', footerName: '', unread: false, ...o });

/** Spans as "pp1-3 pp4" for readable assertions. */
const spans = (rows) => S.documentsFromStrips(rows)
  .map((d) => {
    const a = d.pages[0], b = d.pages[d.pages.length - 1];
    return a === b ? `pp${a}` : `pp${a}-${b}`;
  }).join(' ');

// --- reading a page counter -------------------------------------------------
ok('PAGE m OF n', S.parseCounter('Page 2 of 3'), { m: 2, n: 3 });
ok('bare m of n', S.parseCounter('3 of 3'), { m: 3, n: 3 });
// Page 19 of the Beverly Glen packet prints "Page 1/3" and nothing else, so
// without the slash form a three-page report states its length unheard.
ok('slash form', S.parseCounter('Page 1/3'), { m: 1, n: 3 });
ok('bare position', S.parseCounter('2'), { m: 2, n: 0 });
// A revision stamp is not a counter. Read as one, "6/2022" declares a
// 2022-page document, and a declared length CLAIMS the pages after it - so
// this single misread would have swallowed a whole packet into one document.
ok('a revision stamp is not a counter', S.parseCounter('Rev. 6/2022'), { m: 0, n: 0 });
ok('nor a bare slashed date', S.parseCounter('6/2022'), { m: 0, n: 0 });
ok('nor a backwards counter', S.parseCounter('3 of 1'), { m: 0, n: 0 });
ok('nothing', S.parseCounter(''), { m: 0, n: 0 });

// --- what survives as a footer DOCUMENT NAME --------------------------------
// The name is compared page to page, so anything page-specific inside it
// manufactures a boundary on every page of a multi-page document.
ok('a C.A.R. footer counter is not part of the name',
  footerDocName('FAIR HOUSING AND DISCRIMINATION ADVISORY (FHDA PAGE 1 OF 2)'),
  'fair housing and discrimination advisory');
ok('a trailing page number is not part of the name',
  footerDocName('DISCLOSURES - GREATER AREA LOS ANGELES (Rev. - February 2021) page 4'),
  'disclosures greater area los angeles');
ok('a bare revision names nothing', footerDocName('Rev. 6/2022'), '');
ok('publisher boilerplate names nothing',
  footerDocName('Revised 09/10 Official C.A.R. Publication 09/10'), '');

// --- the footer-name boundary, which SPLITS and so must be conservative -----
ok('two genuinely different documents split',
  footerNameChanged('Mold Disclosure and Agreement rev 4/17',
                    'GLA Addendum to Real Estate Purchase Agreement rev 4/17'), true);
ok('one document named at two lengths does not',
  footerNameChanged('Affiliated Business Arrangement Disclosure rev 4/17',
                    'Affiliated Business Arrangement Disclosure'), false);
ok('a bare revision cannot contradict a name',
  footerNameChanged('Rev. 6/2022', 'Environmental Hazards Advisory  Revised 11/19'), false);
// Coldwell Banker prints its document name on the LAST page of a span, so a
// name appearing where there was none is the middle of a document.
ok('a name appearing where there was none is not a boundary',
  footerNameChanged('', 'GLA Addendum to Real Estate Purchase Agreement'), false);

// Positive agreement is a stronger claim than "nothing contradicts", because
// it is used to OVERRULE a header title. Two blank footers must not qualify.
ok('two blank footers do not agree', footerNamesAgree('', ''), false);
ok('one blank footer does not agree', footerNamesAgree('', 'Mold Disclosure'), false);
ok('the same name agrees',
  footerNamesAgree('Mold Disclosure rev 4/17', 'Mold Disclosure rev 4/17'), true);

// --- the boundary rules, end to end ----------------------------------------
ok('a C.A.R. PAGE 1 OF n starts a document and claims n pages',
  spans([row(1, { title: 'MCA', carCode: 'MCA', m: 1, n: 2 }),
         row(2, { carCode: 'MCA', m: 2, n: 2 }),
         row(3, { title: 'TA', carCode: 'TA', m: 1, n: 2 }),
         row(4, { carCode: 'TA', m: 2, n: 2 })]),
  'pp1-2 pp3-4');

// Christie's sets its title a fifth of the way down; a page with the brand and
// no title is a continuation, which is how a branded packet marks its own.
ok('an untitled branded page continues the document above it',
  spans([row(1, { title: 'BUYER PTR ADVISORY', brand: "AKG | Christie's" }),
         row(2, { brand: "AKG | Christie's" }),
         row(3, { title: 'WATER RESTRICTIONS ADVISORY', brand: "AKG | Christie's" })]),
  'pp1-2 pp3');

// THE FHDA CASE. Beverly Glen page 12 reads "FHDA PAGE 2 OF 2" in its footer,
// which differs from page 11's "PAGE 1 OF 2" as a string. Before the counter
// was stripped AND before a declared length outranked a weak signal, this
// filed two one-page FHDAs and neither was the form.
ok('a declared length is not broken by a footer name carrying a counter',
  spans([row(11, { title: 'FAIR HOUSING AND DISCRIMINATION ADVISORY', carCode: 'FHDA', m: 1, n: 2,
                   footerName: 'FAIR HOUSING AND DISCRIMINATION ADVISORY (FHDA PAGE 1 OF 2)' }),
         row(12, { carCode: 'FHDA', m: 2, n: 2,
                   footerName: 'FAIR HOUSING AND DISCRIMINATION ADVISORY (FHDA PAGE 2 OF 2)' })]),
  'pp11-12');

ok('nor by a stray code on an inner page',
  spans([row(1, { title: 'TDS', carCode: 'TDS', m: 1, n: 3 }),
         row(2, { carCode: 'XYZ' }),
         row(3, { carCode: 'TDS', m: 3, n: 3 })]),
  'pp1-3');

// THE ACKNOWLEDGMENT CASE. Beverly Glen page 43 sets "ACKNOWLEDGMENT" a
// quarter of the way down, above the signature lines, continuing the
// affiliated-business disclosure from page 42 - and both pages print the same
// document name in the footer. The footer is explicit about identity where a
// bare heading is not, so it overrules the title.
const SAME = 'Brokerage Matters/Affiliated Business Disclosure/So Cal 010926.docx';
ok('a section heading does not split a document its footer still names',
  spans([row(42, { footerName: SAME }),
         row(43, { title: 'ACKNOWLEDGMENT', footerName: SAME })]),
  'pp42-43');
ok('but a title DOES split when the footer names a different document',
  spans([row(1, { title: 'MOLD', footerName: 'Mold Disclosure and Agreement' }),
         row(2, { title: 'GLA ADDENDUM', footerName: 'GLA Addendum to Purchase Agreement' })]),
  'pp1 pp2');
ok('and a title splits when the footers say nothing either way',
  spans([row(1, { title: 'MOLD DISCLOSURE' }), row(2, { title: 'PRIVACY NOTICE' })]),
  'pp1 pp2');

// A title inside a declared span still splits - a misread n is possible - but
// the disagreement is recorded on BOTH halves rather than silently resolved,
// because either answer files half a form.
{
  const docs = S.documentsFromStrips([
    row(1, { title: 'DISCLOSURE INFORMATION ADVISORY', carCode: 'DIA', m: 1, n: 3 }),
    row(2, { title: 'MOLD DISCLOSURE AND AGREEMENT' }),
    row(3, {})]);
  ok('a title splits a declared span when nothing says otherwise',
    docs.map((d) => d.pages.length), [1, 2]);
  // Worded from each document's own point of view. One shared note read as if
  // the SECOND document were the short one, which on 834 Victoria Ln put
  // "DIA declared 3 pages and only got 1" on the ESD that followed it.
  ok('the short document says it is short',
    /declared 3 pages and only got 1/.test(docs[0].notes.join(' ')), true);
  ok('and the new one says only where it starts',
    /starts inside DIA's declared span/.test(docs[1].notes.join(' ')), true);
}

// --- 834 VICTORIA LN: TWO FORMS FILED IN TWO PIECES EACH --------------------
// The real regression, 2026-09-24. Widening the header strip to 30% to catch
// Christie's low titles also caught SECTION headings on continuation pages, and
// a title was allowed to split a declared span. Both of these filed one form as
// two files, and the compliance reconcile downstream then matched the wrong half
// and reported the other half as a document nothing asked for.
//
// A title read off a strip is inference. A page number printed beside the
// form's own code is a statement, and it wins.
ok('the DIA is not split by "EXEMPT SELLER DISCLOSURE" on its own page 3',
  spans([row(1, { title: 'DISCLOSURE INFORMATION ADVISORY', carCode: 'DIA', m: 1, n: 3 }),
         row(2, { carCode: 'DIA', m: 2, n: 3 }),
         row(3, { title: 'EXEMPT SELLER DISCLOSURE ("ESD")', carCode: 'DIA', m: 3, n: 3 }),
         row(4, { title: 'EXEMPT SELLER DISCLOSURE', carCode: 'ESD', m: 1, n: 1 })]),
  'pp1-3 pp4');

ok('nor the SBSA by "TABLE OF CONTENTS" on its own page 2',
  spans([row(8, { title: 'STATEWIDE BUYER AND SELLER ADVISORY', carCode: 'SBSA', m: 1, n: 15 }),
         row(9, { title: 'TABLE OF CONTENTS', carCode: 'SBSA', m: 2, n: 15 }),
         ...Array.from({ length: 13 }, (_, i) => row(10 + i, { carCode: 'SBSA', m: 3 + i, n: 15 })),
         row(23, { title: 'SQUARE FOOTAGE AND LOT SIZE ADVISORY', carCode: 'SFLS', m: 1, n: 1 })]),
  'pp8-22 pp23');

// The evidence has to be the NEXT page number, not just a matching code: a
// second copy of the same form in one packet (two counter offers, two AVIDs)
// must still be two documents.
ok('a second copy of the same form still starts a new document',
  spans([row(1, { title: 'SELLER COUNTER OFFER', carCode: 'SCO', m: 1, n: 2 }),
         row(2, { carCode: 'SCO', m: 2, n: 2 }),
         row(3, { title: 'SELLER COUNTER OFFER', carCode: 'SCO', m: 1, n: 2 }),
         row(4, { carCode: 'SCO', m: 2, n: 2 })]),
  'pp1-2 pp3-4');

// And a title on a page that does NOT number itself as the next page still
// splits - otherwise a matching code would merge two unrelated forms.
ok('a titled page numbered out of sequence still splits',
  spans([row(1, { title: 'TRUST ADVISORY', carCode: 'TA', m: 1, n: 3 }),
         row(2, { title: 'MOLD DISCLOSURE', carCode: 'TA', m: 7, n: 9 })]),
  'pp1 pp2');

// A span that disagrees with its own printed length is reported, never fixed
// silently. Beverly Glen page 19 is page 1 of a 3-page property report and the
// other two pages were never in the delivery - which is worth saying out loud.
{
  const [d] = S.documentsFromStrips([row(19, { counter: 'Page 1/3', footerName: 'Property Details' })]);
  ok('a short span says so, and that it could not be named',
    d.notes, ['span is 1 page(s) but the document says 3',
              'no title and no C.A.R. code printed on its pages']);
}
{
  const [d] = S.documentsFromStrips([
    row(1, { title: 'PRIVACY NOTICE' }), row(2, {}), row(3, { counter: '2' })]);
  ok('a last page numbered below the span length says so',
    d.notes, ['span is 3 page(s) but its last page is numbered 2']);
}

// --- THE COVERAGE INVARIANTS ------------------------------------------------
// This is the guarantee the old splitter could not make. It is subtraction
// over a set, so it is checked by construction rather than believed: whatever
// the labels say, every page lands in exactly one document, and every span is
// contiguous. A rule added later cannot quietly drop or duplicate a page.
{
  // A deterministic pseudo-random sweep over label combinations, including the
  // degenerate ones: all blank, every page titled, contradictory counters.
  let seed = 20260923;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const TITLES = ['', '', '', 'MOLD DISCLOSURE', 'ACKNOWLEDGMENT', 'PRIVACY NOTICE'];
  const CODES = ['', '', 'TDS', 'SPQ', 'AVID'];
  const FOOTERS = ['', '', 'Mold Disclosure', 'GLA Addendum', 'Rev. 6/2022'];
  let broke = null;
  for (let trial = 0; trial < 400 && !broke; trial++) {
    const count = 1 + rnd(70);
    const rows = [];
    for (let p = 1; p <= count; p++) {
      const n = rnd(4);
      rows.push(row(p, { title: TITLES[rnd(TITLES.length)], carCode: CODES[rnd(CODES.length)],
                         m: rnd(4), n, counter: rnd(3) ? '' : `${1 + rnd(3)} of ${1 + rnd(3)}`,
                         footerName: FOOTERS[rnd(FOOTERS.length)] }));
    }
    const docs = S.documentsFromStrips(rows);
    const seen = [];
    for (const d of docs) {
      for (let i = 1; i < d.pages.length; i++) {
        if (d.pages[i] !== d.pages[i - 1] + 1) broke = `trial ${trial}: span not contiguous`;
      }
      seen.push(...d.pages);
    }
    if (seen.length !== count) broke = broke || `trial ${trial}: ${seen.length} pages placed of ${count}`;
    if (new Set(seen).size !== seen.length) broke = broke || `trial ${trial}: a page was placed twice`;
    if (S.unclaimedPages(docs, count).length) broke = broke || `trial ${trial}: unclaimed pages`;
  }
  ok('every page lands in exactly one contiguous span, over 400 label mixes', broke, null);
}

// Order of input must not matter: the strips arrive per batch and a batch can
// come back out of order.
ok('shuffled input gives the same spans',
  spans([row(3, { carCode: 'TDS', m: 3, n: 3 }), row(1, { title: 'TDS', carCode: 'TDS', m: 1, n: 3 }),
         row(2, { carCode: 'TDS', m: 2, n: 3 })]),
  'pp1-3');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
