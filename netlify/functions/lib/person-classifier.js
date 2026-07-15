// netlify/functions/lib/person-classifier.js
//
// ============================================================================
// Person-assignment classifier (Email Router — see EMAIL-ROUTER-SPEC.md).
// ============================================================================
// This automates what Belle did by hand: read an INTAKE-REVIEW email and decide
// WHO on the team should handle it (or NO_TAG / UNSURE). It renders the rulebook
// in routing-config.js (per-person duties, sender-type + buyer/seller-side
// rules, no-tag cases) into its prompt, so routing changes are config edits.
//
// Output (forced tool):
//   assignee   — a roster name, NO_TAG (no label, clear from queue), or UNSURE.
//   side       — 'buyer' | 'seller' | 'unknown' (transparency for the shadow log).
//   confidence — 0..1.
//   reason     — one sentence.
//
// Side handling: the router passes a side detected from the message's labels
// (SIDE_TAGS) when present; we pass it in as a hint. When absent the model
// infers side from content. Runs log-only while CLASSIFIER.mode === 'shadow'.
// NEVER throws on an empty roster (returns UNSURE), so the router can always call.
// ============================================================================

const usageLog = require('./usage-log');
const cfg = require('./routing-config');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NO_TAG = 'NO_TAG';
const UNSURE = 'UNSURE';

function buildTool(roster) {
  const names = roster.map((p) => p.name);
  return {
    name: 'assign_person',
    description: 'Assign this email to the teammate who should handle it, or NO_TAG / UNSURE.',
    input_schema: {
      type: 'object',
      properties: {
        assignee: {
          type: 'string',
          enum: [...names, NO_TAG, UNSURE],
          description: `Who handles this email. Use ${NO_TAG} for a no-action email that `
            + `matches a no-tag rule. Use ${UNSURE} only when it clearly needs a human but `
            + `you cannot tell who — prefer a specific person when the rulebook fits.`,
        },
        side: {
          type: 'string',
          enum: ['buyer', 'seller', 'unknown'],
          description: 'Which side of the deal this email concerns, if determinable.',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: '0–1 certainty in `assignee`. Use < 0.5 when torn between people.',
        },
        reason: { type: 'string', description: 'One sentence: which rule/duty matched.' },
      },
      required: ['assignee', 'side', 'confidence', 'reason'],
    },
  };
}

function buildSystem(roster, notes, noTagRules) {
  const people = roster.map((p, i) => `${i + 1}. ${p.name}\n   ${p.handles}`).join('\n\n');
  const noTag = noTagRules.map((r) => `- ${r}`).join('\n');
  const rules = notes.map((r) => `- ${r}`).join('\n');
  return `You route real estate transaction-coordination emails to the right teammate, exactly as our coordinator Belle was trained to. Read the NEWEST message (ignore quoted history except where a rule needs prior context) and decide who handles it.

TEAM AND WHAT EACH PERSON HANDLES:

${people}

DISAMBIGUATION RULES (apply these, don't just keyword-match):
${rules}

RETURN assignee = NO_TAG (no label needed, no action) when the email matches one of these no-tag cases:
${noTag}

RETURN assignee = UNSURE only when the email clearly needs a human but you cannot tell who. Prefer a specific person whenever the rulebook fits. It is better to be UNSURE than to misroute, but NO_TAG is for genuinely no-action mail — do not use it to dodge a hard routing call.

Call the assign_person tool with your decision.`;
}

function buildInput({ subject, from, bodyText, newestText, sideHint, tagLean }) {
  const sideLine = sideHint
    ? `SIDE (from a sub-label on this email): ${sideHint}`
      + (tagLean ? ` — this sub-label USUALLY means ${tagLean} handles it; follow that unless the content clearly points to someone else.` : '')
    : 'SIDE: not tagged — infer from content if you can.';
  return [
    `SUBJECT: ${subject || '(none)'}`,
    `SENDER: ${from || '(unknown)'}`,
    sideLine,
    '',
    'NEWEST MESSAGE:',
    (newestText || bodyText || '').trim() || '(empty)',
    '',
    'THREAD CONTEXT (quoted history, if any):',
    (bodyText || '').trim() || '(empty)',
  ].join('\n');
}

async function callClassifier(system, tool, userText, note = '', attempt = 0) {
  const MAX_RETRIES = 4;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var not set');

  const body = {
    model: cfg.CLASSIFIER.model,
    max_tokens: 1024,
    system,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: userText }],
  };

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });

  if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter ? Math.min(parseFloat(retryAfter) * 1000, 30000) : Math.min(1000 * Math.pow(2, attempt), 30000);
    console.log(`[person-classifier] ${response.status}, retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
    return callClassifier(system, tool, userText, note, attempt + 1);
  }
  if (!response.ok) throw new Error(`person-classifier API error ${response.status}: ${await response.text()}`);

  const data = await response.json();
  await usageLog.logUsage({ fn: 'person-classifier', model: cfg.CLASSIFIER.model, effort: cfg.CLASSIFIER.effort, usage: data.usage, note });

  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
  if (!toolUse) throw new Error('person-classifier returned no tool_use block');
  return toolUse.input;
}

// Public: suggest an assignee for ONE message.
//   message   — lib/gmail.js getMessage() shape.
//   opts.side — 'buyer'|'seller' detected from labels (router passes it), or null.
// Returns { assignee, person, personLabel, noTag, unsure, side, confidence, reason }.
async function classify(message, { roster = cfg.ROSTER, side = null, tagLean = null, note = '' } = {}) {
  if (!Array.isArray(roster) || roster.length === 0) {
    return { assignee: UNSURE, person: null, personLabel: null, noTag: false, unsure: true, side: side || 'unknown', confidence: 0, reason: 'roster is empty' };
  }
  const h = message.headers || {};
  const userText = buildInput({ subject: h.subject, from: h.from, bodyText: message.bodyText, newestText: message.newestText, sideHint: side, tagLean });
  const out = await callClassifier(
    buildSystem(roster, cfg.ROUTING_NOTES, cfg.NO_TAG_RULES),
    buildTool(roster),
    userText,
    note || `msg ${message.id || '?'}`,
  );

  const assignee = out.assignee || UNSURE;
  const match = roster.find((p) => p.name === assignee) || null;
  return {
    assignee,
    person: match ? match.name : null,
    personLabel: match ? match.personLabel : null,
    noTag: assignee === NO_TAG,
    unsure: assignee === UNSURE,
    side: out.side || side || 'unknown',
    confidence: Number(out.confidence) || 0,
    reason: out.reason || '',
  };
}

module.exports = { classify, NO_TAG, UNSURE, _internal: { buildSystem, buildTool, buildInput } };
