// netlify/functions/disclosure-intake-job-poller.js
//
// Every 2 minutes (netlify.toml): the front door AND the watchdog of the
// buyer-side disclosure intake job. Replaces the Zap "buyer side disclosures -
// label incoming gmail as Disclosures - AI Review #1" once it is LIVE.
//
// FRONT DOOR. Lists the messages carrying INTAKE_JOB_LABEL ("Disclosures - AI
// Review"). Each one from the other side that carries a PDF, a zip or a share
// link becomes ONE job, keyed by its Gmail message id, so a message is never
// processed twice. Messages from us, and messages older than the first run
// (the `since` marker), are ignored, so switching on never replays a backlog.
//
// WATCHDOG. Every running job is checked: a failed step with tries left, a step
// whose invocation died (its lease ran out), or a step whose start was lost is
// started again. See lib/intake-job.js needsKick.
//
// INTAKE_JOB_MODE:
//   off     (default) does nothing, so deploying this changes nothing.
//   shadow  runs every job and SAVES the result, plus ONE standalone "[TRIAL]"
//           draft (no recipient, not in the thread, labelled per
//           INTAKE_TRIAL_LABELS) so Megan can compare it with the Zap's draft.
//           No reply in the thread, no Process Street post, no label change, no
//           write to the per-deal received set. For the trial week next to the
//           Zaps. The Zap's "Remove Label" step must
//           be OFF that week, or the label is gone before this sees it.
//   live    drafts the reply in the thread, posts the Process Street results to
//           Zap B, and removes the label. A message re-labelled after a live
//           run is a deliberate re-run and gets a new job.

const J = require('./lib/intake-job');
const rt = require('./lib/intake-runtime');
const steps = require('./lib/intake-steps');
const gmail = require('./lib/gmail');

const MAX_RERUNS = 5;

async function sweep(store) {
  const now = Date.now();
  let kicked = 0;
  for (const id of await J.activeJobIds(store)) {
    const cur = await J.readJob(store, id).catch(() => null);
    if (!cur) continue;
    if (J.needsKick(cur.job, now)) {
      await rt.kick(id).then(() => { kicked++; }, (err) => console.warn(`[intake-poller] kick ${id} failed: ${err.message}`));
    }
  }
  return kicked;
}

// The cut-off lives in Blobs, not an env var: the site's variables are AT
// Netlify's 4KB Lambda limit (GOOGLE_SA_JSON is most of it), and adding
// INTAKE_JOB_SINCE on 2026-10-21 failed every function deploy. To move it,
// overwrite meta/since-v2 (checks/intake-job-status.js --set-since <ISO>).
// `-v2` because the first build rewrote meta/since on every poll.
async function since(store) {
  const m = await J.setOnce(store, 'meta/since-v2', { at: Date.now() }, rt.verifyMs());
  return (m && m.at) || Date.now();
}

/** The job id this message should run under now, or '' to leave it alone. */
async function jobIdToRun(store, messageId, mode) {
  for (let run = 0; run <= MAX_RERUNS; run++) {
    const id = J.jobIdFor(messageId, run);
    const cur = await J.readJob(store, id);
    if (!cur) return id;
    if (cur.job.status === 'running') return '';
    // A FAILED job is never re-run on its own. Its label used to stay on, so
    // every pass read "finished + labelled = re-labelled on purpose" and ran
    // the whole job again: 20701 Schoolcraft (2026-10-23) ran 6 times per email,
    // all failing the same way (no compliance list row). A live failure now
    // takes the label off (disclosure-intake-job-step-background); re-adding
    // it is the deliberate re-run. Here: still labelled after a failure means
    // the removal did not happen, so leave it alone.
    if (cur.job.status === 'failed') return '';
    // Shadow never removes the label, so a finished job means "already seen".
    // Live removes it, so a finished job whose message is labelled again was
    // re-labelled on purpose: run it again.
    if (mode !== 'live') return '';
  }
  return '';
}

