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
//     But it can only do CACHED reads (no uncached URL in the Lambda context),
//     and a read right after a write commonly returns the old value or null.
//     Found live 2026-10-21: every new job read back as missing, so no job was
//     ever created, and the conditions probe misreported IGNORED.
// So, HYBRID: READ through the token (strong, uncached), WRITE through the
// function context (conditions enforced). Same store, same etags. Without a
// function context everything goes through the token and lib/intake-job.js's
// write-then-read-back is the guard. The poller records which mode it got and
// whether a condition held (checkConditions), so going live is decided on
// evidence.

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

function tokenStore(name) {
  return getStore({ name, siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

/** Reads through the token (fresh), writes through the function context (conditional). */
function hybrid(name) {
  const reader = tokenStore(name);
  // The function context is process-global, so read it NOW, not per call.
  const writer = getStore({ name });
  const strong = (o) => ({ ...(o || {}), consistency: 'strong' });
  return {
    getWithMetadata: (k, o) => reader.getWithMetadata(k, strong(o)),
    get: (k, o) => reader.get(k, strong(o)),
    list: (o) => reader.list(o),
    setJSON: (k, v, o) => writer.setJSON(k, v, o),
    set: (k, v, o) => writer.set(k, v, o),
    delete: (k) => writer.delete(k),
  };
}

function blobs(name) {
  return functionMode ? hybrid(name) : tokenStore(name);
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
  let detail = '';
  try {
    const first = await store.setJSON(key, { v: 1 }, { onlyIfNew: true });
    const second = await store.setJSON(key, { v: 2 }, { onlyIfNew: true });
    const back = await store.get(key, { type: 'json', consistency: 'strong' });
    held = !!(second && second.modified === false) && !!back && back.v === 1;
    detail = `first.modified=${first && first.modified} second.modified=${second && second.modified} read=${JSON.stringify(back)}`;
    await store.delete(key);
  } catch (err) {
    detail = `probe failed: ${err.message}`;
    console.warn(`[intake-runtime] conditions ${detail}`);
  }
  const result = { mode: functionMode ? 'function (token reads)' : 'token', conditionsHeld: held, detail, at: Date.now() };
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
