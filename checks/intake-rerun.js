// checks/intake-rerun.js
//
// When the watcher starts a job for a labelled email. 20701 Schoolcraft
// (2026-10-23): a FAILED job kept its label, so every pass re-ran the whole job
// (6 runs per email, all failing on the same missing compliance-list row).
//   node checks/intake-rerun.js

const { jobIdToRun } = require('../netlify/functions/disclosure-intake-job-poller.js')._internal;
const J = require('../netlify/functions/lib/intake-job.js');
let failed = 0;
function ok(label, got, want) { if (got !== want) { failed++; console.error(`FAIL  ${label}: got ${got}, want ${want}`); } else console.log(`pass  ${label}`); }

const storeWith = (jobs) => ({ get: async (k) => (jobs[k] ? JSON.parse(JSON.stringify(jobs[k])) : null), getWithMetadata: async (k) => (jobs[k] ? { data: JSON.parse(JSON.stringify(jobs[k])), etag: '1' } : null) });
const job = (status) => ({ id: 'x', status, steps: {}, order: [] });

(async () => {
  const id0 = J.jobIdFor('m1'); const id1 = J.jobIdFor('m1', 1);
  ok('new email: first job id', await jobIdToRun(storeWith({}), 'm1', 'live'), id0);
  ok('running job: wait', await jobIdToRun(storeWith({ [`job/${id0}`]: job('running') }), 'm1', 'live'), '');
  ok('FAILED job still labelled: never re-run on its own', await jobIdToRun(storeWith({ [`job/${id0}`]: job('failed') }), 'm1', 'live'), '');
  ok('done job re-labelled (live removed the label): re-run', await jobIdToRun(storeWith({ [`job/${id0}`]: job('done') }), 'm1', 'live'), id1);
  ok('shadow: a finished job is "already seen"', await jobIdToRun(storeWith({ [`job/${id0}`]: job('done') }), 'm1', 'shadow'), '');
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall intake-rerun checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
