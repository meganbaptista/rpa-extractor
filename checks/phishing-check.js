// checks/phishing-check.js
//
// The router's "don't click" warning: phishing-style LINKS are flagged, real
// escrow / DocuSign / newsletter mail is not.   node checks/phishing-check.js
//
// Megan, 2026-10-09: spam made to look like escrow mail; she wants the ones
// with links flagged, and NOT "property is not one of our deals".

const { check, unwrap } = require('../netlify/functions/lib/phishing-check');
const { route } = require('../netlify/functions/lib/email-router');
const cfg = require('../netlify/functions/lib/routing-config');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}
const msg = (o) => ({
  headers: { from: o.from || 'Escrow Officer <amy@firstam.com>', subject: o.subject || '123 Main St - escrow', 'reply-to': o.replyTo || '',
    'authentication-results': o.auth || 'mx.google.com; dkim=pass; spf=pass; dmarc=pass' },
  bodyHtml: o.html || '', bodyText: o.text || '', newestText: o.text || '', attachments: o.attachments || [],
});

// ---- phishing that should be flagged -------------------------------------
ok('fake DocuSign whose button goes to free hosting', check(msg({
  from: 'DocuSign <dse@docu-sign-secure.com>', subject: 'Escrow documents for 123 Main St',
  text: 'Please review and sign: your document is ready for review. Click here to view.',
  html: '<a href="https://escrow-docs-8812.firebaseapp.com/login">REVIEW DOCUMENT</a>',
})).suspicious, true);

ok('a link that shows one site and goes to another', check(msg({
  text: 'Updated escrow instructions attached below.',
  html: 'See <a href="https://login-verify.top/x">www.firstam.com/escrow</a>',
})).suspicious, true);

ok('an .html attachment', check(msg({ attachments: [{ filename: 'Escrow_Docs_123_Main.html' }] })).suspicious, true);

ok('DMARC failed + a link to free hosting', check(msg({ auth: 'mx.google.com; spf=fail; dkim=none; dmarc=fail (p=NONE)',
  html: '<a href="https://escrow-files.web.app/x">Open</a>' })).suspicious, true);

ok('shortened link + "click to view a document" + nothing attached', check(msg({
  text: 'You have a secure document waiting. Click here to view.',
  html: '<a href="https://bit.ly/3xYz">Open</a>',
})).suspicious, true);

ok('Microsoft-wrapped (SafeLinks) bad link is unwrapped and still caught', check(msg({
  text: 'A file was shared with you. View document',
  html: `<a href="https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent('https://sharepoint-file.web.app/doc')}&data=x">sharepoint.com/doc</a>`,
})).suspicious, true);

ok('wire instructions + replies to a personal Gmail + link', check(msg({
  replyTo: 'amy.escrow@gmail.com', text: 'Please use the updated wire instructions at the link.',
  html: '<a href="https://firstam.com/wire">wire info</a>',
})).suspicious, true);

// ---- real mail that must NOT be flagged ----------------------------------
ok('a real DocuSign envelope', check(msg({
  from: 'Amy via Docusign <dse_NA4@docusign.net>', subject: 'Please DocuSign: 123 Main St',
  text: 'Please review and sign. REVIEW DOCUMENT',
  html: '<a href="https://na4.docusign.net/Signing/EmailStart.aspx?a=1">REVIEW DOCUMENT</a>',
})).suspicious, false);

ok('a real Dropbox share', check(msg({
  from: 'Dropbox <no-reply@dropbox.com>', subject: 'Amy shared "123 Main disclosures" with you',
  text: 'Amy shared a folder with you. View folder',
  html: '<a href="https://www.dropbox.com/scl/fo/abc">View folder</a>',
})).suspicious, false);

ok('a newsletter whose links go through a click tracker', check(msg({
  from: 'Zillow <news@mail.zillow.com>', subject: 'Market update',
  text: 'See the latest homes',
  html: '<a href="https://click.list-manage.com/track?u=1">www.zillow.com/homes</a> <a href="https://mail.zillow.com/x">Unsubscribe</a>',
})).suspicious, false);

