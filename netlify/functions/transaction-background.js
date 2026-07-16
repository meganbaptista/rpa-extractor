// netlify/functions/transaction-background.js
//
// ============================================================================
// KEEVA INTAKE — Call B: holistic transaction-state reasoning
// ============================================================================
// ONE Claude call over the WHOLE contract packet (RPA + counters + addenda).
// The model reads the entire document and reasons out the FINAL CONTRACTUAL
// STATE — the counter chain, the controlling document, reconciled terms,
// parties, and contingencies — and emits the `transaction_state` envelope.
//
// This is the sibling of audit-background.js. Call A (audit-background.js) runs
// the signature/initials audit; Call B (this file) runs transaction-state
// reasoning. They are independent calls over the same packet — the orchestrator
// fans both out in parallel and combines the results.
//
// The prompt below (buildTransactionPrompt) was validated native-chat-first on
// Opus 4.7 against the Tigertail packet before being wrapped here — the same
// discipline that proved out the Call A prompt. The plumbing (blobsConfig,
// callClaude, the marker-split parser) is a faithful copy of the proven
// audit-background.js pattern.
//
// Input contract (invocation body, from the orchestrator):
//   { jobId }
// Call B takes no party-count inputs — it reads the parties from the packet
// itself. The PDF is read from the audit-payloads blob store by jobId — the
// same store Call A reads; the orchestrator drops one packet, both calls read
// it.
//
// Output (written to transaction-results under jobId):
//   { status:'complete', result: { prose, transaction_state } }
// ============================================================================

console.log('[transaction-background] module loading (line 1)');

const { getStore } = require('@netlify/blobs');
console.log('[transaction-background] @netlify/blobs loaded');

// Per-call token ledger -> Google Sheet. Inert without USAGE_SHEET_ID, and every
// failure is swallowed inside logUsage, so it can never fail a run.
const usageLog = require('./lib/usage-log');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Opus 4.7 — matches the native-chat control the Call B prompt was validated
// against. Opus 4.7 uses adaptive thinking (configured in callClaude); manual
// extended thinking ({ type:'enabled', budget_tokens }) is NOT accepted on this
// model and would return a 400.
const MODEL = 'claude-opus-4-7';

console.log('[transaction-background] module fully loaded, handler ready');

