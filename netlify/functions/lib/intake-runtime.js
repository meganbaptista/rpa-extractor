// netlify/functions/lib/intake-runtime.js
//
// The live wiring for the intake job: the real Blobs stores, Gmail, alerts and
// the HTTP kick that starts the next step. Kept apart from lib/intake-steps.js
// so the local replay can swap every piece of it.

const { getStore } = require('@netlify/blobs');
const J = require('./intake-job');
const { baseUrl } = require('./events');
const { alert } = require('./alert');

const MODE = () => String(process.env.INTAKE_JOB_MODE || 'off').trim().toLowerCase();   // off | shadow | live
const LABEL = () => process.env.INTAKE_JOB_LABEL || 'Disclosures - AI Review';
const STEP_FN = 'disclosure-intake-job-step-background';

function blobs(name) {
  return getStore({ name, siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

const jobStore = () => blobs(J.STORE_NAME);

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

module.exports = { MODE, LABEL, STEP_FN, blobs, jobStore, kick, intakeAlert };
