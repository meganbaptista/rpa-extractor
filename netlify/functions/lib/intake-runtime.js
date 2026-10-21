// netlify/functions/lib/intake-runtime.js
//
// The live wiring for the intake job: the real Blobs stores, Gmail, alerts and
// the HTTP kick that starts the next step. Kept apart from lib/intake-steps.js
// so the local replay can swap every piece of it.
//
// TWO WAYS TO REACH BLOBS, AND ONLY ONE ENFORCES A CONDITIONAL WRITE.
//   token mode (siteID + NETLIFY_BLOBS_TOKEN, how the rest of rpa-extractor
//     connects): a write goes to a pre-signed upload URL, and the if-match /
//     if-none-match headers are ignored there. Measured 2026-10-21: onlyIfNew
//     overwrote, a wrong onlyIfMatch still wrote, both said modified: true.
//   function mode (connectLambda(event), the invocation's own Blobs context):
//     writes go to the Blobs edge, which answers a failed condition with 412.
//     It cannot do `strong` reads (no uncached URL in the Lambda context), so
//     the consistency option is dropped in this mode; a stale read is caught by
//     the conditional write that follows it.
// connect(event) uses function mode whenever the invocation carries a context,
// and falls back to token mode, where lib/intake-job.js's write-then-read-back
// is the guard. The poller records which mode it got and whether a condition
// actually held (checkConditions), so going live is decided on evidence.

const { getStore, connectLambda } = require('@netlify/blobs');
const J = require('./intake-job');
const { baseUrl } = require('./events');
const { alert } = require('./alert');

const MODE = () => String(process.env.INTAKE_JOB_MODE || 'off').trim().toLowerCase();   // off | shadow | live
const LABEL = () => process.env.INTAKE_JOB_LABEL || 'Disclosures - AI Review';
const STEP_FN = 'disclosure-intake-job-step-background';

let functionMode = false;

function connect(event) {
  functionMode = false;
  try {
    if (event && event.blobs) { connectLambda(event); functionMode = true; }
  } catch (err) {
    console.warn(`[intake-runtime] no Blobs function context (${err.message}); using the token`);
  }
  return functionMode ? 'function' : 'token';
}

/** In function mode, drop `consistency` (strong reads are unavailable there). */
function withoutStrong(store) {
  const strip = (o) => { if (o && o.consistency) { const c = { ...o }; delete c.consistency; return c; } return o; };
  return {
    getWithMetadata: (k, o) => store.getWithMetadata(k, strip(o)),
    get: (k, o) => store.get(k, strip(o)),
    setJSON: (k, v, o) => store.setJSON(k, v, o),
    set: (k, v, o) => store.set(k, v, o),
    delete: (k) => store.delete(k),
    list: (o) => store.list(o),
  };
}

function blobs(name) {
  if (functionMode) return withoutStrong(getStore({ name }));
  return getStore({ name, siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

const jobStore = () => blobs(J.STORE_NAME);

/** The write-then-read-back pause: needed only where conditions are ignored. */
const verifyMs = () => (functionMode ? 0 : J.VERIFY_MS);

/**
 * Does a conditional write actually hold on this connection? Writes a probe key
 * twice with onlyIfNew and reads it back, then records the answer at
 * meta/conditions for checks/intake-job-status.js. Never throws.
 */
async function checkConditions(store) {
  const key = `meta/probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let held = null;
  try {
    await store.setJSON(key, { v: 1 }, { onlyIfNew: true });
    const second = await store.setJSON(key, { v: 2 }, { onlyIfNew: true });
    const back = await store.get(key, { type: 'json', consistency: 'strong' });
    held = !!(second && second.modified === false) && !!back && back.v === 1;
    await store.delete(key);
  } catch (err) {
    console.warn(`[intake-runtime] conditions probe failed: ${err.message}`);
  }
  const result = { mode: functionMode ? 'function' : 'token', conditionsHeld: held, at: Date.now() };
  try { await store.setJSON('meta/conditions', result); } catch (e) { /* best effort */ }
  return result;
}

/** Start the next step of a job in a fresh background invocation (202 at once). */
async function kick(jobId) {
  const base = baseUrl();
  if (!base) throw new Error('no base URL (set SELF_BASE_URL, or rely on Netlify URL)');
  const res = await fetch(`${base}/.netlify/functions/${STEP_FN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId }),
  });
  if (!res.ok && res.status !== 202) throw new Error(`kick ${jobId}: HTTP ${res.status}`);
}

function intakeAlert(key, message) {
  return alert(key, message, { source: 'disclosure-intake', label: 'Disclosure Intake' });
}

module.exports = { MODE, LABEL, STEP_FN, connect, blobs, jobStore, verifyMs, checkConditions, kick, intakeAlert };
