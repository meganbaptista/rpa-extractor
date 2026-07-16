// netlify/functions/lib/alert.js
//
// ============================================================================
// Throttled alerting for the Email Router (see EMAIL-ROUTER-SPEC.md).
// ============================================================================
// A "loud" signal for silent degradation (e.g. the deal-side list reading 0
// because a tab got renamed or the sheet was un-shared). Every alert:
//   • console.error (caught by any Netlify log drain / monitoring),
//   • POSTs to ALERT_WEBHOOK_URL if set — wire this to a Zapier catch-hook that
//     emails/Slacks you for a real push notification (leverages your Zapier).
// Throttled via a Netlify Blobs store so a persistent problem pings you at most
// once per window (default 60 min) instead of every 2-minute poll. Never throws.
// ============================================================================

const { getStore } = require('@netlify/blobs');

const STORE = 'router-alerts';
const DEFAULT_THROTTLE_MS = 60 * 60 * 1000;

function store() {
  return getStore({
    name: STORE,
    siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

// Fire an alert for `key`, at most once per throttle window. `key` groups a
// recurring condition (e.g. "deal-list") so it doesn't spam. Returns whether it
// actually sent this time.
async function alert(key, message, { throttleMs = DEFAULT_THROTTLE_MS } = {}) {
  const line = `[ROUTER ALERT] ${key}: ${message}`;
  try { console.error(line); } catch (_) { /* noop */ }

  const now = Date.now();
  let s;
  try {
    s = store();
    const last = await s.get(`${key}`);
    if (last && now - Number(last) < throttleMs) return false; // within window, already alerted
  } catch (err) {
    // If the throttle store is unreachable, still try to send (better a dup than silence).
    console.warn(`[alert] throttle read failed: ${err.message}`);
  }

  const url = process.env.ALERT_WEBHOOK_URL;
  if (url) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'email-router', key, message, at: new Date().toISOString() }),
      });
    } catch (err) {
      console.warn(`[alert] webhook POST failed: ${err.message}`);
    }
  }

  try { if (s) await s.set(`${key}`, String(now)); } catch (_) { /* noop */ }
  return true;
}

// Clear a key's throttle so the next alert fires immediately (call when a
// condition recovers, if you want the next failure to alert without waiting).
async function clearAlert(key) {
  try { await store().delete(`${key}`); } catch (_) { /* noop */ }
}

module.exports = { alert, clearAlert };
