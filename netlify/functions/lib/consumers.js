// netlify/functions/lib/consumers.js
//
// ============================================================================
// Consumer registry for the Disclosure Intake Pipeline (see
// DISCLOSURE-INTAKE-PIPELINE.md). This is the PLUG-IN SURFACE: adding a
// capability = add a row here + build its `<fn>.js` background function. The
// producer never changes.
// ============================================================================
// Each row:
//   name    - label for logs
//   fn      - the Netlify function file name (POSTed at /.netlify/functions/<fn>)
//   events  - which event types this consumer listens for
//   enabled - false = registered but dormant (built later)
//
// Intentionally just DATA. Later this table can move to a Google Sheet /
// per-tenant config without touching the event bus (lib/events.js).
// ============================================================================

const CONSUMERS = [
  // Consumer #1 — the splitter (built now). Everything below is a placeholder
  // for a future consumer and stays disabled until its function exists.
  { name: 'splitter',         fn: 'disclosure-split-background',      events: ['disclosure.uploaded'], enabled: true  },

  { name: 'ocr',              fn: 'disclosure-ocr-background',        events: ['disclosure.uploaded'], enabled: false },
  { name: 'classify',         fn: 'disclosure-classify-background',   events: ['disclosure.uploaded'], enabled: false },
  // These listen for `disclosure.split` (emitted by the splitter once it has the
  // per-form file ids) — that cascade is how the ORDERED steps run without a
  // central orchestrator.
  { name: 'signature-verify', fn: 'disclosure-sigverify-background',  events: ['disclosure.split'],    enabled: false },
  { name: 'compliance',       fn: 'disclosure-compliance-background', events: ['disclosure.split'],    enabled: false },
  { name: 'email-draft',      fn: 'disclosure-email-background',      events: ['disclosure.split'],    enabled: false },
  { name: 'timeline',         fn: 'disclosure-timeline-background',   events: ['disclosure.uploaded'], enabled: false },
];

// Beta guard. While the allowlist is NON-EMPTY, only events whose
// location.propertyFolderId is listed are dispatched — so we can roll the
// pipeline out against a single test property before going live. Empty = process
// everything (full rollout). Overridable without a code change via
// DISCLOSURE_FOLDER_ALLOWLIST (comma-separated folder ids).
const BETA_FOLDER_ALLOWLIST = [];

function folderAllowlist() {
  const fromEnv = (process.env.DISCLOSURE_FOLDER_ALLOWLIST || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : BETA_FOLDER_ALLOWLIST;
}

// True if this event is allowed through the beta guard.
function passesBetaGuard(event) {
  const allow = folderAllowlist();
  if (!allow.length) return true;
  const fid = event && event.location && event.location.propertyFolderId;
  return allow.includes(fid);
}

module.exports = { CONSUMERS, folderAllowlist, passesBetaGuard };
