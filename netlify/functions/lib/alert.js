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
async function alert(key, message, { throttleMs = DEFAULT_THROTTLE_MS, force = false, source = 'email-router', label = 'Email Router' } = {}) {
  const line = `[${label.toUpperCase()} ALERT] ${key}: ${message}`;
  try { console.error(line); } catch (_) { /* noop */ }

  const now = Date.now();
  let s;
  if (!force) {
    try {
      s = store();
      const last = await s.get(`${key}`);
      if (last && now - Number(last) < throttleMs) return false; // within window, already alerted
    } catch (err) {
      // If the throttle store is unreachable, still try to send (better a dup than silence).
      console.warn(`[alert] throttle read failed: ${err.message}`);
    }
  }

  const url = process.env.ALERT_WEBHOOK_URL;
  if (url) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `text` renders directly in a Slack incoming webhook; the structured
        // fields are there for a Zapier catch-hook to map into an email/Slack.
        body: JSON.stringify({
          /**
           * SAY WHAT THIS ACTUALLY IS.
           *
           * Both fields were hardcoded to the Email Router, which was true
           * when this module had one caller. It now serves the disclosure
           * pipeline too, and Megan's Zapier catch-hook branches on nothing —
           * so a compliance preview arrived titled "Email Router Alert" and
           * with the router's own canned explanation appended: "This means
           * that it could not find a escrow in our MTC Information google
           * sheet." True of a router alert, nonsense about a Google Doc.
           *
           * `source` is the field to branch a Zap on; `label` is what a human
           * reads. Both default to the router so the existing caller and its
           * Zap are unchanged.
           */
          text: `🚨 ${label} alert — ${key}: ${message}`,
          source,
          key,
          message,
          at: new Date().toISOString(),
        }),
      });
    } catch (err) {
      console.warn(`[alert] webhook POST failed: ${err.message}`);
    }
  }

  try { if (!force) { s = s || store(); await s.set(`${key}`, String(now)); } } catch (_) { /* noop */ }
  return true;
}

// Clear a key's throttle so the next alert fires immediately (call when a
// condition recovers, if you want the next failure to alert without waiting).
async function clearAlert(key) {
  try { await store().delete(`${key}`); } catch (_) { /* noop */ }
}

module.exports = { alert, clearAlert };
