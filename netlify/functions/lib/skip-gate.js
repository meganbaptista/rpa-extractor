// netlify/functions/lib/skip-gate.js
//
// ============================================================================
// THE canonical skip gate (Email Router — see EMAIL-ROUTER-SPEC.md).
// ============================================================================
// ONE shared module. BOTH branches (A = message already has a category label,
// B = no category label) call runSkipGate() first — it is never a pure lookup.
// The Zapier routing lane historically ran an older 9-rule variant that drifted
// from this master (missing rules 10–14 + the newest-vs-thread-history scoping);
// that drift is a bug we are fixing by making this the single source of truth.
//
// The 14 rules below are the OWNER'S MASTER, verbatim. Do not silently edit a
// rule — if the policy changes, change it HERE and both branches inherit it.
//
// Output: the gate returns structured data via a forced tool call, so it is
// never text we have to hand-parse. We extended the owner's original
// {skip_assignment, reason, confidence} contract with ONE field:
//   deciding_rule — the rule number (1–14) that most directly drove the outcome.
// That is what lets the shadow-mode comparison log attribute each disagreement
// to the rule responsible (esp. rules 10–14 / quoted-history scoping, where
// Branch A is EXPECTED to differ from the old Zaps). Nothing else changed.
// ============================================================================

const usageLog = require('./usage-log');
const { GATE } = require('./routing-config');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// --- The master rules, verbatim (owner-provided). Rendered into the system prompt.
const RULES = `You are checking whether a new real estate transaction email should be skipped as a no-action acknowledgment.

Your only job is to decide whether the email should be skipped and marked as "read" and assigned "no-label"

IMPORTANT: Email clients include quoted previous messages in the email body, indicated by lines beginning with "On [date]" followed by a sender name and "wrote:". Everything after this quoted reply marker is a PREVIOUS email and must be completely ignored when making your classification decision. Only evaluate the text that appears BEFORE the first "On [date]...wrote:" marker.

Rules:

1. If the newest email message is only an acknowledgment or courtesy reply such as:
- received
- Received, thank you
- thank you
- thanks
- got it
- noted
- perfect
- sounds good
- Signed and thank you for sending!
- Signed!
- This is completed, thank you

AND there is no new task, no question, no request, and NO attachment, then return skip_assignment = true.

2. Do not pay attention to attachments in PREVIOUS emails within the thread. However, if the CURRENT newest email has attachments, return skip_assignment = false regardless of how brief or casual the message text appears. Attachments on the current email always require attention.

3. If there is any new request, instruction, draft, form, revision, or transaction content, return skip_assignment = false.

4. If the sender mentions that they sent it in a separate email or thread or chain, return skip_assignment = false.

5. If the CURRENT NEWEST EMAIL mentions "we are now closed" or "we are recorded" or something that escrow is closed, return skip_assignment = false. Do not trigger this rule based on closing language found only in previous emails.

6. If unsure, return skip_assignment = false.

7. If the CURRENT NEWEST EMAIL confirms receipt of something that requires a task to be checked off or logged — such as wire transfer received, EMD received, deposit received, funds received, documents recorded, loan documents received, or signing confirmed — return skip_assignment = false. These are milestone confirmations that require action on our end. Do NOT trigger this rule based on milestone language found only in previous emails in the thread — only apply it if the milestone confirmation is in the newest message itself.

8. If the email contains an approval, decision, or confirmation of a request that was made — such as "approved", "approved thank you", "confirmed", "you're good to go", "green light", "permission granted", or any similar language indicating a decision has been made in response to a prior ask — return skip_assignment = false. These require the team to act on the approval.

9. If the newest email is a thank you or courtesy reply directly responding to an outbound update or notification sent by Megan or My TC Concierge — such as a transaction update, task completion notice, or escrow introduction — and contains no new question, request, or information, return skip_assignment = true. The original update was outbound and the reply requires no action.

10. If the previous message in the thread was sent by Megan or My TC Concierge and contained a direct question (such as "Is the VP approved?", "Can you confirm?", "Has this been done?", "Is this ready?"), and the current email is a direct answer to that question — even if brief such as "Yes", "Hi Yes", "Yes thank you", "Yep", "Sure", "No" — return skip_assignment = false. A direct answer to a direct question always requires action regardless of how casually it is worded.

11. If the thread content contains a link (such as a Dropbox, Google Drive, WeTransfer, or any URL) to documents, reports, or files that were shared — such as inspection reports, repair requests, disclosures, or any transaction documents — return skip_assignment = false. Even if the newest message is a simple acknowledgment, the linked documents require review and action by the team.

12. If the email introduces or copies Megan or her TC team into an email chain for the first time — such as "copying my TC", "looping in my TC", "adding Megan", "keeping her looped in" — return skip_assignment = false. Being introduced to a thread always requires attention as it signals a new transaction or new responsibility regardless of how casual the introduction message appears.

13. If the thread subject contains "DocuSign Package" and the newest email is a simple acknowledgment confirming they received or will complete the DocuSign — such as "will do", "will do so now", "got them", "ok got it", "on it", "will sign now", "thank you" — return skip_assignment = true. These are courtesy confirmations that the recipient received Megan's outbound DocuSign request and no further action is needed until the signed documents are returned via DocuSign notification.

14. If the newest email is a simple thank you or courtesy reply from a third party responding to another third party (not to Megan or My TC Concierge directly), and Megan is only CC'd on the thread, return skip_assignment = true. If the conversation is between other parties and requires no direct action from Megan's team, it can be skipped.`;

