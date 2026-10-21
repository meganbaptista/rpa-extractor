// netlify/functions/lib/intake-job.js
//
// ============================================================================
// THE BUYER-SIDE DISCLOSURE INTAKE AS A JOB, one saved step at a time.
// ============================================================================
// The intake used to be one 15-minute invocation: load, identify, review (two
// passes), reconcile, draft. Megan, 2026-10-21: it "only runs 50% of the time",
// and the failures are "an assortment every single time" - a big package ran
// out of time, an API error quietly dropped a batch, pages were never looked at,
// and a crashed run was retried by Netlify into a second draft. She re-ran it by
// hand until it came out right.
//
// So the same audit (disclosure-intake-check-background.js `core`, unchanged
// logic) now runs as a JOB:
//
//   load -> map -> plan -> identify:1, review:1 ... identify:n, review:n -> finish
//
// Each step saves its result before the next starts, so a failure re-runs ONE
// step, never the package. A LEASE (a conditional write on the job record) means
// two invocations can never work the same step, so a Netlify retry cannot make a
// second draft. A step gets MAX_ATTEMPTS tries; then:
//   - identify/review are OPTIONAL: the job carries on, the batch is reported as
//     not audited (the same outcome the old code reached silently, now said out
//     loud in the result and in one alert);
//   - load/map/plan/finish are REQUIRED: the job stops and ONE alert names the
//     deal, the step and the error. Megan never re-runs anything by hand.
//
// PAGE ACCOUNTING (the `map` step) is arithmetic over lib/page-strips.js: every
// page of every file is either claimed by a form, or listed as unclaimed. Files
// that were not loaded at all are listed with their reason. Nothing is silent.
//
// Everything here is plain logic over a small store interface (getWithMetadata /
// setJSON with onlyIfMatch|onlyIfNew / get / set / delete / list), so
// checks/intake-job.js runs it against an in-memory store.
// ============================================================================

const STORE_NAME = 'disclosure-intake-jobs';
const MAX_ATTEMPTS = 3;
// A background function is cut off at 15 minutes; a lease a little longer than
// that means a step whose invocation died is free to be re-claimed, and one that
// is still running never is.
const LEASE_MS = 16 * 60 * 1000;
// A step that is pending (its kick was lost) is re-kicked after this long.
const STALL_MS = 90 * 1000;

const OPTIONAL = (name) => /^(identify|review):\d+$/.test(name);

const keys = {
  job: (id) => `job/${id}`,
  active: (id) => `active/${id}`,
  doc: (id, n) => `doc/${id}/${n}`,
  out: (id, name) => `out/${id}/${name.replace(/:/g, '-')}`,
};

function jobIdFor(messageId, run = 0) {
  return `j_${String(messageId).replace(/[^A-Za-z0-9_-]/g, '')}${run ? `_r${run}` : ''}`;
}

function newJob({ id, mode, source, now }) {
  return {
    id,
    mode,                 // 'shadow' | 'live'
    status: 'running',    // 'running' | 'done' | 'failed'
    createdAt: now,
    updatedAt: now,
    source,               // { messageId, threadId, from, fromName, subject, rfcMessageId, labelId }
    address: '',
    docs: [],             // [{ n, name, pages, bytes }]
    skipped: [],          // [{ name, reason }]
    archives: [],         // [{ name, reason }] (info)
    order: ['load'],
    steps: { load: blankStep() },
    gaveUp: [],           // optional steps that ran out of attempts
    outcome: '',
  };
}

function blankStep() {
  return { status: 'pending', attempts: 0, leaseUntil: 0, leaseToken: '', error: '', startedAt: 0, finishedAt: 0 };
}

function addSteps(job, names) {
  for (const n of names) {
    if (job.steps[n]) continue;
    job.order.push(n);
    job.steps[n] = blankStep();
  }
}

/**
 * What should run next. Steps run in order; the first step that is not done is
 * the only candidate. Returns:
 *   { name }                    runnable now
 *   { name, busy: true }        another invocation holds a live lease
 *   { name, exhausted: true }   out of attempts
 *   null                        every step is done
 */
