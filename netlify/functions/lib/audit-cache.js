// netlify/functions/lib/audit-cache.js
//
// THE SAME CONTRACT IS AUDITED ONCE. A fingerprint of the exact PDF bytes
// keys the finished audit; dropping an identical packet again returns that
// audit instantly and for nothing, instead of the ~$2.14 a full run costs
// (audit $0.93 + Call B $0.79 + extraction $0.42, September 2026 medians from
// the AI USAGE ledger).
//
// Why (Megan, 2026-09-30): Create Transaction now audits every contract the
// moment it is dropped, and "what if we have a tenant that just runs like 50
// contracts to test the platform over and over" - fifty drops of one packet
// now cost one audit. It helps her own team too: re-dropping the same packet
// is ordinary. A CHANGED packet - the corrected SMCO, a newly signed page -
// has different bytes, so it is audited fresh, which is the point of
// re-dropping it.
//
// THE KEY CARRIES THREE THINGS:
//   AUDIT_VERSION  bump it whenever the audit's prompt or its checks change,
//                  so a better audit is never hidden behind an old cached one
//                  (the counter-chain check of 2026-09-30 is v2; the
//                  Loadstone chain checks of 2026-10-01 are v3; their
//                  live-run fixes the same day are v4; the acceptance
//                  box read as "[X]" is v5; S3 shared signatures v6; S1 judged on the mark
//                  only, v7; S3 judged on the mark only, v8).
//   tenant         a firm's audit is served only to that firm (V2-ready;
//                  "default" until Keeva has tenants).
//   sha256         of the PDF's base64, which is the bytes.
// Runs with manual overrides or a prompt override (the test page) are never
// cached either way: they are experiments, not the audit.

'use strict';

const crypto = require('crypto');

const AUDIT_VERSION = 'v8';
const STORE_NAME = 'audit-cache';

function auditCacheKey(pdfBase64, tenant) {
  const hash = crypto.createHash('sha256').update(String(pdfBase64 || '')).digest('hex');
  const who = String(tenant || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'default';
  return `${AUDIT_VERSION}:${who}:${hash}`;
}

/** True when a run is an experiment that must neither use nor fill the cache. */
function isExperiment(body) {
  const overrides = (body && body.overrides) || {};
  return Boolean((body && body.prompt_override) || Object.keys(overrides).length);
}

module.exports = { AUDIT_VERSION, STORE_NAME, auditCacheKey, isExperiment };
