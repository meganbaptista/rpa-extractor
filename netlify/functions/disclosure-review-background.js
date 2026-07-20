// netlify/functions/disclosure-review-background.js
//
// ============================================================================
// KEEVA — Seller Disclosure Review (listing side)
// ============================================================================
// Runs when a seller finishes their disclosures in Process Street. Reads the
// seller's answers + "Please explain here" fields, has Opus 4.8 judge each
// explanation for MATERIALITY, and produces a ready-to-send clarification email
// (material items only) plus the full tiered findings. A second Zapier catch
// hook turns the result into a Gmail DRAFT (never auto-sent) and a Process
// Street comment, so a draft is waiting when Megan sits down.
//
// Design mirrors audit-background.js on purpose:
//   - Netlify BACKGROUND function (sync functions time out at ~10s; Opus is
//     slower), so we accept the request, run the review, and POST the result to
//     a Zapier catch hook rather than returning it inline.
//   - Failure-isolated: any error is logged; we still try to surface it.
//
// ----------------------------------------------------------------------------
// FLOW
//   Zap A (trigger: PS task checked) → POST here:
//     { checklistRunId, callbackUrl?, propertyAddress?, sellerEmail?, formFields? }
//   This function:
//     1. Gets the seller's answers — from body.formFields if Zapier passed them,
//        else fetched from the Process Street API by checklistRunId.
//     2. Filters to the disclosure Q&A (drops addresses, agent emails, etc.).
//     3. Opus 4.8 materiality review → { material[], minor[], internal[],
//        email_subject, email_body, overall_status }.
//     4. POSTs that to the Zapier callback (Zap B), which creates the Gmail
//        draft + the PS comment.
//
// NON-BLOCKING by design: this never holds up the disclosures going to the
// seller. It is a heads-up that produces a draft for Megan to review and send.
// ============================================================================

console.log('[disclosure-review] module loading');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const usageLog = require('./lib/usage-log');

// Opus 4.8 — materiality is liability-sensitive judgment; use the top tier
// (same quality bar as the signature audit). Adaptive thinking is configured in
// callClaude.
const MODEL = 'claude-opus-4-8';

// Process Street public API. Base path is /power-automate/v1.1 (NOT /api/v1.1 —
// that path 404s). Auth is the X-API-KEY header. PS_API_KEY is a site env var.
const PS_API_BASE = 'https://public-api.process.st/power-automate/v1.1';

// Where the finished review is delivered. This is the 2nd Zapier catch hook
// (Zap B) that creates the Gmail draft + PS comment. Set as a site env var so it
// can be rotated without a redeploy; a per-request `callbackUrl` in the POST
// body overrides it.
const CALLBACK_URL_ENV = process.env.DISCLOSURE_REVIEW_CALLBACK_URL || '';

console.log('[disclosure-review] module fully loaded, handler ready');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ----------------------------------------------------------------------------
// Field labels we never send to the model — identity/admin/contact fields that
// are not seller disclosures. Matched case-insensitively as substrings.
// ----------------------------------------------------------------------------
const NON_DISCLOSURE_LABEL_HINTS = [
  'property address', 'address', 'city', 'county', 'zip', 'apn',
  'email', 'agent', 'brokerage', 'assistant', 'docusign', 'seller 1 name',
  'seller name', 'date prepared', 'signature', 'initials', 'sqft', 'square',
];

// Process Street trigger tokens append a trailing "-<timestamp>" revision suffix
// to the IDs (e.g. "v1QEev6Pi8MoNwcBTFxKFg-1777325806506"). The public API wants
// the bare id, and rejects the suffixed form with "Invalid value for: path
// parameter workflowRunId". Strip a trailing dash + long run of digits. Real PS
// ids can contain dashes (e.g. "...VM-Q"), but never a trailing 10+ digit block.
function bareId(id) {
  return String(id || '').trim().replace(/-\d{10,}$/, '');
}

function isDisclosureField(label) {
  const l = String(label || '').toLowerCase();
  if (!l) return false;
  return !NON_DISCLOSURE_LABEL_HINTS.some((h) => l.includes(h));
}