function nextStep(job, now) {
  for (const name of job.order) {
    const s = job.steps[name];
    if (s.status === 'done' || s.status === 'gave_up') continue;
    if (s.status === 'running' && s.leaseUntil > now) return { name, busy: true };
    if (s.attempts >= MAX_ATTEMPTS) return { name, exhausted: true };
    return { name };
  }
  return null;
}

/** Does the sweeper need to kick this job? */
function needsKick(job, now) {
  if (job.status !== 'running') return false;
  const nx = nextStep(job, now);
  if (!nx || nx.busy) return false;
  if (nx.exhausted) return true;                       // let the runner close it out
  const s = job.steps[nx.name];
  if (s.status === 'failed' || s.status === 'running') return true; // retry / dead lease
  return now - (job.updatedAt || 0) > STALL_MS;        // pending, kick was lost
}

function randomToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Store operations. Every write to a job record is conditional on the version
// that was read, so concurrent invocations cannot clobber each other.
// ---------------------------------------------------------------------------

async function readJob(store, id) {
  const r = await store.getWithMetadata(keys.job(id), { type: 'json', consistency: 'strong' });
  if (!r || !r.data) return null;
  return { job: r.data, etag: r.etag };
}

async function createJob(store, job) {
  const w = await store.setJSON(keys.job(job.id), job, { onlyIfNew: true });
  if (!w || !w.modified) return false;
  await store.setJSON(keys.active(job.id), { at: job.createdAt });
  return true;
}

/** Read-modify-write with retry on a lost race. mutate(job) returns false to abort. */
async function updateJob(store, id, mutate, now = Date.now()) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await readJob(store, id);
    if (!cur) return null;
    const job = cur.job;
    const res = mutate(job);
    if (res === false) return null;
    job.updatedAt = now;
    const w = await store.setJSON(keys.job(id), job, { onlyIfMatch: cur.etag });
    if (w && w.modified) {
      if (job.status !== 'running') { try { await store.delete(keys.active(id)); } catch (e) { /* best effort */ } }
      return job;
    }
  }
  throw new Error(`job ${id}: could not save after 5 tries (contention)`);
}

/**
 * Claim the next step. Optional steps that ran out of attempts are marked
 * gave_up and skipped; a required one ends the job as failed. Returns
 *   { job, name, token }                a step is ours to run
 *   { job, failed: { name, error } }    the job just failed (alert once)
 *   null                                nothing to do
 */
async function claimNext(store, id, now = Date.now()) {
  let result = null;
  const job = await updateJob(store, id, (j) => {
    result = null;
    if (j.status !== 'running') return false;
    for (;;) {
      const nx = nextStep(j, now);
      if (!nx) return false;                         // all done; finish marks the job done
      if (nx.busy) return false;
      const s = j.steps[nx.name];
      if (nx.exhausted) {
        if (OPTIONAL(nx.name)) {
          s.status = 'gave_up';
          j.gaveUp.push({ name: nx.name, error: s.error });
          continue;
        }
        j.status = 'failed';
        j.outcome = `failed at ${nx.name}: ${s.error}`;
        result = { failed: { name: nx.name, error: s.error } };
        return true;
      }
      const token = randomToken();
      s.status = 'running';
      s.attempts += 1;
      s.leaseUntil = now + LEASE_MS;
      s.leaseToken = token;
      s.startedAt = now;
      result = { name: nx.name, token };
      return true;
    }
  }, now);
  if (!job || !result) return null;
  return { job, ...result };
}

/** Finish a step we hold. apply(job) records what the step learned. */
async function completeStep(store, id, name, token, apply = null, now = Date.now()) {
  return updateJob(store, id, (j) => {
    const s = j.steps[name];
    if (!s || s.leaseToken !== token) return false;  // lease lost; another run owns it
    if (apply) apply(j);
    s.status = 'done';
    s.finishedAt = now;
    s.leaseUntil = 0;
    s.error = '';
    return true;
  }, now);
}

