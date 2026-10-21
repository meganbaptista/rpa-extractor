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
//   shadow  runs every job and SAVES the result; no draft, no Process Street
//           post, no label change, no write to the per-deal received set. For
//           the trial week next to the Zaps. The Zap's "Remove Label" step must
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

async function since(store) {
  if (process.env.INTAKE_JOB_SINCE) return Date.parse(process.env.INTAKE_JOB_SINCE) || 0;
  await store.setJSON('meta/since', { at: Date.now() }, { onlyIfNew: true });
  const m = await store.get('meta/since', { type: 'json', consistency: 'strong' });
  return (m && m.at) || Date.now();
}

/** The job id this message should run under now, or '' to leave it alone. */
async function jobIdToRun(store, messageId, mode) {
  for (let run = 0; run <= MAX_RERUNS; run++) {
    const id = J.jobIdFor(messageId, run);
    const cur = await J.readJob(store, id);
    if (!cur) return id;
    if (cur.job.status === 'running') return '';
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
  for (const { id } of listed) {
    // Cheap test first: has this message already got a job?
    const jobId = await jobIdToRun(store, id, mode);
    if (!jobId) continue;
    const msg = await gmail.getMessage(id);
    if (Number(msg.internalDate || 0) < cutoff) continue;
    const from = (msg.headers && msg.headers.from) || '';
    if (me && from.toLowerCase().includes(me)) continue;
    const hasFiles = msg.attachments.some(steps.isPdfOrZip) || steps.shareLinks(msg.bodyHtml, msg.bodyText).length > 0;
    if (!hasFiles) continue;

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
    if (!(await J.createJob(store, job))) continue;
    console.log(`[intake-poller] new ${mode} job ${jobId}: "${job.source.subject}" from ${from}`);
    await rt.kick(jobId).catch((err) => console.warn(`[intake-poller] kick ${jobId} failed (the next pass will retry): ${err.message}`));
    started++;
  }
  return started;
}

exports.handler = async function () {
  const mode = rt.MODE();
  if (mode !== 'shadow' && mode !== 'live') return { statusCode: 200 };
  const store = rt.jobStore();
  try {
    const kicked = await sweep(store);
    const started = await poll(store, mode);
    if (kicked || started) console.log(`[intake-poller] ${mode}: ${started} new job(s), ${kicked} restarted`);
  } catch (err) {
    console.error(`[intake-poller] ${err.message}`);
    await rt.intakeAlert('intake-poller', `The disclosure intake poller failed: ${err.message}`);
  }
  return { statusCode: 200 };
};
