// checks/router-seller-client.js
//
// A sender we sent the "Seller Disclosure Package" to is a seller client;
// their files go to Ethan.   node checks/router-seller-client.js
// (2402 Alto Cerro, Oct 2026: 15 "remediation" emails Ethan never saw.)

const { route } = require('../netlify/functions/lib/email-router');
const { sellerClientFor, emailOf } = require('../netlify/functions/lib/seller-client');
const cfg = require('../netlify/functions/lib/routing-config');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

(async () => {
  // The Gmail search itself.
  const seen = [];
  const gmail = {
    listMessages: async ({ q }) => { seen.push(q); return /larryrutkowski@hotmail\.com/.test(q) ? [{ id: 'p1' }] : []; },
    getMessage: async () => ({ headers: { subject: 'Seller Disclosure Package | 2402 Alto Cerro Cir, San Diego, CA 92109' },
      newestText: 'Hi Larry,\n\nAttached is your seller disclosure package...' }),
  };
  ok('proof: we sent Larry the package', await sellerClientFor('larry rutkowski <larryrutkowski@hotmail.com>', { gmail }),
    { seller: true, property: '2402 Alto Cerro Cir, San Diego, CA 92109' });
  ok('the search is our sent mail, TO that address, with the package subject',
    /from:mytcconcierge\.com.*to:larryrutkowski@hotmail\.com \(subject:"Seller Disclosure Package"\)/.test(seen[0]), true);
  ok('an agent we never sent it to is not a seller', await sellerClientFor('Agent <agent@gmail.com>', { gmail }), { seller: false });
  ok('our own address is never checked', await sellerClientFor('Megan <megan@mytcconcierge.com>', { gmail }), { seller: false });
  ok('emailOf', emailOf('"Larry R" <LarryRutkowski@Hotmail.com>'), 'larryrutkowski@hotmail.com');

  // An AGENT on the To line of the package is not a seller (33852 Del Obispo).
  const agentGmail = {
    listMessages: async () => [{ id: 'p2' }],
    getMessage: async () => ({ headers: { subject: 'Seller Disclosure Package | 33852 Del Obispo St' },
      newestText: 'Hi Susan,\n\nAttached is your seller disclosure package...' }),
  };
  ok('Shannon (an agent on the To line) is not proven a seller', await sellerClientFor('Shannon Parks <shannon@anvilreinc.com>', { gmail: agentGmail }), { seller: false });
  ok('the greeted seller is', (await sellerClientFor('Susan Lee <susanlee@gmail.com>', { gmail: agentGmail })).seller, true);
  ok('two sellers greeted together', (await sellerClientFor('Mark Lee <mark@gmail.com>', { gmail: {
    listMessages: async () => [{ id: 'x' }], getMessage: async () => ({ headers: { subject: 'Seller Disclosure Package | 1 Main' }, newestText: 'Hello Susan and Mark,\n...' }) } })).seller, true);

  // The router.
  let classified = 0;
  const deps = {
    runSkipGate: async () => ({ skip: false, deciding_rule: 2, reason: 'attachment', confidence: 'high' }),
    classify: async () => { classified++; return { person: 'Belle', personLabels: ['Belle'], confidence: 0.9 }; },
    dealSide: { sideForSubject: async () => null },
    phishingCheck: () => ({ suspicious: false, reasons: [] }),
    sellerClientFor: async (from) => (/larry/.test(from) ? { seller: true, property: '2402 Alto Cerro Cir' } : { seller: false }),
  };
  const larry = { headers: { from: 'larry rutkowski <larryrutkowski@hotmail.com>', subject: 'FW: 2402ACC remediation 2' },
    attachments: [{ filename: 'IMG_1.jpg' }], hasAttachment: true, newestText: 'Sent via the Samsung Galaxy' };
  const d = await route(larry, [], deps);
  ok('seller client + files -> Ethan, no classifier call', [d.actions.addLabels, classified], [['Ethan'], 0]);
  ok('the log says why', /our seller client .*2402 Alto Cerro/.test(d.reason), true);

  const agent = { ...larry, headers: { ...larry.headers, from: 'Agent <agent@gmail.com>' } };
  const a = await route(agent, [], deps);
  ok('anyone else with files -> the classifier as before', [a.actions.addLabels, classified], [['Belle'], 1]);

  const question = { ...larry, attachments: [], hasAttachment: false, newestText: 'When do we close?' };
  const q = await route(question, [], deps);
  ok('a seller question with no files still goes through the classifier', classified, 2);

  // A completed purchase agreement: Allana when the deal is already in escrow.
  const pa = { headers: { from: 'Docusign via Docusign <dse_NA3@docusign.net>', subject: 'Completed: Complete with Docusign: Full Purchase Agreement | 26207 Ingleside Way' },
    attachments: [{ filename: 'Full Purchase Agreement.pdf' }], hasAttachment: true, newestText: 'All signers completed' };
  const onSheet = await route(pa, [], { ...deps, dealSide: { sideForSubject: async () => 'seller' } });
  ok('completed purchase agreement on a deal in escrow -> Allana', onSheet.actions.addLabels, ['Allana']);
  const before = classified;
  const newDeal = await route(pa, [], deps);
  ok('the same for a deal NOT on the sheet goes to the classifier (new file, Belle)', [newDeal.actions.addLabels, classified - before], [['Belle'], 1]);

  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nall seller-client checks pass');
})();
