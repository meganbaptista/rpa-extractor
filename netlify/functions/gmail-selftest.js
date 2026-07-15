// netlify/functions/gmail-selftest.js
//
// ============================================================================
// Read-only verification endpoint for the Email Router (see EMAIL-ROUTER-SPEC.md).
// Hit its URL once after setting up domain-wide delegation + env vars to confirm:
//   1. the service account can authenticate AS the mailbox (delegation works),
//   2. the configured labels actually exist in Gmail (esp. the exact "JILL✨"),
//   3. the INTAKE - REVIEW queue is reachable and how many messages sit in it.
//
// It MUTATES NOTHING — it only lists labels + counts intake messages. Safe to
// call anytime, independent of EMAIL_ROUTER_ENABLED / ROUTER.mode. Not on a
// schedule; you invoke it manually:
//   https://<your-site>/.netlify/functions/gmail-selftest
// ============================================================================

const gmail = require('./lib/gmail');
const cfg = require('./lib/routing-config');

exports.handler = async function () {
  const out = { ok: false, mailbox: null, checks: {} };
  try {
    out.mailbox = gmail.subject(); // throws if GMAIL_IMPERSONATE_SUBJECT unset

    // Auth + delegation: listing labels forces a token mint AS the mailbox.
    const labels = await gmail.listLabels({ fresh: true });
    const names = new Set(labels.map((l) => (l.name || '').toLowerCase()));
    out.totalLabels = labels.length;

    // The intake label MUST exist (the router errors without it).
    const intakeFound = names.has(cfg.LABELS.intake.toLowerCase());
    out.checks.intakeLabel = { name: cfg.LABELS.intake, exists: intakeFound };
    if (intakeFound) {
      const id = await gmail.labelId(cfg.LABELS.intake);
      const msgs = await gmail.listMessages({ labelIds: [id] });
      out.checks.intakeLabel.messageCount = msgs.length;
    }

    // Side tags (optional — only matter if you use them).
    out.checks.sideTags = [...cfg.SIDE_TAGS.buyer, ...cfg.SIDE_TAGS.seller]
      .map((n) => ({ name: n, exists: names.has(n.toLowerCase()) }));

    // Person labels + Needs Attention. These AUTO-CREATE if missing, so "exists:
    // false" is not an error — it just means the router will create it on first
    // use. The value here is confirming the ones you expect (JILL✨) match now.
    out.checks.personLabels = cfg.ROSTER.map((p) => ({
      name: p.personLabel,
      exists: names.has(p.personLabel.toLowerCase()),
      autoCreated: true,
    }));
    out.checks.needsAttention = {
      name: cfg.LABELS.needsAttention,
      exists: names.has(cfg.LABELS.needsAttention.toLowerCase()),
      autoCreated: true,
    };

    out.ok = intakeFound; // the one hard requirement
    if (!intakeFound) {
      out.hint = `Create the "${cfg.LABELS.intake}" label in Gmail (exact name) — the router scans it.`;
    }
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out, null, 2) };
  } catch (err) {
    out.error = err.message;
    // Give the most likely cause for the common failure modes.
    if (/token exchange failed|unauthorized_client|access_denied|403/i.test(err.message)) {
      out.hint = 'Delegation not authorized yet. Confirm the SA client_id is authorized for '
        + 'scope https://www.googleapis.com/auth/gmail.modify in Admin console > Domain-wide '
        + 'Delegation, and that GMAIL_IMPERSONATE_SUBJECT is a real mailbox. Propagation can take a few minutes.';
    } else if (/GMAIL_IMPERSONATE_SUBJECT|GOOGLE_SA_JSON/i.test(err.message)) {
      out.hint = 'Set the missing env var in Netlify, then redeploy.';
    }
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out, null, 2) };
  }
};
