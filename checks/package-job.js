// checks/package-job.js
//
// Stage 3 of the automatic buyer package: the compliance-Doc reader and the
// intake job's `package` step rules (buyer side only, Blobs mode switch, one
// trial draft, never fails the job). Made-up data; the real dry runs are
// ~/Code/rpkg-tools/package-dry.js.
//   node checks/package-job.js

const { parseCompliance } = require('../netlify/functions/lib/package-inputs.js');
const PJ = require('../netlify/functions/lib/package-job.js');
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

const DOC = [
  'COMPLIANCE AUDIT LIST | 1 Main St, Orange, CA 92867',
  'BROKER SYSTEM UPLOAD PLATFORM: SIDE DASHBOARD ',
  '', 'NOTES: 2 buyers: ', '',
  'PURCHASE DOCUMENTS',
  '* FHDA',
  '* WFA - followed up',
  '* SIDE ABA',
  '* BCA - Buyer Signed (check BRBC package) - followed up',
  'BROKER OPENING ESCROW DOCUMENTS',
  '* NHD',
  'DISCLOSURES',
  '* DIA',
  '* TDS C,12,13,14 = YES, there is an HOA',
  '* SPQ 17G: Yes, high fire brush clearance',
  '* BHAA',
  '* Brokerage Affiliate Disclosures (If any) - Compass (Orange County Bayside)',
  '* Orange County Local Area Disclosures',
  'CLOSING PACKAGE ITEMS:',
  '* Prelim Receipt',
].join('\r\n');

(async () => {
  const p = parseCompliance(DOC);
  ok('wanted codes come from DISCLOSURES only', p.wantedCodes.join(), 'DIA,TDS,SPQ,BHAA');
  ok('contract items from PURCHASE DOCUMENTS, notes dropped', p.contractItems.map((c) => c.name).join('|'), 'FX - FHDA|FX - WFA|FX - SIDE ABA|FX - BCA');
  ok('a brokerage ABA keeps its brokerage', JSON.stringify(p.contractItems[2]), JSON.stringify({ code: 'ABA', brokerage: 'SIDE', name: 'FX - SIDE ABA' }));
  ok('escrow-opening NHD is not a contract item', p.contractItems.some((c) => c.code === 'NHD'), false);
  ok('buyer brokerage from the affiliate line', p.brokerage, 'Compass');
  ok('else from the platform line', parseCompliance(DOC.replace(/\* Brokerage Affiliate[^\r]*\r\n/, '')).brokerage, 'Side');
  ok('no Doc = nothing wanted, nothing FX', JSON.stringify([parseCompliance('').wantedCodes, parseCompliance('').contractItems]), '[[],[]]');

  // ---- the step ----
  const mem = new Map();
  const store = {
    get: async (k) => mem.get(k) || null,
    setJSON: async (k, v) => { mem.set(k, v); },
    set: async (k, v) => { mem.set(k, v); },
  };
  const alerts = [];
  const job = { id: 'j1', address: '1 Main St, Orange, CA 92867', docs: [], extras: [], source: { subject: 's', from: 'f' } };
  const ctx = (attempt = 1) => ({ store, job, attempt, log: () => {}, alert: async (k, m) => { alerts.push(m); } });
  const run = async (c) => { const j = { status: 'running' }; (await PJ.packageStep(c))(j); return j; };

  mem.set('meta/package-mode', { mode: 'off' });
  ok('mode off: the job just closes', (await run(ctx())).packageOutcome, 'package: off');
  job.packageMode = 'shadow';
  ok('off wins over a per-job trial', (await run(ctx())).packageOutcome, 'package: off');
  delete job.packageMode;
  mem.delete('meta/package-mode');
  ok('no mode set = shadow (trial only)', await PJ.packageMode(store), 'shadow');

  // A failure on an early try is retried (throws); on the last try it alerts and closes.
  const broken = { ...ctx(1), core: null, drive: null, packageDeps: { side: async () => 'buyer' } };
  const threw = await PJ.packageStep(broken).then(() => 'closed', () => 'retry');
  ok('a failure before the last try is retried', threw, 'retry');
  const last = await run({ ...ctx(3), core: null, drive: null, packageDeps: { side: async () => 'buyer' } });
  ok('on the last try it alerts and the job still closes', `${last.status}:${/package failed/.test(last.packageOutcome)}:${alerts.length}`, 'done:true:1');

  // Buyer side only.
  const sideCtx = { ...ctx(), core: {}, drive: {} };
  ok('a listing-side deal is skipped', (await PJ.buildForJob(sideCtx, { side: async () => 'seller' })).skip, 'not a buyer-side deal (seller)');
  ok('a dual / unknown deal is skipped', (await PJ.buildForJob(sideCtx, { side: async () => null })).skip, 'not a buyer-side deal (side unknown or dual)');

  // One trial draft per job.
  mem.set('out/j1/package-effects', { trialDraft: 'd1' });
  ok('a second run makes no second draft', (await run(ctx())).packageOutcome, 'package: trial draft already made');

  // A duplex address finds her single-number deal folder (4180 - 4182 Sunnyslope).
  const R = require('../netlify/functions/lib/buyer-revision.js');
  const names = ['4180 Sunnyslope Ave, Sherman Oaks, CA 91423', '41800 Sunnyslope Ave', '4180 Sunnyslope Blvd'];
  const fakeDrive = { findFoldersNameContains: async (t) => names.filter((n) => n.toLowerCase().includes(t.toLowerCase())).map((n) => ({ id: n, name: n })), listChildren: async () => [] };
  ok('"4180 - 4182" finds the "4180 ..." folder', (await R.findDealFolder(fakeDrive, '4180 - 4182 Sunnyslope Ave, Sherman Oaks, CA 91423')).folder.name, names[0]);
  ok('streetOf drops the range', R.streetOf('4180 - 4182 Sunnyslope Ave, Sherman Oaks'), '4180 Sunnyslope Ave');

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall package-job checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