async function failStep(store, id, name, token, error, now = Date.now()) {
  return updateJob(store, id, (j) => {
    const s = j.steps[name];
    if (!s || s.leaseToken !== token) return false;
    s.status = 'failed';
    s.leaseUntil = 0;
    s.error = String((error && error.message) || error || 'unknown error').slice(0, 500);
    return true;
  }, now);
}

async function putDoc(store, id, n, buf) {
  await store.set(keys.doc(id, n), buf);
}

async function getDoc(store, id, n) {
  const ab = await store.get(keys.doc(id, n), { type: 'arrayBuffer', consistency: 'strong' });
  if (!ab) throw new Error(`job ${id}: document ${n} is missing from the store`);
  return Buffer.from(ab);
}

async function putOut(store, id, name, data) {
  await store.setJSON(keys.out(id, name), data);
}

async function getOut(store, id, name) {
  return store.get(keys.out(id, name), { type: 'json', consistency: 'strong' });
}

async function activeJobIds(store) {
  const r = await store.list({ prefix: 'active/' });
  return (r.blobs || []).map((b) => b.key.slice('active/'.length));
}

// ---------------------------------------------------------------------------
// Page accounting. Pure.
//   docs:     [{ n, name, pages }]
//   maps:     { [n]: { forms: [{ name, pages: [..] }], unclaimed: [..] } }
//   reviewed: { [docName]: [pages] }  (from reviewAnswers)
// ---------------------------------------------------------------------------
function pageAccounting(docs, maps, reviewed = {}) {
  let total = 0, claimed = 0, reviewedCount = 0;
  const unclaimed = [];
  const unmapped = [];
  for (const d of docs) {
    total += d.pages || 0;
    const m = maps[d.n];
    if (!m) { unmapped.push(d.name); continue; }
    const missing = (m.unclaimed || []).filter((p) => p >= 1 && p <= d.pages);
    claimed += (d.pages || 0) - missing.length;
    if (missing.length) unclaimed.push({ name: d.name, pages: missing });
    reviewedCount += (reviewed[d.name] || []).length;
  }
  return { total, claimed, reviewed: reviewedCount, unclaimed, unmapped };
}

/** One plain-English paragraph for the result (and the PS comment). */
function accountingText(acct, skipped = [], gaveUp = []) {
  const lines = [];
  lines.push(`Pages: ${acct.total} received, ${acct.claimed} matched to a form, `
    + `${acct.reviewed} seller-answer pages audited.`);
  for (const u of acct.unclaimed) {
    lines.push(`NOT MATCHED TO ANY FORM: ${u.name}, page${u.pages.length > 1 ? 's' : ''} ${compactPages(u.pages)}. Look at these by hand.`);
  }
  for (const name of acct.unmapped) lines.push(`NOT PAGE-CHECKED: ${name} (page reading failed).`);
  for (const s of skipped) lines.push(`FILE NOT REVIEWED: ${s.name} (${s.reason}).`);
  for (const g of gaveUp) {
    const what = g.name.startsWith('identify') ? 'forms in this batch were not identified' : 'seller answers in this batch were not audited';
    lines.push(`INCOMPLETE: ${what} after ${MAX_ATTEMPTS} tries (${g.error}).`);
  }
  return lines.join('\n');
}

function compactPages(pages) {
  const p = [...new Set(pages)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < p.length; i++) {
    let j = i;
    while (j + 1 < p.length && p[j + 1] === p[j] + 1) j++;
    out.push(i === j ? `${p[i]}` : `${p[i]}-${p[j]}`);
    i = j;
  }
  return out.join(', ');
}

module.exports = {
  STORE_NAME, MAX_ATTEMPTS, LEASE_MS, STALL_MS, keys,
  jobIdFor, newJob, addSteps, nextStep, needsKick, OPTIONAL,
  readJob, createJob, updateJob, claimNext, completeStep, failStep,
  putDoc, getDoc, putOut, getOut, activeJobIds,
  pageAccounting, accountingText, compactPages,
};