// The forced-output tool. Same fields the owner's master returns, plus deciding_rule.
const DECISION_TOOL = {
  name: 'report_decision',
  description: 'Report the skip decision for this email.',
  input_schema: {
    type: 'object',
    properties: {
      skip_assignment: {
        type: 'boolean',
        description: 'true = skip (mark read, no label); false = requires attention/routing.',
      },
      deciding_rule: {
        type: 'integer',
        minimum: 1,
        maximum: 14,
        description: 'The rule number (1–14) that MOST directly drove this decision. '
          + 'If several apply, pick the single most decisive one. If nothing specific '
          + 'matched and you defaulted, use 6 (the "if unsure" default) for skip=false, '
          + 'or 1 for a plain non-actionable acknowledgment skip=true.',
      },
      reason: { type: 'string', description: 'Short explanation.' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['skip_assignment', 'deciding_rule', 'reason', 'confidence'],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build the user-content block: the same signals the Zap fed the gate (subject,
// sender, full body incl. quoted history so rules 10–14 have thread context),
// plus a HARD current-attachment flag the model can't reliably infer from text
// (rule 2). We label the newest message explicitly to reinforce the scoping
// instruction, but still include the full body so history-dependent rules work.
function buildInput({ subject, from, bodyText, newestText, hasAttachment }) {
  return [
    `THREAD SUBJECT: ${subject || '(none)'}`,
    `SENDER: ${from || '(unknown)'}`,
    `CURRENT EMAIL HAS ATTACHMENT: ${hasAttachment ? 'YES' : 'NO'}`,
    '',
    'NEWEST MESSAGE (evaluate this for the skip decision):',
    (newestText || bodyText || '').trim() || '(empty)',
    '',
    'FULL THREAD BODY (newest message followed by quoted history — use only where a rule references prior messages/thread context):',
    (bodyText || '').trim() || '(empty)',
  ].join('\n');
}

async function callGate(userText, note = '', attempt = 0) {
  const MAX_RETRIES = 4;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var not set');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: GATE.model,
      max_tokens: 1024,
      system: RULES,
      tools: [DECISION_TOOL],
      tool_choice: { type: 'tool', name: DECISION_TOOL.name },
      messages: [{ role: 'user', content: userText }],
    }),
  });

  if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter ? Math.min(parseFloat(retryAfter) * 1000, 30000) : Math.min(1000 * Math.pow(2, attempt), 30000);
    console.log(`[skip-gate] ${response.status}, retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
    return callGate(userText, note, attempt + 1);
  }
  if (!response.ok) throw new Error(`skip-gate API error ${response.status}: ${await response.text()}`);

  const data = await response.json();
  await usageLog.logUsage({ fn: 'skip-gate', model: GATE.model, effort: GATE.effort, usage: data.usage, note });

  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === DECISION_TOOL.name);
  if (!toolUse) throw new Error('skip-gate returned no tool_use block');
  return toolUse.input;
}

// Public: run the gate on ONE message. `message` is the shape lib/gmail.js
// getMessage() returns (we read headers.subject, headers.from, bodyText,
// newestText, hasAttachment). Returns a normalized decision:
//   { skip: bool, deciding_rule: int, reason: str, confidence: str }
// deciding_rule is what the shadow log records to attribute each disagreement.
async function runSkipGate(message, { note = '' } = {}) {
  const h = message.headers || {};
  const userText = buildInput({
    subject: h.subject,
    from: h.from,
    bodyText: message.bodyText,
    newestText: message.newestText,
    hasAttachment: !!message.hasAttachment,
  });
  const out = await callGate(userText, note || `msg ${message.id || '?'}`);
  return {
    skip: out.skip_assignment === true,
    deciding_rule: out.deciding_rule || null,
    reason: out.reason || '',
    confidence: out.confidence || 'low',
  };
}

module.exports = { runSkipGate, RULES, DECISION_TOOL, _internal: { buildInput } };
