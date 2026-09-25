// checks/disclosure-reply.js
//
// Pins the reply to the coordinator who sent the package.
//   node checks/disclosure-reply.js
//
// This is the only thing the pipeline writes that another firm reads, under
// Megan's name, so the wording is asserted rather than eyeballed. Two earlier
// versions were wrong in ways no test would have caught but a reader would:
// the first asked the other side for what they owed (nothing, on both real
// deliveries - everything outstanding was ours), the second recited what had
// arrived (a manifest of things the recipient had just sent). The body is now
// her compliance checklist verbatim, which is what she asked for: "what if we
// illustrate more of the google docs checklist... After my audit, here is
// where the file stands on my end".

const { buildReply, owedBy, partyWords } = require('../netlify/functions/lib/disclosure-reply.js');
const gmail = require('../netlify/functions/lib/gmail.js');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}
/**
 * The body as plain text, which is how a reader meets it.
 *
 * Entities are decoded, so an assertion can be written the way the line will
 * actually READ rather than the way it is stored.
 */
const text = (html) => html
  .replace(/<\/p>|<\/li>/g, '\n').replace(/<li>/g, '- ')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .split('\n').map((l) => l.trim()).filter(Boolean);

// --- HER LIST, VERBATIM -----------------------------------------------------
// Reformatting her wording is how it stops being her list, so the lines pass
// through untouched - including the notes she keeps on them.
{
  const r = buildReply({
    address: '834 Victoria Ln, Sugarloaf, CA 92386',
    senderName: 'Dana Whitfield',
    outstanding: [
      { text: 'LA AVID', action: 'keep' },
      { text: 'BA AVID - NeedSS', action: 'annotate' },
      { text: 'VP - once completed', action: 'keep' },
    ],
  });
  const body = text(r.htmlBody);
  ok('greets the sender by first name', body[0], 'Hi Dana,');
  ok('opens with what is still pending',
    /Thanks so much for these! After my audit, here is what is still pending from the file:/.test(body[1]), true);
  ok('carries every line exactly as the Doc has it',
    body.filter((l) => l.startsWith('- ')),
    ['- LA AVID', '- BA AVID - NeedSS', '- VP - once completed']);
  // Her own trailing notes survive, so "VP - once completed" needs no special
  // handling: it lives in the Doc and the reply passes it on.
  ok('a note she keeps on a line is not stripped',
    body.some((l) => l === '- VP - once completed'), true);
  ok('counts the open lines', r.asks, 3);
}

// A sender with no display name gets a bare greeting rather than a guess: an
// email under her name to another firm is not the place to invent a name from
// "transactions@sothebys.realty".
ok('no sender name gives a bare greeting',
  text(buildReply({ address: 'X', outstanding: [{ text: 'A' }] }).htmlBody)[0], 'Hi,');

// --- NOTHING OUTSTANDING ----------------------------------------------------
// The whole point of the audit is that this happens often. It must not send an
// empty list under a heading promising one.
{
  const r = buildReply({ address: '834 Victoria Ln', outstanding: [], senderName: 'Dana' });
  const body = text(r.htmlBody);
  ok('a clear file says so instead of listing nothing',
    /everything on my checklist for 834 Victoria Ln is accounted for/.test(body.join(' ')), true);
  ok('and asks for nothing', r.asks, 0);
  ok('and offers no empty list', body.filter((l) => l.startsWith('- ')), []);
}

// --- THE TWO THINGS THAT ARE GENUINELY QUESTIONS FOR THEM -------------------
{
  const r = buildReply({
    address: 'X', outstanding: [{ text: 'A' }], senderName: 'Lesley',
    unsortedPages: [27], outOfSequence: [{ filename: 'a' }, { filename: 'b' }],
  });
  const body = text(r.htmlBody).join(' ');
  ok('an unidentified page is asked about', /page 27 in the package I could not identify/.test(body), true);
  // Plural agreement, because "2 documents had ITS pages split up" shipped once.
  ok('and the out-of-sequence note agrees in number',
    /2 documents in the package had their pages split up/.test(body), true);
  ok('and says no action is needed on it', /No action needed, I have put them back together/.test(body), true);
}
{
  const body = text(buildReply({ address: 'X', outstanding: [{ text: 'A' }],
                                 unsortedPages: [5], outOfSequence: [{ filename: 'a' }] }).htmlBody).join(' ');
  ok('one page reads as singular', /page 5 in the package .*what that is/.test(body), true);
  ok('and one document too', /a document in the package had its pages split up/.test(body), true);
}

// --- ESCAPING ---------------------------------------------------------------
// Her lines are free text in a Google Doc and the body is HTML.
ok('a line with angle brackets or an ampersand is escaped',
  text(buildReply({ address: 'X', outstanding: [{ text: 'A & B <tag>' }] }).htmlBody)
    .some((l) => l === '- A & B <tag>'), true);
ok('and the raw HTML carries the entities',
  /A &amp; B &lt;tag&gt;/.test(buildReply({ address: 'X', outstanding: [{ text: 'A & B <tag>' }] }).htmlBody), true);
// A blank or malformed line must not become an empty bullet.
ok('empty and malformed lines are dropped',
  buildReply({ address: 'X', outstanding: [{ text: '  ' }, null, { text: 'Real' }] }).asks, 1);