// ----------------------------------------------------------------------------
// Pull the seller name(s) out of the FULL (pre-filter) field set so the email
// can be addressed to the actual sellers. Without this the model never sees a
// seller name (those fields are dropped by NON_DISCLOSURE_LABEL_HINTS) and
// invents a greeting from whatever leaks through — the agent, the brokerage
// team, or just seller 1. Match labels that look like a seller name field
// ("Seller 1 Name", "Seller Name(s)", "Name of Seller"), ordered by seller
// number, and hand the raw values to the model so it can greet by first name.
// Entity/trust names (which contain commas) are passed through intact; the
// model decides how to address them.
// ----------------------------------------------------------------------------
function extractSellerNames(fields) {
  const ranked = [];
  const seen = new Set();
  for (const f of fields || []) {
    const l = String(f.label || '').toLowerCase();
    if (!l.includes('seller') || !l.includes('name')) continue;
    if (/agent|broker|assistant|email|docusign|signature|initial/.test(l)) continue;
    const v = String(f.value || '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const m = l.match(/seller\s*#?\s*(\d+)/);
    ranked.push({ order: m ? parseInt(m[1], 10) : 50, v });
  }
  ranked.sort((a, b) => a.order - b.order);
  return ranked.map((r) => r.v);
}

// ----------------------------------------------------------------------------
// Normalize one raw Process Street form-field-value item to { label, value }.
// Defensive on shape because the exact property names should be confirmed
// against the live API (see the README note delivered with this file): we try
// the common variants for both the field's label and its value.
// ----------------------------------------------------------------------------
// Process Street SimplifiedFormFieldValue puts the value inside a `data` object
// whose shape varies by field type. Pull a readable string out of it defensively.
function valueFromData(d) {
  if (d == null) return '';
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map(valueFromData).filter(Boolean).join(', ');
  if (typeof d === 'object') {
    if (typeof d.value === 'string') return d.value;
    if (typeof d.content === 'string') return d.content;
    if (typeof d.plainText === 'string') return d.plainText;
    if (typeof d.text === 'string') return d.text;
    if (d.label) return String(d.label);
    if (Array.isArray(d.items)) return d.items.map((i) => i.label || i.value || '').filter(Boolean).join(', ');
    if (Array.isArray(d.selectedItems)) return d.selectedItems.map((i) => i.label || i.value || '').filter(Boolean).join(', ');
    if (d.selectedItem) return d.selectedItem.label || d.selectedItem.value || '';
    if (d.value && typeof d.value === 'object') return valueFromData(d.value);
    return '';
  }
  return String(d);
}

function normalizeField(item) {
  if (!item || typeof item !== 'object') return null;
  // PS item: { label, key, data, ... } (value in `data`). Also tolerate a simple
  // { label, value } shape for fields passed straight into the webhook body.
  const label =
    item.label || item.key ||
    (item.formField && (item.formField.label || item.formField.name)) ||
    item.name || '';
  let value = valueFromData(item.data);
  if (!value) {
    const raw = item.value != null ? item.value : (item.formFieldValue != null ? item.formFieldValue : item.answer);
    value = valueFromData(raw);
  }
  return { label: String(label).trim(), value: String(value).trim() };
}

// ----------------------------------------------------------------------------
// Fetch all form-field values for a Process Street checklist (workflow) run.
// Follows paging via links.next until exhausted. Returns [{ label, value }].
//
// Authenticated GET against the PS public API (X-API-KEY).
async function psGet(url, apiKey) {
  const res = await fetch(url, { method: 'GET', headers: { 'X-API-KEY': apiKey, 'Accept': 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Process Street API ${res.status} (${url}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Form field VALUES for a run. The response is a FLAT map { fieldId: value } —
// answers keyed by opaque field id, with NO question text. (Verified from the
// live response.) GET /workflow-runs/{runId}/form-fields?workflowId=...
async function fetchRunValues(workflowId, runId, apiKey) {
  const url = `${PS_API_BASE}/workflow-runs/${encodeURIComponent(runId)}/form-fields?workflowId=${encodeURIComponent(workflowId)}`;
  const data = await psGet(url, apiKey);
  const map = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  console.log(`[disclosure-review] PS values: ${Object.keys(map).length} field ids`);
  return map;
}

// Field LABELS for a workflow. The values endpoint only gives field ids; the
// dynamic schema maps each id to its human question text (`title`). One call per
// workflow (not per run). GET /dynamic-schemas/workflows/{workflowId}/form-fields
//   -> { Schema: { properties: { <fieldId>: { title: "C12: Please explain..." } } } }
async function fetchFieldLabels(workflowId, apiKey) {
  const url = `${PS_API_BASE}/dynamic-schemas/workflows/${encodeURIComponent(workflowId)}/form-fields`;
  const data = await psGet(url, apiKey);
  console.log('[disclosure-review] PS schema raw:', JSON.stringify(data).slice(0, 1000));
  const schema = (data && (data.Schema || data.schema)) || data || {};
  const props = (schema && schema.properties) || {};
  const labels = {};
  for (const [id, def] of Object.entries(props)) {
    if (def && typeof def === 'object') {
      labels[id] = def.title || def['x-ms-summary'] || def.description || id;
    }
  }
  console.log(`[disclosure-review] PS labels: ${Object.keys(labels).length} fields`);
  return labels;
}

// Join the value map and the label map into [{ label, value }], dropping blanks.
function joinFields(values, labels) {
  const out = [];
  for (const [id, raw] of Object.entries(values || {})) {
    const value = valueFromData(raw);
    if (!value) continue;
    out.push({ label: labels[id] || id, value });
  }
  return out;
}

// ----------------------------------------------------------------------------
// DETERMINISTIC CROSS-CHECKS — hard consistency rules between a property-info
// field and a seller answer that must fire EVERY time (not left to the model's
// materiality judgment). Currently one: "High Fire Hazard Area?" (a Property
// Information dropdown the team fills to draft blank disclosures) vs SPQ 17G
// (annual brush clearance). If the property IS in a high fire hazard area but
// the seller answered 17G "No", we nudge them to revise it to "Yes".
// ----------------------------------------------------------------------------
function normYesNo(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (/^y(es)?\b/.test(s)) return 'yes';
  if (/^n(o)?\b/.test(s)) return 'no';
  return '';
}

// First field whose label passes `matchLabel`, or null. Runs over the FULL
// (pre-disclosure-filter) field set so property-info fields are visible.
function findField(fields, matchLabel) {
  for (const f of fields || []) {
    if (f && matchLabel(String(f.label || ''))) return f;
  }
  return null;
}

// The Property Information "High Fire Hazard Area?" dropdown (Yes/No).
function fireHazardField(fields) {
  return findField(fields, (l) => /high fire hazard/i.test(l));
}

// The seller's 17G ANSWER dropdown — NOT the "17G: Please explain here:" text
// field. The label starts with "17G" and is not the explain field.
function item17gAnswerField(fields) {
  return findField(fields, (l) => /^17\s*g\b/i.test(l.trim()) && !/explain/i.test(l));
}

// If the property is high fire hazard but 17G was answered "No", return a
// mandated material finding (with Megan's exact wording); else null.
function fireBrushMandate(fields) {
  const fire = normYesNo((fireHazardField(fields) || {}).value);
  const g17 = normYesNo((item17gAnswerField(fields) || {}).value);
  console.log(`[disclosure-review] cross-check: fire-hazard=${fire || '(n/a)'} 17G=${g17 || '(n/a)'}`);
  if (fire === 'yes' && g17 === 'no') {
    return {
      topic: 'Fire hazard and brush clearance',
      section: 'SPQ 17G',
      emailHeading: 'Fire hazard and brush clearance (SPQ 17G)',
      seller_wrote: 'No',
      why: 'The property is in a High Fire Hazard area, which typically carries annual brush clearance requirements, so a "No" here reads as inconsistent and a buyer would question it.',
      ask: 'I noticed that you answered "No" to the property having annual brush clearance requirements. I show that the property is in a High Fire hazard zone, so typically this would require annual brush clearance. Do you want to revise this to be a Yes response?',
      keyword: /brush clearance|high fire hazard/i,
    };
  }
  return null;
}

// True if the model already worked a mandate into its material findings, so we
// don't force a duplicate. Matches on the locator code or the mandate keyword.
function materialHasMandate(material, m) {
  return (material || []).some((x) =>
    /17\s*g/i.test(String(x.section || '')) ||
    m.keyword.test(`${x.topic || ''} ${x.ask || ''} ${x.why || ''}`));
}

// Insert a topic block just before the closing "Thanks!" line, so a mandate the
// model omitted still lands in the email in the right place (above the sign-off).
function insertBeforeSignoff(body, block) {
  const b = String(body || '');
  const idx = b.lastIndexOf('Thanks!');
  if (idx < 0) return `${b.trimEnd()}\n\n${block}\n\nThanks!`;
  const before = b.slice(0, idx).trimEnd();
  const after = b.slice(idx);
  return `${before}\n\n${block}\n\n${after}`;
}

// ----------------------------------------------------------------------------
// THE PROMPT — materiality-tiered review of the seller's disclosure answers.
// Input is the seller's Q&A (question label + answer/explanation), already
// filtered to disclosure fields. The model pairs each question with its "Please
// explain here" answer itself (it is good at this) and tiers each finding.
// ----------------------------------------------------------------------------
function buildReviewPrompt(fields, ctx) {
  const qa = fields
    .map((f) => `- ${f.label}: ${f.value || '(blank)'}`)
    .join('\n');

  const where = ctx.propertyAddress ? ` for ${ctx.propertyAddress}` : '';

  const sellers = Array.isArray(ctx.sellerNames) ? ctx.sellerNames.filter(Boolean) : [];
  const sellerBlock = sellers.length
    ? `SELLERS (the people this email is addressed to — use these and ONLY these for the greeting):\n${sellers.map((n) => `- ${n}`).join('\n')}`
    : `SELLERS: the seller name was not available — open the email with exactly "Hi there,".`;

  const mandates = Array.isArray(ctx.mandates) ? ctx.mandates.filter(Boolean) : [];
  const mandateBlock = mandates.length
    ? `\nMANDATORY ITEMS (flagged by a deterministic consistency rule — you MUST include EACH as a "material" finding AND as its own topic in the seller email, using the provided question text closely; do NOT down-tier, reword away, or omit them):\n${mandates.map((m) => `- Topic "${m.topic}" (locator ${m.section}); the seller answered "${m.seller_wrote}". Group it in the email under a "${m.emailHeading}:" heading and include this question: ${m.ask}`).join('\n')}\n`
    : '';

  return `You are an expert California real estate transaction coordinator on the LISTING side, reviewing a seller's completed disclosure answers${where} BEFORE they are finalized for signature. Forms involved are the seller-narrative disclosures (TDS, SPQ and its addendum, ESD, CSPQ, VLQ) — the parts where the seller writes explanations.

Your ONE job: read the seller's answers below and flag explanations that a buyer's side will question, so the listing team can ask the seller to clarify BEFORE the disclosures go out. You are NOT giving legal advice, NOT changing the seller's disclosures, and NOT auditing signatures. You surface clarifying questions only.

Pair each "Yes" disclosure with its matching "Please explain here" answer (they share a code like C12, or a section like 7A). Judge each explanation for: vagueness (no where/when/extent), missing resolution (issue noted but not whether fixed/permitted), missing permits on improvements, missing dates, internal inconsistency across answers, and material facts that read as incomplete (water/drainage, soil/slope, active pest treatment, deaths, litigation, unpermitted work, neighbor disputes).

LOCATOR: for EVERY finding, capture where it lives so the seller and the team can jump straight to it. The question labels carry a CODE but usually NOT the form name (e.g. the label reads "C8: Are you aware of any flooding, drainage, or grading problems?"). Derive the form from the code using this scheme, and do NOT guess the form just because a code's letter happens to resemble a form's initials:
- A code that is a LETTER followed by a number (C8, C12, A3, B2, ...) is a Transfer Disclosure Statement item (TDS Section II, the "Are you (Seller) aware of..." checklist). Write it as "TDS C8".
- A code that STARTS WITH A NUMBER, usually with a trailing letter (10A, 18E, 7A, ...), is a Seller Property Questionnaire item. Write it as "SPQ 18E".
- If the label itself names a form (TDS, SPQ, ESD, CSPQ, VLQ), use that name exactly as written. If a code fits neither pattern and the label names no form, give the bare code and do NOT invent a form.
Always pair the form with the code, e.g. "TDS C8" or "SPQ 18E". This matters MOST for "material" findings, because those are the ones that go to the seller — every material finding MUST carry a locator. If a material finding draws on more than one answer, list each locator (e.g. "TDS C8, C9" or "SPQ 18E; TDS C7"). Only use an empty string when the underlying question genuinely has no code in its label.

Tier EVERY finding into exactly one of:
- "material": a vague or incomplete answer that carries real liability, renegotiation, or buyer-cancellation risk if it goes out as-is (e.g. water intrusion / drainage / a spring, active termite or pest treatment, unpermitted structural work, unresolved damage). These are worth clarifying with the seller before finalizing.
- "minor": worth a note but fine to let ride, or pure logistics the buyer handles anyway (e.g. confirming which HOA so docs can be ordered, optional date on a cosmetic item, an already-resolved item the seller disclosed).
- "internal": for the listing TEAM only, never the seller — typos, formatting, an answer that is clear but the team may want to tidy.

Be calibrated: most answers are fine. Only call something "material" if a careful buyer's agent would genuinely push on it. It is normal for a packet to have just one to three material items, sometimes zero.

Then write a short, friendly clarification email to the seller that includes ONLY the material items, phrased as easy questions grouped by topic. Plain and warm.
GREETING: open with a greeting on its own line addressed to the sellers by FIRST name only, e.g. "Hi Chase and Kelly,". Use only the first names of the people listed under SELLERS below (join two with "and", three or more with commas and a final "and"). If a seller is a trust, estate, or other entity, use its short name or just "Hi there,". NEVER address the email to an agent, a team, the brokerage, or a property address.
SECTION REFERENCES: for each topic in the email, put its locator in parentheses right after the topic heading, e.g. "Drainage (TDS C8):", so the seller and the listing team can find the exact question. Use the same form-from-code mapping described under LOCATOR. If a finding has no locator, omit the parentheses for that one.
LINE BREAKS: do NOT hard-wrap text. Write each paragraph (the greeting, the intro, each topic's question, the closing) as ONE continuous line with no line breaks inside it — let the email client wrap it. Use a single newline only between a topic heading and its question, and a blank line (two newlines) only to separate blocks. Never break a sentence across lines.
CRITICAL STYLE RULE: do NOT use em dashes (the "—" character) anywhere in the email or your output; use periods, commas, or parentheses instead. SIGN-OFF: close the email with exactly "Thanks!" on its own line and nothing after it. Do NOT use "Warm regards", "Best", a team name, or any signature block.

${sellerBlock}
${mandateBlock}
SELLER'S DISCLOSURE ANSWERS:
${qa}

Respond with ONLY a single JSON object (no markdown fences, no prose before or after) of this shape:
{
  "overall_status": "clarifications_recommended" | "looks_complete",
  "material": [ { "topic": "short label", "section": "form + question locator, e.g. 'TDS C8' or 'SPQ 18E' (empty string if none)", "seller_wrote": "the seller's words", "why": "one sentence on the risk", "ask": "the clarifying question to the seller" } ],
  "minor": [ { "topic": "...", "section": "locator or empty string", "note": "one sentence" } ],
  "internal": [ { "topic": "...", "section": "locator or empty string", "note": "one sentence for the team" } ],
  "email_subject": "subject line, no em dashes",
  "email_body": "the full seller email. Greeting addressed to the sellers by first name, material items only, each topic heading followed by its (locator), no em dashes. If there are no material items, a one-line note that everything looked complete."
}`;
}

// ----------------------------------------------------------------------------
// Opus 4.8 call. Adaptive thinking (the only thinking mode on 4.8); effort high.
// Retries on 429/529. Returns the text of the response (expected: one JSON obj).
// ----------------------------------------------------------------------------
async function callClaude(prompt, attempt = 0) {
  const MAX_RETRIES = 4;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var not set');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 48000,
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    }),
  });

  if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter
      ? Math.min(parseFloat(retryAfter) * 1000, 30000)
      : Math.min(1000 * Math.pow(2, attempt), 30000);
    console.log(`[disclosure-review] ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
    return callClaude(prompt, attempt + 1);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  await usageLog.logUsage({ fn: 'disclosure-review', model: MODEL, effort: 'high', usage: data.usage });
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Disclosure review hit max_tokens — output truncated. Raise max_tokens and re-run.');
  }
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// Parse the model's JSON (tolerate stray prose / code fences).
function parseReview(raw) {
  let t = (raw || '').trim().replace(/```json|```/g, '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : t);
}

// Render a findings list as plain bullets for the Process Street comment.
function bullets(list, fmt) {
  if (!Array.isArray(list) || !list.length) return '';
  return list.map((x) => `• ${fmt(x)}`).join('\n');
}

// ----------------------------------------------------------------------------
// HTML email rendering. The model writes a PLAIN-TEXT body that ends at
// "Thanks!" with no signature (see the prompt). We convert it to an HTML body
// so the Gmail draft created downstream can be an HTML draft (Body Type = HTML,
// mapped to `email_body_html`). This keeps real line breaks and a real
// apostrophe (a prior plain-text draft mangled both). The SIGNATURE is added
// downstream (Gmail/Zapier), NOT here, so we do not append one.
// NOTE: escape only & < > — NOT apostrophes/quotes; encoding those is exactly
// what produced "California&#39;s".
// ----------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Turn the model's plain-text body into HTML: blank lines (\n\n) become
// paragraph breaks; single newlines become <br>. No signature appended.
// A block whose first line is a topic heading (ends in ":" and is followed by
// more lines, e.g. "Roof:" / "Remodeling and permits (SPQ 7A; TDS C4):") gets
// that heading bolded. The greeting and closing have no following lines, so
// they stay unbolded.
function renderEmailHtml(bodyText) {
  const body = String(bodyText || '').trim();
  const blocks = body
    ? body
        .split(/\n{2,}/)
        .map((block) => {
          const lines = block.split('\n').map((line) => escapeHtml(line));
          if (lines.length > 1 && /:\s*$/.test(lines[0])) {
            lines[0] = `<strong>${lines[0]}</strong>`;
          }
          return `<p style="margin:0 0 1em 0">${lines.join('<br>')}</p>`;
        })
        .join('\n')
    : '';
  // 13px Arial == Gmail's "Normal" size, so the body matches a hand-typed
  // Gmail message. (11pt was rendering noticeably larger than Gmail default.)
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#000">\n${blocks}\n</div>`;
}

// ----------------------------------------------------------------------------
// Deliver the finished review to the Zapier callback (Zap B), which creates the
// Gmail draft + PS comment. Failure-isolated.
// ----------------------------------------------------------------------------
async function sendToCallback(callbackUrl, payload) {
  if (!callbackUrl) {
    console.warn('[disclosure-review] no callback URL configured — result not delivered');
    return;
  }
  try {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.log(`[disclosure-review] callback dispatched (status ${res.status})`);
  } catch (err) {
    console.error(`[disclosure-review] callback failed (non-fatal): ${err.message}`);
  }
}

exports.handler = async function (event) {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    console.error('[disclosure-review] invalid JSON body');
    return { statusCode: 400 };
  }

  const {
    workflowId,
    workflowRunId,
    checklistRunId, // alias for workflowRunId (older Zap config)
    callbackUrl,
    propertyAddress = '',
    sellerEmail = '',
    formFields, // optional: if Zapier passes the fields directly, we skip the PS fetch
  } = body;

  const runId = bareId(workflowRunId || checklistRunId);
  const wfId = bareId(workflowId);
  const callback = callbackUrl || CALLBACK_URL_ENV;

  try {
    // 1) Get the seller's answers — from the body if provided, else PS API.
    let fields = [];
    if (Array.isArray(formFields) && formFields.length) {
      fields = formFields.map(normalizeField).filter((f) => f && f.label);
      console.log(`[disclosure-review] using ${fields.length} fields passed in body`);
    } else if (runId) {
      const psKey = process.env.PS_API_KEY;
      if (!psKey) throw new Error('PS_API_KEY env var not set (needed to fetch form fields)');
      if (!wfId) throw new Error('workflowId is required alongside the run id to fetch PS form fields');
      const [values, labels] = await Promise.all([
        fetchRunValues(wfId, runId, psKey),
        fetchFieldLabels(wfId, psKey),
      ]);
      fields = joinFields(values, labels);
      console.log(`[disclosure-review] joined ${fields.length} answered fields from PS workflow ${wfId} run ${runId}`);
    } else {
      throw new Error('Request had neither formFields nor a workflowRunId');
    }

    // Grab the seller name(s) from the FULL field set before we filter them
    // out, so the email is addressed to the actual sellers (not the agent/team).
    const sellerNames = extractSellerNames(fields);
    console.log(`[disclosure-review] seller names for greeting: ${sellerNames.length ? sellerNames.join(', ') : '(none found)'}`);

    // Deterministic cross-checks run on the FULL field set: property-info fields
    // like "High Fire Hazard Area?" get dropped by the disclosure filter, so read
    // them before filtering. A mandate only exists when an inconsistency is real.
    const mandates = [fireBrushMandate(fields)].filter(Boolean);
    if (mandates.length) console.log(`[disclosure-review] ${mandates.length} deterministic mandate(s) forced into the review`);

    const disclosureFields = fields.filter((f) => isDisclosureField(f.label));
    if (!disclosureFields.length) {
      throw new Error('No disclosure fields found after filtering — check the field labels / PS response shape');
    }

    // 2) Materiality review.
    const prompt = buildReviewPrompt(disclosureFields, { propertyAddress, sellerNames, mandates });
    const raw = await callClaude(prompt);
    const review = parseReview(raw);

    // 3) Shape the delivery payload for Zap B (Gmail draft + PS comment).
    const material = Array.isArray(review.material) ? review.material : [];
    const minor = Array.isArray(review.minor) ? review.minor : [];
    const internal = Array.isArray(review.internal) ? review.internal : [];

    // Guarantee each deterministic mandate survives the model's tiering: force it
    // into material if the model dropped or down-tiered it (dedup so we never
    // double it), and into the email body (before the sign-off) if it's missing.
    let emailBody = review.email_body || '';
    for (const m of mandates) {
      if (!materialHasMandate(material, m)) {
        material.unshift({ topic: m.topic, section: m.section, seller_wrote: m.seller_wrote, why: m.why, ask: m.ask });
      }
      if (!m.keyword.test(emailBody)) {
        emailBody = insertBeforeSignoff(emailBody, `${m.emailHeading}:\n${m.ask}`);
      }
    }
    // A detected inconsistency always means clarifications are recommended.
    const overallStatus = mandates.length ? 'clarifications_recommended' : (review.overall_status || 'reviewed');

    const psComment =
      `Disclosure review${propertyAddress ? ` — ${propertyAddress}` : ''}\n` +
      `Status: ${overallStatus} | Material: ${material.length}, Minor: ${minor.length}, Internal: ${internal.length}\n\n` +
      (material.length ? `MATERIAL (worth clarifying before it goes out):\n${bullets(material, (x) => `${x.topic}${x.section ? ` (${x.section})` : ''}: ${x.why} (ask: ${x.ask})`)}\n\n` : 'No material items.\n\n') +
      (minor.length ? `MINOR (optional):\n${bullets(minor, (x) => `${x.topic}${x.section ? ` (${x.section})` : ''}: ${x.note}`)}\n\n` : '') +
      (internal.length ? `INTERNAL (team only):\n${bullets(internal, (x) => `${x.topic}${x.section ? ` (${x.section})` : ''}: ${x.note}`)}\n` : '');

    const payload = {
      checklistRunId: runId || '',
      property_address: propertyAddress,
      seller_email: sellerEmail,
      overall_status: overallStatus,
      material_count: material.length,
      email_subject: review.email_subject || `Quick clarifications on your disclosures${propertyAddress ? ` for ${propertyAddress}` : ''}`,
      email_body: emailBody,
      email_body_html: renderEmailHtml(emailBody),
      ps_comment: psComment,
      findings: { material, minor, internal },
    };

    console.log(`[disclosure-review] complete — material=${material.length} minor=${minor.length} internal=${internal.length}`);
    await sendToCallback(callback, payload);
    return { statusCode: 200 };
  } catch (err) {
    console.error('[disclosure-review] ERROR:', err.message);
    // Surface the failure to the callback so a run never silently disappears.
    await sendToCallback(callback, {
      checklistRunId: runId || '',
      property_address: propertyAddress,
      seller_email: sellerEmail,
      overall_status: 'error',
      material_count: 0,
      email_subject: '',
      email_body: '',
      email_body_html: '',
      ps_comment: `Disclosure review could not complete: ${err.message}`,
      findings: { material: [], minor: [], internal: [] },
    });
    return { statusCode: 500 };
  }
};

// Exposed for unit tests (not used by the handler).
module.exports._internal = {
  normYesNo,
  fireHazardField,
  item17gAnswerField,
  fireBrushMandate,
  materialHasMandate,
  insertBeforeSignoff,
  buildReviewPrompt,
};