ok('escrow email mentions DocuSign, links only to her own site and LinkedIn', check(msg({
  text: 'I will send the escrow instructions by DocuSign for you to review the documents.',
  html: '<a href="https://www.firstam.com">firstam.com</a> <a href="https://linkedin.com/in/amy">LinkedIn</a>',
})).suspicious, false);

ok("Megan's signature Instagram handle is not a fake address", check(msg({
  from: 'Escrow <amy@firstam.com>',
  html: '@<a href="https://www.instagram.com/my.tc.concierge">My.TC.Concierge</a> <a href="http://www.mytcconcierge.com">MyTcConcierge.com</a>',
})).suspicious, false);

ok('our own outgoing email is never flagged', check(msg({
  from: 'Megan Baptista <megan@mytcconcierge.com>', attachments: [{ filename: 'x.html' }],
})).suspicious, false);

ok('a bad link in the QUOTED history does not flag the new reply', check(msg({
  html: '<div>Thanks, received!</div><div class="gmail_quote">On Mon wrote:<blockquote><a href="https://x.firebaseapp.com">www.firstam.com</a></blockquote></div>',
})).suspicious, false);

ok('an escrow signature: site, secure upload, wire-fraud warning, no-reply Reply-To', check(msg({
  from: 'Amy Lee <amy@pacificcoastescrow.com>', replyTo: 'noreply@qualia.com',
  text: 'Please see attached. WIRE FRAUD ALERT: Never trust wiring instructions sent via email. Call to verify. Send me files securely.',
  html: '<p>Please see attached.</p><a href="https://www.pacificcoastescrow.com">www.pacificcoastescrow.com</a> '
    + '<a href="https://pacificcoastescrow.sharefile.com/r-abc">Send me files securely</a> '
    + '<a href="https://www.linkedin.com/company/pce"><img src="x"></a>',
})).suspicious, false);

ok('a real DocuSign "Completed" notice (Docusign.com text, docusign.net link)', check(msg({
  from: 'Docusign via Docusign <dse_NA3@docusign.net>', subject: 'Completed: Please Docusign: Amended Escrow Instructions',
  text: 'Your document has been completed. View Completed Document. Visit Docusign.com, click Access Documents.',
  html: '<a href="https://na3.docusign.net/Signing/EmailStart.aspx?a=1">View Completed Document</a> '
    + 'Visit <a href="https://www.docusign.net/signing">Docusign.com</a> '
    + '<a href="https://apps.apple.com/app/docusign/id474990205">Download the Docusign App</a>',
})).suspicious, false);

ok('a FAKE DocuSign that fails DMARC is still caught', check(msg({
  from: 'Docusign <dse@docusign.net>', auth: 'mx.google.com; spf=fail; dkim=none; dmarc=fail',
  text: 'Your document has been completed. View Completed Document',
  html: '<a href="https://docusign-view.web.app/x">View Completed Document</a>',
})).suspicious, true);

// ---- the 2026-10-09 inbox sweep: 15 real emails, none phishing -----------
ok('sweep: DocuSign Completed, replies to docusign.com (not verified header)', check(msg({
  from: 'Docusign via Docusign <dse_NA3@docusign.net>', replyTo: 'dse@docusign.com', auth: 'mx.google.com; dkim=pass',
  text: 'Your document has been completed. View Completed Document',
  html: '<a href="https://na3.docusign.net/x">View Completed Document</a>' })).suspicious, false);
ok('sweep: Megan via DocuSign, replies to mytcconcierge.com', check(msg({
  from: 'Megan Baptista via Docusign <dse_NA3@docusign.net>', replyTo: 'megan@mytcconcierge.com', auth: '',
  text: 'Please review and sign. REVIEW DOCUMENT', html: '<a href="https://na3.docusign.net/x">REVIEW DOCUMENT</a>' })).suspicious, false);
ok('sweep: a small-business domain failing DMARC, no bad links', check(msg({
  from: '"Cristie St. James" <cristie@stjamescanter.com>', auth: 'mx.google.com; spf=fail; dmarc=fail (p=NONE)',
  text: 'Received, thank you.', html: '<a href="https://stjamescanter.com">stjamescanter.com</a>' })).suspicious, false);
