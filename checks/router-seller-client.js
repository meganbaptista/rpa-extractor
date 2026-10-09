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
    getMessage: async () => ({ headers: { subject: 'Seller Disclosure Package | 2402 Alto Cerro Cir, San Diego, CA 92109' } }),
  };
  ok('proof: we sent Larry the package', await sellerClientFor('larry rutkowski <larryrutkowski@hotmail.com>', { gmail }),
    { seller: true, property: '2402 Alto Cerro Cir, San Diego, CA 92109' });
  ok('the search is our sent mail, TO that address, with the package subject',
    /from:mytcconcierge\.com.*to:larryrutkowski@hotmail\.com \(subject:"Seller Disclosure Package"\)/.test(seen[0]), true);
  ok('an agent we never sent it to is not a seller', await sellerClientFor('Agent <agent@gmail.com>', { gmail }), { seller: false });
  ok('our own address is never checked', await sellerClientFor('Megan <megan@mytcconcierge.com>', { gmail }), { seller: false });
  ok('emailOf', emailOf('"Larry R" <LarryRutkowski@Hotmail.com>'), 'larryrutkowski@hotmail.com');

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

  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nall seller-client checks pass');
})();
