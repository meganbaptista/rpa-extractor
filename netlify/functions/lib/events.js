// netlify/functions/lib/events.js
//
// ============================================================================
// Event bus for the Disclosure Intake Pipeline (see
// DISCLOSURE-INTAKE-PIPELINE.md). Defines WHAT an event is (a stable, versioned
// envelope) and HOW it is delivered (HTTP fan-out to the consumers registered in
// lib/consumers.js). No Zapier, no Kafka — serverless-native, nothing to run.
// ============================================================================

const { CONSUMERS, passesBetaGuard } = require('./consumers');

// Event type constants — never type these as loose strings elsewhere.
const EVENTS = {
  DISCLOSURE_UPLOADED: 'disclosure.uploaded', // producer: watcher, on a new file in an Incoming folder
  DISCLOSURE_SPLIT: 'disclosure.split',       // producer: splitter, once per-form files exist
};

// The envelope version. Bump only on a breaking shape change so consumers can
// branch on it.
const ENVELOPE_VERSION = 1;

// Build a standard envelope. `payload` carries { id, source, location, ... };
// `id` is the dedupe key (consumers must be idempotent on it).
function makeEvent(type, payload = {}) {
  const { id, ...rest } = payload;
  return {
    event: type,
    version: ENVELOPE_VERSION,
    id: id || '',
    occurredAt: new Date().toISOString(),
    ...rest,
  };
}

// Base URL of THIS site's functions. Netlify injects URL / DEPLOY_PRIME_URL;
// SELF_BASE_URL overrides (e.g. local testing).
function baseUrl() {
  return (process.env.SELF_BASE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || '')
    .replace(/\/+$/, '');
}

// Fan an event out to every enabled consumer subscribed to its type. Each
// dispatch is failure-isolated: one bad consumer is recorded and skipped, never
// blocking the others. Returns a per-consumer status array for logging.
async function publish(event) {
  if (!passesBetaGuard(event)) {
    console.log(`[events] beta guard blocked ${event.event} for folder ${event.location && event.location.propertyFolderId}`);
    return [];
  }

  const base = baseUrl();
  const targets = CONSUMERS.filter((c) => c.enabled && Array.isArray(c.events) && c.events.includes(event.event));
  if (!targets.length) {
    console.log(`[events] no enabled consumers for ${event.event}`);
    return [];
  }

  return Promise.all(targets.map(async (c) => {
    try {
      if (!base) throw new Error('no base URL (set SELF_BASE_URL, or rely on Netlify URL)');
      const url = `${base}/.netlify/functions/${c.fn}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      const ok = res.status >= 200 && res.status < 300;
      if (!ok) console.warn(`[events] ${c.name} <- ${event.event}: HTTP ${res.status}`);
      return { consumer: c.name, ok, status: res.status };
    } catch (err) {
      console.error(`[events] ${c.name} <- ${event.event} failed: ${err.message}`);
      return { consumer: c.name, ok: false, error: err.message };
    }
  }));
}

module.exports = { EVENTS, ENVELOPE_VERSION, makeEvent, publish, baseUrl };
