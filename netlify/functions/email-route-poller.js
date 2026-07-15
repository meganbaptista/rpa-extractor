// netlify/functions/email-route-poller.js
//
// ============================================================================
// Scheduled PRODUCER for the Email Router (see EMAIL-ROUTER-SPEC.md).
// ============================================================================
// Runs on the cron in netlify.toml. Lists message ids carrying the intake label
// and fans each NEW one out to email-route-background (the consumer that does
// the AI + label work). Deliberately CHEAP: it never fetches a message body —
// just ids — so it stays well under the function time limit at normal volume.
//
// DEDUPE via a Netlify Blobs "seen" store keyed by message id (same pattern as
// the disclosure watcher). In LIVE mode a routed message loses the intake label
// so it won't reappear; in SHADOW mode it keeps the label, so the seen store is
// what stops us re-deciding (and re-billing) the same message every tick.
//
// SAFETY: inert until EMAIL_ROUTER_ENABLED === 'true'. Deploying this does NOT
// start spending or touching mail until you flip that env var on. Combine with
// ROUTER.mode = 'shadow' for a zero-mutation dry run.
// ============================================================================

const { getStore } = require('@netlify/blobs');
const gmail = require('./lib/gmail');
const cfg = require('./lib/routing-config');

const SEEN_STORE = 'email-router-seen';

function seenStore() {
  return getStore({
    name: SEEN_STORE,
    siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

function baseUrl() {
  return (process.env.SELF_BASE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || '')
    .replace(/\/+$/, '');
}

async function dispatch(base, payload) {
  const res = await fetch(`${base}/.netlify/functions/email-route-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.status >= 200 && res.status < 300;
}

async function scanIntake() {
  const summary = { scanned: 0, dispatched: 0, skippedSeen: 0, errors: 0 };
  const base = baseUrl();
  if (!base) throw new Error('no base URL (set SELF_BASE_URL, or rely on Netlify URL)');

  const intakeId = await gmail.labelId(cfg.LABELS.intake);
  const messages = await gmail.listMessages({ labelIds: [intakeId] });
  summary.scanned = messages.length;

  const store = seenStore();
  for (const m of messages) {
    const key = m.id;
    // eslint-disable-next-line no-await-in-loop
    const seen = await store.get(key);
    if (seen) { summary.skippedSeen++; continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const ok = await dispatch(base, { messageId: m.id, threadId: m.threadId });
      if (ok) {
        // eslint-disable-next-line no-await-in-loop
        await store.set(key, '1');
        summary.dispatched++;
      } else {
        summary.errors++;
      }
    } catch (err) {
      console.error(`[email-router-poller] dispatch failed for ${m.id}: ${err.message}`);
      summary.errors++;
    }
  }
  return summary;
}

exports.handler = async function () {
  if (process.env.EMAIL_ROUTER_ENABLED !== 'true') {
    console.log('[email-router-poller] disabled (set EMAIL_ROUTER_ENABLED=true to run)');
    return { statusCode: 200 };
  }
  try {
    const summary = await scanIntake();
    console.log('[email-router-poller]', JSON.stringify(summary));
    return { statusCode: 200 };
  } catch (err) {
    console.error('[email-router-poller] error:', err.message);
    return { statusCode: 500 };
  }
};