ok('sweep: Compass agent signature through WiseStamp', check(msg({
  from: 'Kailee Tedesco <kailee.tedesco@compass.com>', text: 'Offer attached.',
  html: '<a href="https://link.wisestamp.com/x">www.kaileetedesco.com</a>' })).suspicious, false);
ok('sweep: escrow amendment through a link-protection service, mentions wiring', check(msg({
  from: 'Dawn Dolan <dawn@pacificcescrow.com>', text: 'Attached is the amendment. Please wire funds for closing per the instructions.',
  html: '<a href="https://url.emailprotection.link/?x">www.pacificcescrow.com</a>' })).suspicious, false);

ok('sweep: loanDepot linking its own site through its own tracking domain', check(msg({
  from: 'Brian Border <bborder@loandepot.com>', text: 'Underwriting submitted.',
  html: '<a href="https://click.email-loandepot.com/x">www.loanDepot.com</a>' })).suspicious, false);
ok('but a look-alike sender doing the same IS caught', check(msg({
  from: 'Brian Border <bborder@loandepot.com>', auth: 'mx.google.com; dmarc=fail',
  text: 'Underwriting submitted.', html: '<a href="https://click.email-loandepot.com/x">www.loanDepot.com</a>' })).suspicious, true);
ok('and showing loandepot.com but going to an unrelated site is caught', check(msg({
  from: 'Brian Border <bborder@loandepot.com>', text: 'Underwriting submitted.',
  html: '<a href="https://secure-login-portal.top/x">www.loanDepot.com</a>' })).suspicious, true);

ok('an escrow status sheet saying "Wire Instructions Issued" is not wire wording', check(msg({
  from: 'Harman, Geoff <Geoff.Harman@phegescrow.com>', auth: 'mx.google.com; spf=fail; dmarc=fail (p=NONE)',
  text: 'Buyer Contact Information Received/Wire Instructions Issued. EMD to be transferred from Portfolio Escrow.',
  html: '<a href="https://www.phegescrow.com">phegescrow.com</a>' })).suspicious, false);
ok('"our bank details have changed" still counts', check(msg({
  replyTo: 'escrow.team@gmail.com', text: 'Please note our bank details have changed. Use the attached.',
  html: '<a href="https://firstam.com/x">details</a>' })).suspicious, true);

ok('a plain escrow email with no links', check(msg({ text: 'Attached are the escrow instructions for 123 Main St.' })).suspicious, false);

ok('an escrow email linking to its own site', check(msg({
  text: 'Please log in to the portal to see the opening package.',
  html: '<a href="https://portal.firstam.com/login">portal.firstam.com</a>',
})).suspicious, false);

ok('a Proofpoint-wrapped DocuSign link stays clean', unwrap(
  'https://urldefense.proofpoint.com/v2/url?u=https-3A__na4.docusign.net_Signing&d=x'), 'https://na4.docusign.net/Signing');

// ---- the router adds the label, keeps it unread, never clears it ----------
(async () => {
  const deps = {
    runSkipGate: async () => ({ skip: true, deciding_rule: 'ack', reason: 'pure ack', confidence: 'high' }),
    classify: async () => ({}),
    dealSide: { sideForSubject: async () => null },
    config: { ...cfg, GATE: { trustedSkipConfidence: ['high'] } },
  };
  const bad = msg({ attachments: [{ filename: 'invoice.htm' }] });
  delete process.env.PHISHING_LABEL;
  const off = await route(bad, [], deps);
  ok('router: label is OFF by default (log only)', (off.actions.addLabels || []).includes(cfg.LABELS.phishing), false);
  ok('router: but the reason is logged', /log only/.test(off.reason), true);
  process.env.PHISHING_LABEL = 'on';
  const d = await route(bad, [], deps);
  ok('router: warning label added even on a would-be skip', d.actions.addLabels[0], cfg.LABELS.phishing);
  ok('router: never marked read', d.actions.markRead, false);
  ok('router: reason says why', /POSSIBLE PHISHING/.test(d.reason), true);
  const clean = await route(msg({ text: 'thanks!' }), [], deps);
  ok('router: clean mail is untouched', (clean.actions.addLabels || []).includes(cfg.LABELS.phishing), false);

  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nall phishing-check checks pass');
})();