async function poll(store, mode) {
  const labelName = rt.LABEL();
  const labelId = await gmail.labelId(labelName);
  if (!labelId) { console.warn(`[intake-poller] no Gmail label "${labelName}"`); return 0; }
  const cutoff = await since(store);
  const me = String(process.env.GMAIL_IMPERSONATE_SUBJECT || process.env.GOOGLE_IMPERSONATE_SUBJECT || '').trim().toLowerCase();

  const listed = await gmail.listMessages({ labelIds: [labelId], maxPages: 1, pageSize: 50 });
  let started = 0;
  // What this pass saw and why each message was or was not started, kept at
  // meta/last-poll for checks/intake-job-status.js. A skipped email is
  // explained, never silent.
  const seen = [];
  const note = (id, subject, outcome) => { if (seen.length < 15) seen.push({ id, subject: String(subject || '').slice(0, 70), outcome }); };
  for (const { id } of listed) {
    // Cheap test first: has this message already got a job?
    const jobId = await jobIdToRun(store, id, mode);
    if (!jobId) { note(id, '', 'already has a job'); continue; }
    const msg = await gmail.getMessage(id);
    const subj = (msg.headers && msg.headers.subject) || '';
    if (Number(msg.internalDate || 0) < cutoff) { note(id, subj, 'received before the cut-off'); continue; }
    const from = (msg.headers && msg.headers.from) || '';
    if (me && from.toLowerCase().includes(me)) { note(id, subj, 'sent by us'); continue; }
    const hasFiles = msg.attachments.some(steps.isPdfOrZip) || steps.shareLinks(msg.bodyHtml, msg.bodyText).length > 0;
    if (!hasFiles) { note(id, subj, `no PDF, zip or share link (${msg.attachments.length} attachment(s))`); continue; }

    const job = J.newJob({
      id: jobId,
      mode,
      now: Date.now(),
      source: {
        messageId: id,
        threadId: msg.threadId,
        labelId,
        from,
        fromName: gmail.senderNameOf ? gmail.senderNameOf(from) : '',
        fromIsUs: false,
        subject: (msg.headers && msg.headers.subject) || '',
        rfcMessageId: (msg.headers && msg.headers['message-id']) || '',
        receivedAt: Number(msg.internalDate || 0),
      },
    });
    if (!(await J.createJob(store, job, rt.verifyMs()))) { note(id, subj, 'job creation lost a race or did not save'); continue; }
    note(id, subj, `started ${jobId}`);
    console.log(`[intake-poller] new ${mode} job ${jobId}: "${job.source.subject}" from ${from}`);
    await rt.kick(jobId).catch((err) => console.warn(`[intake-poller] kick ${jobId} failed (the next pass will retry): ${err.message}`));
    started++;
  }
  await store.setJSON('meta/last-poll', { at: Date.now(), label: labelName, listed: listed.length, cutoff, seen }).catch(() => {});
  return started;
}

exports.handler = async function (event) {
  const mode = rt.MODE();
  if (mode !== 'shadow' && mode !== 'live') return { statusCode: 200 };
  rt.connect(event);
  const store = rt.jobStore();
  try {
    // Evidence for going live: which Blobs connection this got, and whether a
    // conditional write held on it. Read by checks/intake-job-status.js.
    const cond = await rt.checkConditions(store);
    if (mode === 'live' && cond.conditionsHeld === false && cond.mode === 'token') {
      await rt.intakeAlert('intake-conditions', 'Live intake is running on a Blobs connection that ignores '
        + 'conditional writes; duplicate drafts are possible in rare races. See lib/intake-runtime.js.');
    }
    const kicked = await sweep(store);
    const started = await poll(store, mode);
    if (kicked || started) console.log(`[intake-poller] ${mode}: ${started} new job(s), ${kicked} restarted`);
  } catch (err) {
    console.error(`[intake-poller] ${err.message}`);
    await rt.intakeAlert('intake-poller', `The disclosure intake poller failed: ${err.message}`);
  }
  return { statusCode: 200 };
};

exports._internal = { jobIdToRun };
