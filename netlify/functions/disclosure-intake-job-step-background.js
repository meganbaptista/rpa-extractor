// netlify/functions/disclosure-intake-job-step-background.js
//
// Runs ONE step of an intake job, saves it, and starts the next. See
// lib/intake-job.js for why the intake is a job and lib/intake-steps.js for what
// each step does.
//
// Invoked by the poller (a new job, or the watchdog re-starting a stuck one) and
// by itself (the next step). POST { jobId }. A background function, so every
// step gets its own 15 minutes.
//
// A failed step is NOT re-kicked here: the watchdog picks it up on its next pass
// (2 minutes), which is the back-off an overloaded API needs. A required step
// that runs out of attempts sends ONE alert naming the deal, the step and the
// error.

const J = require('./lib/intake-job');
const steps = require('./lib/intake-steps');
const rt = require('./lib/intake-runtime');
const { parseRequestBody } = require('./lib/parse-body');
const { canonicalAddress } = require('./lib/address');
const strips = require('./lib/page-strips');
const gmail = require('./lib/gmail');
const signature = require('./lib/signature');
const intake = require('./disclosure-intake-check-background');

exports.handler = async function (event) {
  const parsed = parseRequestBody(event);
  const jobId = parsed.ok && parsed.body && parsed.body.jobId;
  if (!jobId) { console.error('[intake-job] no jobId in the request'); return { statusCode: 400 }; }

  const store = rt.jobStore();
  const claim = await J.claimNext(store, jobId);
  if (!claim) { console.log(`[intake-job] ${jobId}: nothing to run`); return { statusCode: 200 }; }

  const { job } = claim;
  const who = `${job.address || job.source.subject || jobId}`;
  if (claim.failed) {
    await rt.intakeAlert(`intake-failed:${jobId}`,
      `Disclosure intake FAILED for "${who}" at step "${claim.failed.name}" after ${J.MAX_ATTEMPTS} tries: `
      + `${claim.failed.error}. The email from ${job.source.from} still needs a manual check.`);
    return { statusCode: 200 };
  }

  const ctx = {
    store,
    job,
    step: claim.name,
    attempt: job.steps[claim.name].attempts,
    core: intake.core,
    strips,
    gmail,
    signature,
    alert: rt.intakeAlert,
    stateStore: rt.blobs(intake.core.STATE_STORE),
    callbackUrl: intake.core.CALLBACK_URL_ENV,
    canonicalAddress,
    log: (m) => console.log(`[intake-job] ${jobId} ${claim.name}: ${m}`),
  };

  const t0 = Date.now();
  try {
    const apply = await steps.run(claim.name, ctx);
    await J.completeStep(store, jobId, claim.name, claim.token, apply);
    console.log(`[intake-job] ${jobId} ${claim.name}: done in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (err) {
    console.error(`[intake-job] ${jobId} ${claim.name}: attempt ${ctx.attempt} failed after `
      + `${Math.round((Date.now() - t0) / 1000)}s: ${err.message}`);
    await J.failStep(store, jobId, claim.name, claim.token, err);
    return { statusCode: 200 };
  }

  try { await rt.kick(jobId); } catch (err) {
    console.warn(`[intake-job] ${jobId}: could not start the next step (${err.message}); the watchdog will`);
  }
  return { statusCode: 200 };
};
