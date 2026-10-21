// checks/intake-job.js
//
// Proves the intake job's guarantees without deploying:
//   node checks/intake-job.js
//
// 1. Steps run in order, one at a time, and two invocations can never hold the
//    same step (the duplicate-draft failure).
// 2. A failed step is retried, then gives up: optional steps (identify/review)
//    let the job carry on and say so; required steps fail the job once.
// 3. A dead invocation's step is re-claimed after its lease runs out.
// 4. Page accounting is arithmetic and names every unmatched page.

// No read-back pause in the sequential checks; the race checks below pass
// their own pause explicitly.
process.env.INTAKE_JOB_VERIFY_MS = '0';
const J = require('../netlify/functions/lib/intake-job.js');
const { memoryStore } = require('./lib/memory-store.js');

let failed = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { failed++; console.error(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
  else console.log(`pass  ${label}`);
}

(async () => {
  const T0 = Date.UTC(2026, 9, 21, 12);
  const src = { messageId: 'abc123', threadId: 't1', from: 'tc@listing.com', subject: 'Seller Disclosures' };

  // --- ids ------------------------------------------------------------------
  ok('job id is stable per message', J.jobIdFor('abc123'), 'j_abc123');
  ok('a re-run gets its own id', J.jobIdFor('abc123', 2), 'j_abc123_r2');

  // --- creation is idempotent -------------------------------------------------
  const store = memoryStore();
  const job = J.newJob({ id: 'j_abc123', mode: 'shadow', source: src, now: T0 });
  ok('first create wins', await J.createJob(store, job), true);
  ok('second create of the same email is refused', await J.createJob(store, J.newJob({ id: 'j_abc123', mode: 'shadow', source: src, now: T0 })), false);
  ok('job is listed active', await J.activeJobIds(store), ['j_abc123']);

  // --- one claim per step -------------------------------------------------------
  const c1 = await J.claimNext(store, 'j_abc123', T0);
  ok('load is claimed first', c1 && c1.name, 'load');
  const c2 = await J.claimNext(store, 'j_abc123', T0 + 1000);
  ok('a second invocation cannot take a step that is held', c2, null);

  // completing with a stale token is refused (lease lost)
  ok('a stale token cannot complete the step', await J.completeStep(store, 'j_abc123', 'load', 'not-the-token', null, T0 + 2000), null);

  // load finishes and adds the next steps
  await J.completeStep(store, 'j_abc123', 'load', c1.token, (j) => J.addSteps(j, ['map', 'plan']), T0 + 3000);
  let cur = (await J.readJob(store, 'j_abc123')).job;
  ok('steps are appended in order', cur.order, ['load', 'map', 'plan']);
  ok('load is done', cur.steps.load.status, 'done');

  // --- retries, then a required step fails the job once ------------------------
  let t = T0 + 10000;
  for (let i = 1; i <= J.MAX_ATTEMPTS; i++) {
    const c = await J.claimNext(store, 'j_abc123', t);
    ok(`map attempt ${i} is claimed`, c && c.name, 'map');
    await J.failStep(store, 'j_abc123', 'map', c.token, new Error('model overloaded'), t + 10);
    t += 1000;
  }
  const dead = await J.claimNext(store, 'j_abc123', t);
  ok('a required step out of attempts fails the job', dead && dead.failed && dead.failed.name, 'map');
  cur = (await J.readJob(store, 'j_abc123')).job;
  ok('job status is failed', cur.status, 'failed');
  ok('failed job leaves the active list', await J.activeJobIds(store), []);
  ok('nothing more is claimed on a failed job', await J.claimNext(store, 'j_abc123', t + 1), null);

  // --- optional steps give up and the job carries on ----------------------------
  const s2 = memoryStore();
  const j2 = J.newJob({ id: 'j_two', mode: 'live', source: src, now: T0 });
  J.addSteps(j2, ['identify:0', 'review:0', 'finish']);
  j2.steps.load.status = 'done';
  await J.createJob(s2, j2);
  t = T0;
  let c = await J.claimNext(s2, 'j_two', t);
  ok('identify:0 runs', c.name, 'identify:0');
  await J.completeStep(s2, 'j_two', c.name, c.token, null, t);
  for (let i = 0; i < J.MAX_ATTEMPTS; i++) {
    c = await J.claimNext(s2, 'j_two', ++t);
    await J.failStep(s2, 'j_two', c.name, c.token, new Error('review timed out'), t);
  }
  c = await J.claimNext(s2, 'j_two', ++t);
  ok('after review gives up, finish still runs', c && c.name, 'finish');
  cur = (await J.readJob(s2, 'j_two')).job;
  ok('the give-up is recorded', cur.gaveUp.map((g) => g.name), ['review:0']);

  // --- a dead invocation's lease expires ----------------------------------------
  const s3 = memoryStore();
  await J.createJob(s3, J.newJob({ id: 'j_three', mode: 'shadow', source: src, now: T0 }));
  const held = await J.claimNext(s3, 'j_three', T0);
  ok('held step is not kicked while the lease is live', J.needsKick((await J.readJob(s3, 'j_three')).job, T0 + 60000), false);
  ok('after the lease, the sweeper kicks it', J.needsKick((await J.readJob(s3, 'j_three')).job, T0 + J.LEASE_MS + 1), true);
  const again = await J.claimNext(s3, 'j_three', T0 + J.LEASE_MS + 1);
  ok('the step is re-claimed after the lease', again && again.name, 'load');
  ok('the old holder can no longer complete it', await J.completeStep(s3, 'j_three', 'load', held.token, null, T0 + J.LEASE_MS + 2), null);

  // --- a lost kick is picked up ---------------------------------------------------
  const s4 = memoryStore();
  await J.createJob(s4, J.newJob({ id: 'j_four', mode: 'shadow', source: src, now: T0 }));
  const j4 = (await J.readJob(s4, 'j_four')).job;
  ok('a fresh pending job is not kicked by the sweeper yet', J.needsKick(j4, T0 + 1000), false);
  ok('a pending job with no progress is kicked', J.needsKick(j4, T0 + J.STALL_MS + 1), true);

  // --- binary documents round-trip -----------------------------------------------
  const pdf = Buffer.from('%PDF-1.7 test bytes');
  await J.putDoc(s4, 'j_four', 0, pdf);
  ok('document bytes round-trip', (await J.getDoc(s4, 'j_four', 0)).toString(), pdf.toString());

  // --- page accounting --------------------------------------------------------------
  const docs = [
    { n: 0, name: 'Seller Disclosures.pdf', pages: 46 },
    { n: 1, name: 'AVID LA.pdf', pages: 3 },
    { n: 2, name: 'Broken.pdf', pages: 2 },
  ];
  const maps = {
    0: { unclaimed: [14, 15, 16, 40] },
    1: { unclaimed: [] },
  };
  const acct = J.pageAccounting(docs, maps, { 'Seller Disclosures.pdf': [12, 13, 14, 15, 16, 33, 34, 35], 'AVID LA.pdf': [1, 2, 3] });
  ok('totals', [acct.total, acct.claimed, acct.reviewed], [51, 45, 11]);
  ok('unmatched pages are named', acct.unclaimed, [{ name: 'Seller Disclosures.pdf', pages: [14, 15, 16, 40] }]);
  ok('an unmapped file is named', acct.unmapped, ['Broken.pdf']);
  ok('page ranges read naturally', J.compactPages([16, 14, 15, 40, 41, 3]), '3, 14-16, 40-41');
  const text = J.accountingText(acct, [{ name: 'Booklet.pdf', reason: 'not reviewed by rule (booklet)' }], [{ name: 'review:1', error: 'timed out' }]);
  ok('the paragraph names every gap', text.split('\n'), [
    'Pages: 51 received, 45 matched to a form, 11 seller-answer pages audited.',
    'NOT MATCHED TO ANY FORM: Seller Disclosures.pdf, pages 14-16, 40. Look at these by hand.',
    'NOT PAGE-CHECKED: Broken.pdf (page reading failed).',
    'FILE NOT REVIEWED: Booklet.pdf (not reviewed by rule (booklet)).',
    `INCOMPLETE: seller answers in this batch were not audited after ${J.MAX_ATTEMPTS} tries (timed out).`,
  ]);

  // --- races, against a store that IGNORES conditional writes (the live one) -------
  for (let round = 1; round <= 5; round++) {
    const live = memoryStore({ ignoreConditions: true });
    const a = J.newJob({ id: 'j_race', mode: 'shadow', source: src, now: T0 });
    const b = J.newJob({ id: 'j_race', mode: 'shadow', source: src, now: T0 });
    const made = await Promise.all([J.createJob(live, a, 20), J.createJob(live, b, 20)]);
    ok(`round ${round}: two polls racing on one email make ONE job`, made.filter(Boolean).length, 1);
    const claims = await Promise.all([J.claimNext(live, 'j_race', T0, 20), J.claimNext(live, 'j_race', T0, 20)]);
    ok(`round ${round}: two runs racing on one step, ONE goes ahead`, claims.filter((c) => c && c.token).length, 1);
  }
  const live = memoryStore({ ignoreConditions: true });
  const first = await J.setOnce(live, 'meta/since', { at: 100 }, 5);
  const second = await J.setOnce(live, 'meta/since', { at: 999 }, 5);
  ok('the cut-off is written once and never moves', [first.at, second.at], [100, 100]);

  // --- the front door: what counts as a delivery ----------------------------------
  const S = require('../netlify/functions/lib/intake-steps.js');
  ok('a PDF attachment counts', S.isPdfOrZip({ filename: 'TDS.pdf', mimeType: 'application/pdf' }), true);
  ok('a zip counts', S.isPdfOrZip({ filename: 'Disclosures.zip', mimeType: 'application/octet-stream' }), true);
  ok('a signature logo does not', S.isPdfOrZip({ filename: 'image001.png', mimeType: 'image/png' }), false);
  const html = '<a href="https://www.dropbox.com/scl/fo/abc123/xyz?rlkey=k&amp;dl=0">Disclosures</a> and '
    + '<a href="https://drive.google.com/file/d/FILEID_9/view?usp=sharing">TDS</a>';
  ok('share links are read from the HTML body, Drive files made direct', S.shareLinks(html, '').map((l) => l.url), [
    'https://www.dropbox.com/scl/fo/abc123/xyz?rlkey=k&dl=0',
    'https://drive.google.com/uc?export=download&id=FILEID_9',
  ]);
  ok('the same link in the plain body is not added twice',
    S.shareLinks(html, 'see https://drive.google.com/file/d/FILEID_9/view').length, 2);
  ok('a Drive FOLDER is not a fetchable link', S.shareLinks('<a href="https://drive.google.com/drive/folders/F1">x</a>', '').length, 0);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall intake-job checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