// --- WHO OWES WHAT, still used by the status vocabulary ---------------------
ok('our own side is ours', [owedBy('NeedSS'), owedBy('NeedLA'), owedBy('NeedSS+LA')], ['us', 'us', 'us']);
ok('their side is theirs', [owedBy('NEEDB'), owedBy('NeedBA')], ['them', 'them']);
ok('executed is done', owedBy('FX'), 'done');
// A broker signature carries NO side - either brokerage can owe it - so it is
// never assigned to one.
ok('a broker signature is sideless', owedBy('NeedBroker(s)'), 'unclear');
ok('and so is an unreadable one', owedBy('NeedReview'), 'unclear');
ok('parties are named once each', partyWords('NeedSS+LA'), ['the seller', 'the listing agent']);

// --- FINDING THE THREAD -----------------------------------------------------
// A quoted Gmail phrase matches CONTIGUOUS words, so "1333 Beverly" would
// never match "1333 S Beverly Glen". Unquoted, Gmail ANDs the terms.
ok('the search term is unquoted, and drops the directional',
  ['834 Victoria Ln, Sugarloaf, CA 92386', '1333 S Beverly Glen Blvd #902, Los Angeles, CA 90024',
   '107 N Bentley Ave'].map(gmail.addressSearchTerm),
  ['834 Victoria', '1333 Beverly', '107 Bentley']);
ok('an unparseable address searches for nothing at all',
  [gmail.addressSearchTerm('nonsense'), gmail.addressSearchTerm('')], ['', '']);
ok('a display name is used', gmail.senderNameOf('"Lesley Ann Carter" <l@x.com>'), 'Lesley Ann Carter');
ok('and a bare address yields no name', gmail.senderNameOf('transactions@sothebys.realty'), '');
ok('nor does an address sitting in the name slot', gmail.senderNameOf('"x@y.com" <x@y.com>'), '');

// --- LINES THAT NEVER LEAVE THE DOC -----------------------------------------
// Her checklist mixes items the other side has a part in with items purely
// ours. "MLS CLIENT TO SIGN" is the second kind: our own client signing our
// own MLS paperwork is nothing the buyer's coordinator can act on. Megan:
// "Could we make a rule to never show the 'MLS CLIENT TO SIGN' bullet point?"
const { isInternalOnly, isExcludedSection } = require('../netlify/functions/lib/disclosure-reply.js');
ok('the internal line is hidden however it is punctuated',
  ['MLS CLIENT TO SIGN', 'mls client to sign', 'MLS Client to Sign',
   'MLS CLIENT TO SIGN - by Friday'].map(isInternalOnly),
  [true, true, true, true]);
// Narrow on purpose: a line that merely STARTS with MLS is a different item.
ok('a different MLS line is not hidden', [isInternalOnly('MLS'), isInternalOnly('MLS Printout')],
  [false, false]);
ok('and nothing else is swept up',
  ['LA AVID', 'BA AVID - NeedSS', 'VP - once completed'].map(isInternalOnly),
  [false, false, false]);
{
  const r = buildReply({ address: 'X', senderName: 'Dana', outstanding: [
    { text: 'MLS CLIENT TO SIGN' }, { text: 'LA AVID' }, { text: 'VP - once completed' }] });
  ok('it is absent from the body and from the count',
    [text(r.htmlBody).filter((l) => l.startsWith('- ')), r.asks],
    [['- LA AVID', '- VP - once completed'], 2]);
}
// If every open line is internal, the reply must read as clear rather than
// printing an empty list under a heading promising one.
{
  const r = buildReply({ address: 'X', outstanding: [{ text: 'MLS CLIENT TO SIGN' }] });
  ok('an all-internal list reads as nothing outstanding',
    [/is accounted for/.test(r.htmlBody), r.asks], [true, 0]);
}

// A whole section can be out of scope for the email even though every line in
// it is genuinely outstanding on the Doc. Her list keeps CLOSING PACKAGE ITEMS
// under its own heading: prelim receipt, FIRPTA, commission instructions,
// closing statement, escrow signings. All six reached the first live draft.
ok('a section heading is matched with or without its colon',
  ['CLOSING PACKAGE ITEMS:', 'closing package items', 'Closing Package Items'].map(isExcludedSection),
  [true, true, true]);
ok('and the sections that belong in the email are kept',
  ['DISCLOSURES', 'NOTES:', ''].map(isExcludedSection), [false, false, false]);
{
  const r = buildReply({ address: 'X', senderName: 'Jennifer', outstanding: [
    { text: 'LA AVID', section: 'DISCLOSURES' },
    { text: 'VP - once completed', section: 'DISCLOSURES' },
    { text: 'Prelim Receipt', section: 'CLOSING PACKAGE ITEMS:' },
    { text: 'QS / FIRPTA', section: 'CLOSING PACKAGE ITEMS:' },
    { text: 'Escrow Instructions Signed', section: 'CLOSING PACKAGE ITEMS:' }] });
  ok('the closing package never reaches the email',
    [text(r.htmlBody).filter((l) => l.startsWith('- ')), r.asks],
    [['- LA AVID', '- VP - once completed'], 2]);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