function blobsConfig(name) {
  return {
    name,
    siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============================================================================
// THE PROMPT — the locked Call B transaction-state reasoning prompt.
//
// Design principle (same as Call A): REASONING FIRST, STRUCTURE SECOND. The
// model reasons through the counter chain and writes its analysis as prose
// (PART 1), THEN emits the structured transaction_state JSON (PART 2) derived
// from that reasoning. The ===TRANSACTION_STATE=== marker separates them.
//
// This prompt is param-less: Call B determines parties, terms, and the counter
// chain from the packet itself. Do not edit it without re-running the
// native-chat validation — it is the locked, proven core of Call B.
// ============================================================================
function buildTransactionPrompt() {
  return `You are an expert California real estate transaction coordinator reading a complete
contract packet at file-open. Your job is to determine the FINAL CONTRACTUAL STATE of
this transaction — what the parties have actually agreed to, after every counter offer
and addendum.

This is NOT a signature audit. Do not check or report on signatures, initials, or
execution — a separate process handles that. Focus only on the contractual terms,
parties, and state.

The packet may contain a Residential Purchase Agreement (RPA), counter offers (SCO,
SMCO, BCO), addenda, and advisories — or it may be just an RPA with no counters at all.
Read the ENTIRE packet and reason about it as a whole. The contractual terms live in
the RPA, the counter offers, and the addenda; advisories and disclosures are
informational.

CORE REASONING TASK — the counter chain:
- The RPA is the original offer. Counter offers and addenda modify it. The LAST accepted
  document in the chain governs the final terms.
- Work out the sequence: which document countered which, what each changed, and which
  document was ultimately accepted (the "controlling document").
- For every deal term, determine two things: the value AS ORIGINALLY OFFERED in the RPA,
  and the FINAL RECONCILED value after applying the whole chain.
- If a term was never changed by any counter, its reconciled value is simply the RPA's
  value — there is no separate "as offered."

WHAT TO DETERMINE:
- Parties — buyers and sellers, each with signing capacity (individual, trust, llc,
  corporation, estate). Capacity must be consistent across three places: the party name,
  the entity-designation paragraph (e.g. the RPA's Entity Buyers / Entity Sellers
  paragraphs), and the signature blocks. If a party is named as or signs as an entity
  (trust, LLC, corporation, estate) but the entity-designation paragraph is not properly
  completed — the entity box unchecked, or the entity name and Legally Authorized Signer
  fields left blank — or if the name line and the signature blocks disagree about
  whether the party is an entity or individuals, do NOT adjudicate which is correct: set
  that party's capacity to "ambiguous" and add the specific conflict to needs_review. A
  defect in how a party is designated is something the TC must see, not resolve away.
- Property — address, county, and APN.
- Contingencies — seven keys: loan, appraisal, inspection (RPA 3L(3) Investigation of
  Property), insurance (RPA 3L(4)), document_review, sale of buyer's property, and the
  seller's replacement property contingency. \`document_review\` is a single bundled
  contingency covering the buyer's review of all seller-provided documents and reports —
  RPA grid rows 3L(5)-(8) together. For each: status (active, waived, or not present in
  this deal) and, if active, its period. Determine a status for every one; a contingency
  not part of this deal is a meaningful "not_present" result.
- Terms — purchase price, initial deposit, acceptance date, close of escrow, seller
  disclosures due date.
- Negotiated terms — credits, repairs, inclusions, exclusions, and any unusual
  specifically-negotiated terms, including ones buried in addenda or counter offers.

REASONING GUIDANCE:
- California RPA deadlines are written relative to Acceptance ("17 days after
  Acceptance"). Count the period in CALENDAR days from the Acceptance date; if the
  resulting date lands on a weekend or legal holiday, the deadline rolls forward to the
  next business day. \`value\` carries that business-day-adjusted date, and \`basis\` states
  the relative rule (e.g. "30 days after Acceptance"). This applies to every computed
  date — close_of_escrow, seller_disclosures_due, and the contingency removal dates.
- "Seller disclosures due" is the SELLER's deadline to DELIVER the statutory disclosure
  documents to the buyer — governed by the RPA's Seller Delivery of Documents provision
  (paragraph 3N(1)), which has its own time period. Do NOT confuse it with the buyer's
  investigation and document-review contingency periods in the 3L grid. 3L and 3N are
  separate sections doing separate jobs: 3L is the buyer's investigation and review
  periods; 3N is the seller's deadline to deliver the documents the buyer will review. A
  counter that modifies 3L periods does not, by itself, change the 3N seller-delivery
  deadline — treat them independently unless a document explicitly changes 3N.
- A counter offer's free-text "other terms" are written by an agent and can be loosely
  or imprecisely worded. They are authoritative when they clearly and specifically state
  a change (e.g. "purchase price to $19,995,000" changes the price). But when a
  free-text term is vague, or its wording conflicts with the structured contract
  sections it cites — for example it says "Seller shall provide..." while referencing
  buyer-contingency sections in the 3L grid — do NOT reverse-engineer what the agent
  meant to write. Go by the structured sections themselves and read each section's
  stated value. A misworded or vague reference does not change a section it does not
  clearly and specifically modify, and does not, on its own, make that section's value
  uncertain — report the section value with confidence rather than flagging it because
  an agent's wording was sloppy.
- For the day-count contingency rows — inspection (3L(3)) and insurance (3L(4)) — the 3L
  grid prints a default period alongside a fill-in override blank, in the form "17 (or
  ___) Days after Acceptance." The printed number is only the default; when the override
  blank is filled in (e.g. "7" or "14"), that filled-in value is the actual period —
  read the override, not the printed default. The printed default applies only when the
  override blank is left empty. If an override value is not clearly legible, use your
  best read but mark that period low confidence.
- RPA grid rows 3L(5)-(8) — Review of Seller Documents, the Preliminary/Title Report,
  Common Interest [HOA] Disclosures, and leased/liened items — are a single bundled
  contingency, \`document_review\`. They are always bundled and share one effective
  timeline; do NOT model them as four separate contingencies. Their grid period reads "X
  (or ___) Days after Acceptance, or 5 Days after Delivery, whichever is later," but in
  practice the seller's documents are never delivered on the acceptance date, so the
  delivery branch always controls — the bundle's effective period is "5 days after
  delivery." Because delivery is a future event not known at file-open, \`document_review\`
  carries basis "5 days after delivery of the documents" with \`days\` and \`removal_date\`
  both null; the date is not computable until delivery occurs. Do not assign an
  after-Acceptance day-count or a removal date to this bundle. Whether the property has
  an HOA is determined from MLS data elsewhere, not from the contract packet — do not
  infer it; HOA-document review simply rides inside this bundle when applicable.
- Signer names read from signature blocks are often cursive or stylized. If a signer's
  name is not clearly legible, do not state a confident name — record that it is not
  legible and add it to needs_review. Do not let two plausible readings of one signature
  collapse into a single stated name.
- Every value you report must cite its source — which document, and the paragraph where
  you can identify it.
- You are reading rendered scanned pages; CA forms scan messily. If you genuinely cannot
  determine a value — it is illegible, truly conflicting across documents, or simply not
  stated — do NOT guess: mark it low confidence and add it to needs_review with a reason.
  But reason a question through fully before concluding it is indeterminate. needs_review
  is for values the documents genuinely do not settle — not for values that take careful
  cross-referencing of several paragraphs to work out. Do not flag something merely
  because it was not obvious on first read. An honest "could not determine" is correct;
  so is a well-reasoned determination — a premature flag is its own kind of error.

OUTPUT FORMAT — two parts, in this order:

PART 1 — your reasoning, as prose. Walk the counter chain: what each document is, what
it changed, which one governs and why. Then summarize the final contractual state.
Write it the way you would explain the deal to a transaction coordinator.

PART 2 — after the prose, on a new line, output exactly this marker:
===TRANSACTION_STATE===
followed by a single valid JSON object (no comments, no markdown fences) with this shape:

{
  "counter_chain": {
    "controlling_document": "SCO #1",
    "steps": [
      { "document": "RPA", "role": "original_offer", "date": "YYYY-MM-DD",
        "status": "superseded", "changes": [] },
      { "document": "SCO #1", "role": "seller_counter", "date": "YYYY-MM-DD",
        "status": "controlling",
        "accepted": { "by": "buyers", "date": "YYYY-MM-DD", "within_window": true },
        "changes": ["plain-English summary of what this document changed"] }
    ]
  },
  "parties": {
    "buyers":  [ { "name": "", "capacity": "individual|trust|llc|corporation|estate|ambiguous",
                   "signers": [ { "name": "" } ] } ],
    "sellers": [ { "name": "", "capacity": "...", "signers": [ { "name": "" } ] } ]
  },
  "property": { "address": "", "county": "", "apn": null },
  "terms": {
    "purchase_price":  { "reconciled": { "value": 0, "source": "", "confidence": "high|low" },
                         "as_offered": { "value": 0, "source": "" } },
    "initial_deposit": { "reconciled": { "value": 0, "basis": null, "source": "", "confidence": "high|low" },
                         "as_offered": { "value": 0, "basis": null, "source": "" } },
    "acceptance_date": { "reconciled": { "value": "YYYY-MM-DD", "source": "", "confidence": "high|low" } },
    "close_of_escrow": { "reconciled": { "value": "YYYY-MM-DD", "basis": "N days after Acceptance",
                                         "source": "", "confidence": "high|low" } },
    "seller_disclosures_due": { "reconciled": { "value": "YYYY-MM-DD", "basis": "N days after Acceptance",
                                                "source": "", "confidence": "high|low" } },
    "contingencies": {
      "loan": { "status": "active|waived|not_present",
                "reconciled": { "days": 0, "basis": null, "removal_date": "YYYY-MM-DD",
                                "source": "", "confidence": "high|low" },
                "as_offered": { "days": 0, "source": "" } },
      "appraisal":  { "...": "same shape as loan" },
      "inspection": { "...": "same shape — RPA 3L(3) Investigation of Property" },
      "insurance":  { "...": "same shape — RPA 3L(4)" },
      "document_review": { "status": "active|waived|not_present",
                           "reconciled": { "days": null, "basis": "5 days after delivery of the documents",
                                           "removal_date": null, "source": "RPA 3L(5)-3L(8)",
                                           "confidence": "high|low" } },
      "sale_of_buyers_property":     { "status": "not_present", "note": "" },
      "seller_replacement_property": { "...": "same shape — active carries reconciled, else note" }
    }
  },
  "negotiated_terms": [
    { "type": "credit|repair|inclusion|exclusion|other", "description": "", "source": "", "confidence": "high|low" }
  ],
  "needs_review": [ { "field": "", "reason": "" } ]
}

Rules for PART 2:
- "as_offered" appears on a term ONLY when a counter actually changed it from the RPA's
  value. If the RPA's value flows through unchanged, give only "reconciled" with the RPA
  as its source.
- "basis" is a string when a value is rule-derived rather than stated as a literal —
  "3% of purchase price" for a percentage deposit, "30 days after Acceptance" for a
  relative date, "5 days after delivery of the documents" for the document_review
  bundle. When the value is a plain stated figure, "basis" is null.
- "signers" lists the individuals who sign for an ENTITY party — the trustees of a
  trust, the authorized signers of an LLC or corporation. For an individual party,
  "signers" is null or omitted.
- Contingencies: determine a status for all seven keys — omit none.
    * "active" — in effect, with a removal deadline (which may be delivery-relative).
      Carries "reconciled" (and "as_offered" if a counter changed it).
    * "waived" — the contingency type applies to a deal of this kind, but the parties
      affirmatively removed it (a "No loan contingency" / "No appraisal contingency" box
      checked, or removed by counter). Carries a "note".
    * "not_present" — the contingency was never engaged in this transaction at all (no
      COP attached for sale-of-buyer's-property, no SPRP for seller-replacement). Carries
      a "note".
  Tiebreaker: if an affirmative act removed it, it is "waived"; if nothing in the packet
  engages that contingency, it is "not_present". \`document_review\` is normally "active",
  with null \`days\` and \`removal_date\` and the basis "5 days after delivery of the
  documents".
- "needs_review" lists everything you genuinely could not determine — not items that
  careful reasoning resolves.
- PART 1 prose and PART 2 JSON must agree.`;
}

// ============================================================================
// THE OUTPUT ENVELOPE.
// Call B's result is its reasoning prose plus the parsed transaction_state.
// transaction_state is null if the model omitted the marker or emitted
// unparseable JSON — the prose is never lost, and a downstream consumer can
// fall back to showing prose only.
// ============================================================================
function buildEnvelope(parsed) {
  return {
    prose: parsed.prose,                          // PART 1 — the reasoning narrative
    transaction_state: parsed.transaction_state,  // PART 2 — the structured state (null if unparseable)
  };
}

exports.handler = async function (event) {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    console.error('[transaction-background] invalid JSON body');
    return { statusCode: 400 };
  }

  const { jobId } = body;
  if (!jobId) {
    console.error('[transaction-background] missing jobId');
    return { statusCode: 400 };
  }

  // The PDF lives in audit-payloads — the same store Call A reads. The
  // orchestrator drops one packet there and fans out both calls against it.
  const payloadStore = getStore(blobsConfig('audit-payloads'));
  const resultsStore = getStore(blobsConfig('transaction-results'));

  let payload;
  try {
    payload = await payloadStore.get(jobId, { type: 'json' });
  } catch (err) {
    console.error(`[transaction-background] jobId=${jobId} failed to read payload:`, err.message);
    await resultsStore.setJSON(jobId, {
      status: 'error', completedAt: Date.now(),
      error: `Failed to read payload: ${err.message}`,
    });
    return { statusCode: 500 };
  }
  if (!payload) {
    console.error(`[transaction-background] jobId=${jobId} payload not found in audit-payloads`);
    await resultsStore.setJSON(jobId, {
      status: 'error', completedAt: Date.now(),
      error: 'Payload not found in audit-payloads store.',
    });
    return { statusCode: 404 };
  }

  const pdfBase64 = payload.documents && payload.documents[0] && payload.documents[0].data;
  if (!pdfBase64) {
    await resultsStore.setJSON(jobId, {
      status: 'error', completedAt: Date.now(),
      error: 'Payload had no PDF document.',
    });
    return { statusCode: 400 };
  }

  await resultsStore.setJSON(jobId, {
    status: 'pending', stage: 'transaction', startedAt: Date.now(),
  });
  console.log(`[transaction-background] jobId=${jobId} starting transaction-state reasoning`);

  try {
    const prompt = buildTransactionPrompt();

    // ONE call. Whole PDF + the locked prompt.
    const raw = await callClaude(prompt, pdfBase64);

    // Split PART 1 prose from the PART 2 transaction_state JSON.
    const parsed = parseTransactionResponse(raw);

    const envelope = buildEnvelope(parsed);

    await resultsStore.setJSON(jobId, {
      status: 'complete',
      completedAt: Date.now(),
      result: envelope,
    });
    console.log(`[transaction-background] jobId=${jobId} complete -- transaction_state ${envelope.transaction_state ? 'parsed' : 'NULL (unparseable)'}`);
    return { statusCode: 200 };
  } catch (err) {
    console.error(`[transaction-background] jobId=${jobId} ERROR:`, err.message);
    await resultsStore.setJSON(jobId, {
      status: 'error', completedAt: Date.now(),
      error: err.message,
    });
    return { statusCode: 500 };
  }
};

// ----------------------------------------------------------------------------
// Split the model's response into { prose, transaction_state }.
// PART 1 is everything before the ===TRANSACTION_STATE=== marker; PART 2 is the
// JSON after it. If the marker or JSON is missing/unparseable, we still return
// the prose (the reasoning is never lost) and flag transaction_state as null.
// ----------------------------------------------------------------------------
function parseTransactionResponse(raw) {
  const text = raw || '';
  const marker = '===TRANSACTION_STATE===';
  const idx = text.indexOf(marker);

  if (idx === -1) {
    console.warn('[transaction-background] no ===TRANSACTION_STATE=== marker in response');
    return { prose: text.trim(), transaction_state: null };
  }

  const prose = text.slice(0, idx).trim();
  let jsonPart = text.slice(idx + marker.length).trim();
  jsonPart = jsonPart.replace(/```json|```/g, '').trim();

  let transaction_state = null;
  try {
    const m = jsonPart.match(/\{[\s\S]*\}/);
    transaction_state = m ? JSON.parse(m[0]) : JSON.parse(jsonPart);
  } catch (e) {
    console.warn('[transaction-background] transaction_state JSON parse failed:', e.message);
    transaction_state = null;
  }

  return { prose, transaction_state };
}

// ----------------------------------------------------------------------------
// Anthropic call. Whole PDF as a document block + the prompt.
//
// Opus 4.7 with ADAPTIVE THINKING: the model decides how much to reason before
// answering. effort='high' (the Opus 4.7 default and documented sweet spot)
// lives in output_config, NOT inside `thinking`. 'max' is avoided on purpose --
// the docs warn it can cause overthinking on structured-output tasks, and this
// call emits a JSON block.
//
// max_tokens is generous (32000) because adaptive thinking tokens are billed as
// output and count toward max_tokens -- the ceiling must cover thinking PLUS
// the substantial PART 1 prose + PART 2 JSON. You are billed only for tokens
// actually generated, so a high ceiling costs nothing extra; it only prevents
// truncation. The stop_reason guard below turns any remaining truncation into a
// loud failure instead of a silently partial transaction_state.
//
// Retries on 429/529.
// ----------------------------------------------------------------------------
async function callClaude(prompt, pdfBase64, attempt = 0) {
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
      // Well within Opus 4.7's 128k output limit; only billed for tokens
      // actually generated. Covers adaptive thinking + prose + JSON.
      max_tokens: 32000,
      // Opus 4.7 requires adaptive thinking. display:'omitted' skips streaming
      // the thinking text (this is a server-to-server pipeline that never
      // surfaces it); the text-block filter below is unaffected by this.
      thinking: { type: 'adaptive', display: 'omitted' },
      // effort is a top-level output_config field (NOT nested in `thinking`).
      output_config: { effort: 'high' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  });

  if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter
      ? Math.min(parseFloat(retryAfter) * 1000, 30000)
      : Math.min(1000 * Math.pow(2, attempt), 30000);
    console.log(`[callClaude] ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
    return callClaude(prompt, pdfBase64, attempt + 1);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();

  // Ledger BEFORE the truncation guard below on purpose: a max_tokens response is
  // billed in full (thinking tokens included) and then throws, so logging after
  // the guard would make the most expensive failures the invisible ones -- and a
  // re-run of this job re-bills them. This is the row that exposes that pattern.
  await usageLog.logUsage({ fn: 'transaction', model: MODEL, effort: 'high', usage: data.usage });

  // Truncation guard: with adaptive thinking, thinking tokens consume the same
  // budget as the response. If max_tokens were too small the output would be
  // cut off mid-sentence and parseTransactionResponse would still "succeed" on
  // a partial answer -- a silent bad result. Fail loudly instead.
  if (data.stop_reason === 'max_tokens') {
    throw new Error(
      'Transaction-state response hit max_tokens -- output was truncated before completion. ' +
      'Raise max_tokens in callClaude and re-run this job.'
    );
  }

  // Adaptive thinking returns thinking blocks before text blocks. We keep only
  // the text blocks (the prose + the ===TRANSACTION_STATE=== JSON); this filter
  // already ignores thinking blocks correctly.
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
