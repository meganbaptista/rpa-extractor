// netlify/functions/lib/keeva-audit.js
//
// THE AUDIT WRITES INTO KEEVA TOO (Megan, 2026-11-03: "we dont actually read
// it on the card, unless it snags and doesn't go to the gmail chain. It should
// write into Keeva as well though"). After a live run delivers, its summary is
// posted to Keeva (functions/audit-result there), which shows it on the deal.
//
// The key: a random key, kept in this site's storage (meta/keeva-audit), whose
// fingerprint Keeva keeps. The address: Keeva's own unless the blob names one. No key = skipped, logged. Never in the way: a failure here is
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
  /*
    THE KEY LIVES IN THIS SITE'S OWN STORAGE (`meta/keeva-audit` { key, url? }),
    not a Netlify setting: KEEVA_AUDIT_KEY pushed the site past Netlify's 4KB
    limit on settings and every deploy failed (2026-11-03). The setting is
    still read if present, for a site with room.
  */
  const conf = store ? await store.get('meta/keeva-audit', { type: 'json' }).catch(() => null) : null;
  const key = ((conf && conf.key) || process.env.KEEVA_AUDIT_KEY || '').trim();
  if (!key) { log('[keeva-audit] no key (meta/keeva-audit), skipped'); return false; }
  const url = ((conf && conf.url) || process.env.KEEVA_AUDIT_URL || KEEVA_URL).trim();
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-keeva-audit-key': key }, body: JSON.stringify(summary) });
  if (!res.ok) throw new Error(`Keeva answered ${res.status}`);
  return true;
}

module.exports = { auditSummary, postToKeeva };
