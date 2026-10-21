// checks/intake-job-replay.js
//
// Runs a real disclosure delivery through EVERY step of the intake job on this
// machine, with real model calls, before anything is deployed:
//
//   netlify dev:exec node checks/intake-job-replay.js <label> <file-or-folder>...
//
// (`netlify dev:exec` supplies the site's environment - the Anthropic key and
// the audit-list sheet - without printing it.)
//
// Safe by construction: the job runs in SHADOW mode against an in-memory store,
// so nothing is drafted, nothing is posted to Process Street, no label changes
// and the per-deal received set in production is never written. A failed step
// is retried exactly as the watchdog would retry it.
//
// Writes the full result to /tmp/intake-replay-<label>.json and prints the
// parts Megan reads.

const fs = require('fs');
const path = require('path');
const J = require('../netlify/functions/lib/intake-job.js');
const steps = require('../netlify/functions/lib/intake-steps.js');
const strips = require('../netlify/functions/lib/page-strips.js');
const { canonicalAddress } = require('../netlify/functions/lib/address.js');
const intake = require('../netlify/functions/disclosure-intake-check-background.js');
const { memoryStore } = require('./lib/memory-store.js');

// Netlify never supplies a SECRET variable to local runs, and `dev:exec` replaces
// an ANTHROPIC_API_KEY set in the shell with its own (invalid) local value. So the
// key is read from a private file instead: ANTHROPIC_KEY_FILE=~/.rpa-anthropic-key
// (chmod 600). It is never printed.
if (process.env.ANTHROPIC_KEY_FILE) {
  process.env.ANTHROPIC_API_KEY = fs.readFileSync(process.env.ANTHROPIC_KEY_FILE, 'utf8').trim();
}

const [label, ...inputs] = process.argv.slice(2);
if (!label || !inputs.length) {
  console.error('usage: node checks/intake-job-replay.js <label> <file-or-folder>...');
  process.exit(2);
}

const files = [];
for (const p of inputs) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(p).sort()) if (/\.(pdf|zip)$/i.test(f)) files.push(path.join(p, f));
  } else files.push(p);
}

(async () => {
  const store = memoryStore();
  const id = `replay_${label.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const job0 = J.newJob({ id, mode: 'shadow', now: Date.now(), source: { localFiles: files, subject: label, from: 'replay', threadId: '' } });
  await J.createJob(store, job0);
  console.log(`replaying ${files.length} file(s) as job ${id}`);

  const timings = [];
  const t0 = Date.now();
  for (let guard = 0; guard < 200; guard++) {
    const claim = await J.claimNext(store, id);
    if (!claim) break;
    if (claim.failed) { console.error(`JOB FAILED at ${claim.failed.name}: ${claim.failed.error}`); break; }
    const ctx = {
      store,
      job: claim.job,
      step: claim.name,
      attempt: claim.job.steps[claim.name].attempts,
      core: intake.core,
      strips,
      gmail: null,
      signature: null,
      alert: async (key, msg) => console.log(`\n[ALERT ${key}]\n${msg}\n`),
      stateStore: memoryStore(),
      callbackUrl: '',
      canonicalAddress,
      log: (m) => console.log(`  ${claim.name}: ${m}`),
    };
    const s = Date.now();
    try {
      const apply = await steps.run(claim.name, ctx);
      await J.completeStep(store, id, claim.name, claim.token, apply);
      timings.push(`${claim.name} ${Math.round((Date.now() - s) / 1000)}s`);
    } catch (err) {
      console.error(`  ${claim.name}: attempt ${ctx.attempt} FAILED: ${err.message}`);
      await J.failStep(store, id, claim.name, claim.token, err);
      timings.push(`${claim.name} FAILED ${Math.round((Date.now() - s) / 1000)}s`);
    }
  }

  const job = (await J.readJob(store, id)).job;
  const payload = await J.getOut(store, id, 'payload');
  const map = await J.getOut(store, id, 'map');
  fs.writeFileSync(`/tmp/intake-replay-${label}.json`, JSON.stringify({ job, payload, map }, null, 2));

  console.log(`\n=== ${label}: ${job.status} (${job.outcome}) in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`steps: ${timings.join(' | ')}`);
  if (!payload) process.exit(job.status === 'done' ? 0 : 1);
  const show = (h, v) => { if (String(v || '').trim()) console.log(`\n--- ${h}\n${v}`); };
  show('PAGE ACCOUNTING', payload.page_accounting_text);
  show('STILL NEEDED', payload.still_needed_lines);
  show('ANSWER FLAGS', payload.response_flags_lines);
  show('VERIFY', payload.verify_lines);
  show('CHASE EMAIL', payload.chase_email_body);
  console.log(`\nfull result: /tmp/intake-replay-${label}.json`);
})().catch((e) => { console.error(e); process.exit(1); });
