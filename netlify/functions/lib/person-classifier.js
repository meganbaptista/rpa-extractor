// netlify/functions/lib/person-classifier.js
//
// ============================================================================
// V2 person-assignment classifier (Email Router — see EMAIL-ROUTER-SPEC.md).
// ============================================================================
// The V1 router stops at "Needs Attention" for Branch B (important, but no
// category tells us who owns it). This is the V2 upgrade: given the team ROSTER
// (from routing-config.js) and the email, decide WHICH teammate should handle
// it — "this belongs to Jill" — or UNSURE, which falls back to Needs Attention.
//
// It reads ONLY roster[].handles to decide, so the quality of that description is
// the quality of the routing. Runs log-only while CLASSIFIER.mode === 'shadow'
// (the router logs the suggestion but applies Needs Attention); flipping to
// 'live' makes the router apply the suggested person label above the confidence
// threshold. The classifier itself doesn't know the mode — it just suggests; the
// router decides whether to act on it. That keeps this module pure + testable.
// ============================================================================

const usageLog = require('./usage-log');
const { CLASSIFIER, ROSTER } = require('./routing-config');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UNSURE = 'UNSURE';

function buildTool(roster) {
  const names = roster.map((p) => p.name);
  return {
    name: 'assign_person',
    description: 'Assign this email to the single teammate who should handle it, or UNSURE.',
    input_schema: {
      type: 'object',
      properties: {
        assignee: {
          type: 'string',
          enum: [...names, UNSURE],
          description: 'The teammate who should handle this email, or UNSURE if no one clearly fits.',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: '0–1 certainty that `assignee` is correct. Use < 0.5 when torn between people.',
        },
        reason: { type: 'string', description: 'One sentence: which duties in their brief matched.' },
      },
      required: ['assignee', 'confidence', 'reason'],
    },
  };
}

function buildSystem(roster) {
  const brief = roster
    .map((p, i) => `${i + 1}. ${p.name} — ${p.handles}`)
    .join('\n');
  return `You route real estate transaction emails to the right teammate on a transaction-coordination team.

Here is the team and what each person handles:
${brief}

Decide which SINGLE teammate should handle the email below, based only on what each person handles. If the email plausibly fits more than one person, pick the best fit and lower your confidence. If no one clearly fits, or the email is ambiguous, return assignee = "${UNSURE}". It is better to return ${UNSURE} than to guess — an unsure email is reviewed by a human, a wrong guess is misrouted.

Consider the sender, the subject, the deal stage, document types, and what is being asked. Call the assign_person tool with your answer.`;
}

function buildInput({ subject, from, bodyText, newestText }) {
  return [
    `SUBJECT: ${subject || '(none)'}`,
    `SENDER: ${from || '(unknown)'}`,
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

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLASSIFIER.model,
      max_tokens: 1024,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: userText }],
    }),
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
  await usageLog.logUsage({ fn: 'person-classifier', model: CLASSIFIER.model, effort: CLASSIFIER.effort, usage: data.usage, note });

  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
  if (!toolUse) throw new Error('person-classifier returned no tool_use block');
  return toolUse.input;
}

// Public: suggest an assignee for ONE message. `message` is lib/gmail.js
// getMessage() shape. `roster` defaults to config ROSTER (injectable for tests).
// Returns a normalized suggestion — NEVER throws on an empty roster (nothing to
// assign to → UNSURE), so the router can call it unconditionally.
//   { person: string|null, personLabel: string|null, confidence: number, reason: string }
async function classify(message, { roster = ROSTER, note = '' } = {}) {
  if (!Array.isArray(roster) || roster.length === 0) {
    return { person: null, personLabel: null, confidence: 0, reason: 'roster is empty — nothing to assign to' };
  }
  const h = message.headers || {};
  const userText = buildInput({ subject: h.subject, from: h.from, bodyText: message.bodyText, newestText: message.newestText });
  const out = await callClassifier(
    buildSystem(roster),
    buildTool(roster),
    userText,
    note || `msg ${message.id || '?'}`,
  );

  if (!out.assignee || out.assignee === UNSURE) {
    return { person: null, personLabel: null, confidence: Number(out.confidence) || 0, reason: out.reason || '' };
  }
  const match = roster.find((p) => p.name === out.assignee) || null;
  return {
    person: match ? match.name : null,
    personLabel: match ? match.personLabel : null,
    confidence: Number(out.confidence) || 0,
    reason: out.reason || '',
  };
}

module.exports = { classify, UNSURE, _internal: { buildSystem, buildTool, buildInput } };
