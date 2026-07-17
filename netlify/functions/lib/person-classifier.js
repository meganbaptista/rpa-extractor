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
//   assignee   — a roster name, a PAIRS name (two people, e.g. "Belle+Megan"),
//                NO_TAG (no label, clear from queue), or UNSURE.
//   side       — 'buyer' | 'seller' | 'unknown' (transparency for the shadow log).
//   confidence — 0..1.
//   reason     — one sentence.
//
// Pairs are a CLOSED list of named two-person situations (routing-config PAIRS),
// not a general "tag N people" ability — see the guardrail in buildSystem(). The
// enum is what enforces it: the model picks one discrete value, so it can never
// invent a pairing the rulebook doesn't name.
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

function buildTool(roster, pairs = []) {
  const names = roster.map((p) => p.name);
  const pairNames = pairs.map((p) => p.name);
  const pairClause = pairNames.length
    ? ` The ${pairNames.join(' / ')} value${pairNames.length > 1 ? 's tag' : ' tags'} TWO people `
      + 'and may ONLY be used for the exact case listed under PAIRED ASSIGNMENTS — never to hedge '
      + 'between two people.'
    : '';
  return {
    name: 'assign_person',
    description: 'Assign this email to the teammate who should handle it, or NO_TAG / UNSURE.',
    input_schema: {
      type: 'object',
      properties: {
        assignee: {
          type: 'string',
          enum: [...names, ...pairNames, NO_TAG, UNSURE],
          description: `Who handles this email. Use ${NO_TAG} for a no-action email that `
            + `matches a no-tag rule. Use ${UNSURE} only when it clearly needs a human but `
            + `you cannot tell who — prefer a specific person when the rulebook fits.`
            + pairClause,
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

function buildSystem(roster, notes, noTagRules, pairs = []) {
  const people = roster.map((p, i) => `${i + 1}. ${p.name}\n   ${p.handles}`).join('\n\n');
  const noTag = noTagRules.map((r) => `- ${r}`).join('\n');
  const rules = notes.map((r) => `- ${r}`).join('\n');
  // Paired assignees are a closed list of named situations, not a general
  // "tag two people" capability — the guardrail below is what keeps the model
  // from pairing to hedge whenever a call is hard. Omitted entirely when there
  // are no pairs, so the concept never enters the prompt unused.
  const pairBlock = pairs.length
    ? `\nPAIRED ASSIGNMENTS — the ONLY situations where an email gets TWO people:
${pairs.map((p) => `- ${p.name} (tags ${p.members.join(' and ')}): ${p.when}`).join('\n')}

Use a paired assignee ONLY when the email matches that pair's situation above, because BOTH people must genuinely act. NEVER pair people to hedge: being torn between two people is NOT a pairing — pick the better fit, or return UNSURE. A pairing means "both must act", never "I could not decide". Every other email gets exactly ONE person.\n`
    : '';
  return `You route real estate transaction-coordination emails to the right teammate, exactly as our coordinator Belle was trained to. The NEWEST message is the immediate ask, but use the SUBJECT and the WHOLE THREAD to decide what KIND of deal this is and who OWNS the file — routing follows the file owner, not just the words in the latest reply. (E.g. a lease thread belongs to Megan even if the newest message is a generic payment question.) Then decide who handles it.

TEAM AND WHAT EACH PERSON HANDLES:

${people}

DISAMBIGUATION RULES (apply these, don't just keyword-match):
${rules}
${pairBlock}
RETURN assignee = NO_TAG (no label needed, no action) when the email matches one of these no-tag cases:
${noTag}

RETURN assignee = UNSURE only when the email clearly needs a human but you cannot tell who. Prefer a specific person whenever the rulebook fits. It is better to be UNSURE than to misroute, but NO_TAG is for genuinely no-action mail — do not use it to dodge a hard routing call.

Call the assign_person tool with your decision.`;
}

function buildInput({ subject, from, bodyText, newestText, sideHint, tagLean, labelHints, attachments }) {
  const attLine = (attachments && attachments.length)
    ? 'ATTACHMENT FILENAMES (the filename often names the document type — e.g. "Cancellation", "RR", "AVID", "Addendum", a CAR form code): '
      + attachments.map((a) => a && a.filename).filter(Boolean).join('; ')
    : null;
  const sideLine = sideHint
    ? `SIDE we represent on this deal: ${sideHint}`
      + (tagLean
        ? ` — a disclosure sub-label is present, which USUALLY means ${tagLean} handles it; follow that unless the content clearly points to someone else.`
        : ' — use this ONLY to disambiguate buyer vs seller; it does NOT by itself imply a person. Route by the content/document.')
    : 'SIDE: unknown — infer from content if you can.';
  const hintLine = (labelHints && labelHints.length)
    ? 'THREAD LABELS suggesting an owner: '
      + labelHints.map((h) => `"${h.label}" -> usually ${h.person}`).join('; ')
      + '. Treat as strong priors; follow unless the newest message clearly belongs to someone else.'
    : null;
  return [
    `SUBJECT: ${subject || '(none)'}`,
    `SENDER: ${from || '(unknown)'}`,
    sideLine,
    hintLine,
    attLine,
    '',
    'NEWEST MESSAGE:',
    (newestText || bodyText || '').trim() || '(empty)',
    '',
    'THREAD CONTEXT (quoted history, if any):',
    (bodyText || '').trim() || '(empty)',
  ].filter((l) => l != null).join('\n');
}

async function callClassifier(system, tool, userText, note = '', attempt = 0) {
  const MAX_RETRIES = 4;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var not set');

  const body = {
    model: cfg.CLASSIFIER.model,
    max_tokens: 1024,
    // Prompt caching: the rulebook system prompt is identical on every call, so
    // mark it cacheable. The breakpoint on the system block caches the static
    // prefix (tool schema + rulebook); only the per-email body pays full price.
    // Cache hits bill at ~10% of input — a big cut once emails arrive in bursts.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
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

// Resolve an assignee to the Gmail label(s) it applies. A roster name yields one
// label; a PAIRS name yields one per member.
//
// A pair whose members do not ALL resolve yields NO labels, which sends the email
// to Needs Attention. That is deliberate: half-labeling a two-person email is
// worse than deferring to a human, because the person who was dropped never
// learns they were needed and the ledger still looks like a clean route.
function resolveLabels(assignee, roster, pairs) {
  const person = roster.find((p) => p.name === assignee);
  if (person) return { name: person.name, labels: [person.personLabel] };

  const pair = pairs.find((p) => p.name === assignee);
  if (!pair) return { name: null, labels: [] }; // NO_TAG / UNSURE / unknown value

  const labels = pair.members.map((m) => {
    const hit = roster.find((p) => p.name === m);
    if (!hit) console.warn(`[person-classifier] pair "${pair.name}" names "${m}", who is not in the ROSTER — falling back to Needs Attention`);
    return hit ? hit.personLabel : null;
  });
  if (labels.some((l) => !l)) return { name: null, labels: [] };
  return { name: pair.name, labels };
}

// Public: suggest an assignee for ONE message.
//   message    — lib/gmail.js getMessage() shape.
//   opts.side  — 'buyer'|'seller' detected from labels (router passes it), or null.
//   opts.pairs — two-person cases (see PAIRS in routing-config.js).
// Returns { assignee, person, personLabels, noTag, unsure, side, confidence, reason }.
// `personLabels` holds 0, 1, or (for a pair) 2 Gmail labels — the router applies
// them all; an empty array means "no person label" (NO_TAG / UNSURE / unresolved).
async function classify(message, { roster = cfg.ROSTER, pairs = cfg.PAIRS, side = null, tagLean = null, labelHints = null, note = '' } = {}) {
  if (!Array.isArray(roster) || roster.length === 0) {
    return { assignee: UNSURE, person: null, personLabels: [], noTag: false, unsure: true, side: side || 'unknown', confidence: 0, reason: 'roster is empty' };
  }
  const pairList = Array.isArray(pairs) ? pairs : [];
  const h = message.headers || {};
  const userText = buildInput({ subject: h.subject, from: h.from, bodyText: message.bodyText, newestText: message.newestText, sideHint: side, tagLean, labelHints, attachments: message.attachments });
  const out = await callClassifier(
    buildSystem(roster, cfg.ROUTING_NOTES, cfg.NO_TAG_RULES, pairList),
    buildTool(roster, pairList),
    userText,
    note || `msg ${message.id || '?'}`,
  );

  const assignee = out.assignee || UNSURE;
  const { name, labels } = resolveLabels(assignee, roster, pairList);
  return {
    assignee,
    person: name,
    personLabels: labels,
    noTag: assignee === NO_TAG,
    unsure: assignee === UNSURE,
    side: out.side || side || 'unknown',
    confidence: Number(out.confidence) || 0,
    reason: out.reason || '',
  };
}

module.exports = { classify, NO_TAG, UNSURE, _internal: { buildSystem, buildTool, buildInput, resolveLabels } };
