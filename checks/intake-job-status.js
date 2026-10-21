// checks/intake-job-status.js
//
// READ-ONLY look at the live intake jobs: the `since` cut-off and every job,
// newest first, with its step progress.
//   netlify dev:exec node checks/intake-job-status.js [filter]
// `filter` matches the subject, sender or address (case-insensitive).

const { getStore } = require('@netlify/blobs');
const J = require('../netlify/functions/lib/intake-job.js');

// --set-since <ISO date> moves the poller's cut-off (the only write this makes).
const setIdx = process.argv.indexOf('--set-since');
const setSince = setIdx > 0 ? Date.parse(process.argv[setIdx + 1]) : 0;
const filter = setIdx > 0 ? '' : String(process.argv[2] || '').toLowerCase();

(async () => {
  const store = getStore({ name: J.STORE_NAME, siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
  if (setSince) {
    await store.setJSON('meta/since-v2', { at: setSince, setBy: 'intake-job-status' });
    console.log(`cut-off set to ${new Date(setSince).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`);
  }
  const since = await store.get('meta/since-v2', { type: 'json' });
  const cond = await store.get('meta/conditions', { type: 'json' });
  console.log(cond
    ? `storage check (${new Date(cond.at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}): `
      + `${cond.mode} connection, conditional writes ${cond.conditionsHeld === true ? 'HELD' : cond.conditionsHeld === false ? 'IGNORED' : 'untested'}`
    : 'storage check: not run yet');
  console.log(`mode on the site: ${process.env.INTAKE_JOB_MODE || '(unset = off)'}`);
  if (process.env.INTAKE_JOB_SINCE) console.log('NOTE: INTAKE_JOB_SINCE is set in Netlify but no longer used; delete it (4KB env limit)');
  console.log(`cut-off: emails received before ${since ? new Date(since.at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) : '(no cut-off yet: the poller has not run in shadow/live)'} are ignored`);

  const { blobs } = await store.list({ prefix: 'job/' });
  const jobs = [];
  for (const b of blobs) {
    const j = await store.get(b.key, { type: 'json' });
    if (j) jobs.push(j);
  }
  jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const shown = jobs.filter((j) => !filter
    || [j.source && j.source.subject, j.source && j.source.from, j.address].join(' ').toLowerCase().includes(filter));
  console.log(`\n${shown.length} job(s)${filter ? ` matching "${filter}"` : ''}:`);
  for (const j of shown) {
    const done = j.order.filter((n) => j.steps[n].status === 'done').length;
    const when = new Date(j.createdAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    console.log(`\n${when}  ${j.mode}  ${j.status}  ${j.id}`);
    console.log(`  "${j.source.subject}" from ${j.source.from}`);
    console.log(`  ${j.address || '(address not read yet)'}: ${done}/${j.order.length} steps done${j.outcome ? `, ${j.outcome}` : ''}`);
    const bad = j.order.filter((n) => j.steps[n].error).map((n) => `${n} (try ${j.steps[n].attempts}): ${j.steps[n].error}`);
    if (bad.length) console.log(`  errors: ${bad.join(' | ')}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
