// netlify/functions/lib/keeva-audit.js
//
// THE AUDIT WRITES INTO KEEVA TOO (Megan, 2026-11-03: "we dont actually read
// it on the card, unless it snags and doesn't go to the gmail chain. It should
// write into Keeva as well though"). After a live run delivers, its summary is
// posted to Keeva (functions/audit-result there), which shows it on the deal.
//
// The key: KEEVA_AUDIT_KEY, a random key Megan makes on Keeva's Business page
// (Keeva keeps only its fingerprint). The address: KEEVA_AUDIT_URL, else
// Keeva's own. No key = skipped, logged. Never in the way: a failure here is
// logged and the run carries on.

const lines = (v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean)

/** The summary Keeva keeps, from the run's payload. */
function auditSummary({ payload, address, job, effects }) {
  return {
    jobId: job.id,
    at: new Date().toISOString(),
    address,
    source: { subject: (job.source && job.source.subject) || '', from: (job.source && (job.source.fromName || job.source.from)) || '' },
    status: payload.overall_status || '',
    summary: payload.summary || '',
    stillNeeded: lines(payload.still_needed_lines || payload.still_needed_text && String(payload.still_needed_text).split(', ').join('\n')),
    outdated: lines(payload.outdated_versions_lines),
    flags: lines(payload.response_flags_lines),
    verify: lines(payload.verify_lines),
    draftMade: Boolean(effects && effects.draft && !/^held/.test(String(effects.draft))),
  };
}

const KEEVA_URL = 'https://app.mykeeva.com/.netlify/functions/audit-result';

async function postToKeeva(store, summary, log = console.log) {
  const key = (process.env.KEEVA_AUDIT_KEY || '').trim();
  if (!key) { log('[keeva-audit] KEEVA_AUDIT_KEY not set, skipped'); return false; }
  const url = (process.env.KEEVA_AUDIT_URL || KEEVA_URL).trim();
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-keeva-audit-key': key }, body: JSON.stringify(summary) });
  if (!res.ok) throw new Error(`Keeva answered ${res.status}`);
  return true;
}

module.exports = { auditSummary, postToKeeva };
