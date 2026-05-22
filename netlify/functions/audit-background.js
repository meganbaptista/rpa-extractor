// netlify/functions/audit-background.js
//
// ============================================================================
// KEEVA INTAKE — Phase 1: holistic signature audit
// ============================================================================
// ONE Claude call over the WHOLE contract packet (RPA + counters + addenda).
// No cropping, no per-page fan-out, no schema. The model reads the entire
// document and reasons about it — the way a TC does, the way native Claude
// did in testing on the Stonewood 3-trustee + counter-offer packet.
//
// WHY THIS REPLACED THE OLD ENGINE: the previous audit-background.js made ~90
// anchored, cropped, single-slot vision calls and reconstructed an audit from
// fragments. It was unreliable — counting tiny initials on flattened PDFs is
// at the entropy limit. Testing showed native Claude, given the whole packet
// in one call, produces a categorically better audit (read all 3 trustees'
// initials, reasoned through the SMCO/BCO counter chain, caught QC issues).
// So the product is: automate that one holistic call, structure its output,
// make it mandatory. This file is that.
//
// ----------------------------------------------------------------------------
// DESIGNED FOR THE FULL VISION (Phases 2-4):
// The output envelope below has `audit` populated now, and `extracted` +
// `reconciled` reserved (null in Phase 1). Phase 2 adds property/transaction
// extraction to the SAME call; Phase 3 adds counter-offer reconciliation
// (final acceptance date, final contingency dates, final price). The prompt
// and the envelope are structured so those slot in as ADDITIONS — no rewrite.
// ----------------------------------------------------------------------------
//
// Input contract (invocation body, from the orchestrator):
//   { jobId, buyerCount, sellerCount, sellerEntity?, buyerEntity? }
// The PDF is read from the audit-payloads blob store by jobId.
//
// Output (written to audit-results under jobId):
//   { status:'complete', result: { ...envelope } }
// ============================================================================

console.log('[audit-background] module loading (line 1)');

const { getStore } = require('@netlify/blobs');
console.log('[audit-background] @netlify/blobs loaded');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

console.log('[audit-background] module fully loaded, handler ready');

function blobsConfig(name) {
  return {
    name,
    siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============================================================================
// THE PROMPT — this is the heart of the product. It replaces the entire old
// engine. It is the standardized, hardened version of the plain-English
// prompt that worked in native-chat testing.
//
// Design principle: REASONING FIRST, STRUCTURE SECOND. The model audits the
// document and writes its full analysis as prose (this is what makes it good
// -- free reasoning). THEN it emits a structured JSON block derived from its
// own reasoning. We never force rigid JSON in a way that chokes the analysis.
// ============================================================================
function buildAuditPrompt(params) {
  const { buyerCount, sellerCount, sellerEntity, buyerEntity } = params;

  // Party context -- the equivalent of "one buyer, one seller, one agent" that
  // made the native-chat prompt work. Derived by the handoff mapper.
  let partyContext = `This transaction has ${buyerCount} buyer(s) and ${sellerCount} seller(s), plus a buyer's agent and a listing agent.`;
  if (sellerEntity && sellerEntity.isEntity) {
    partyContext += ` The seller side is an entity${sellerEntity.entityName ? ` ("${sellerEntity.entityName}")` : ''}`;
    if (sellerEntity.signerNames && sellerEntity.signerNames.length) {
      partyContext += `, signed by its authorized signer(s): ${sellerEntity.signerNames.join(', ')}`;
    }
    partyContext += '.';
  }
  if (buyerEntity && buyerEntity.isEntity) {
    partyContext += ` The buyer side is an entity${buyerEntity.entityName ? ` ("${buyerEntity.entityName}")` : ''}.`;
  }

  return `You are an expert California real estate transaction coordinator performing a signature and initials audit on a contract packet at file-open.

${partyContext}

The packet may contain a Residential Purchase Agreement (RPA) plus counter offers (SCO, SMCO, BCO) and addenda. Read the ENTIRE packet and reason about it as a whole.

YOUR TASK -- audit every required signature and initial:
- Every per-page initial on the RPA (buyer and seller initials on each page footer).
- The Liquidated Damages (paragraph 29) and Arbitration of Disputes (paragraph 31) initials.
- Buyer and seller signature blocks (RPA paragraphs 32 and 33).
- Buyer's Agent and Listing Agent signatures (Real Estate Brokers Section).
- All signatures and initials on every counter offer and addendum in the packet.
- For entity/trust sellers or buyers, confirm the authorized signers signed.

IMPORTANT REASONING GUIDANCE:
- A counter offer chain matters: the LAST accepted document governs. If a counter offer was accepted, that is where the binding signatures are. A blank signature line on an earlier document may be CORRECT if the form instructs parties to sign the attached counter instead -- reason about this, do not blindly flag every blank line.
- The Escrow Holder Acknowledgment is normally blank at file-open -- that is expected, not a missing signature.
- Distinguish a genuine MISSING required signature/initial from something that is blank by design.
- You are reading rendered scanned pages; CAR forms scan messily. If you cannot clearly tell whether a small initial is present, say so and flag it for human eyes rather than guessing.
- Also note any QC issues you happen to see -- a stray/incorrect name, a form that should have been used (e.g. Form ASA for more than two signers), data that looks inconsistent -- even though they are not missing signatures.

OUTPUT FORMAT -- two parts, in this order:

PART 1 -- Your full audit as prose. Write it the way you would explain it to the transaction coordinator: bottom line first, then a walk through each document in the packet, then QC items. Be thorough and specific (cite paragraphs and pages).

PART 2 -- After the prose, on a new line, output exactly this marker:
===STRUCTURED===
followed by a single JSON object (no markdown fences) with this shape:
{
  "overall_status": "complete" | "issues_found" | "needs_review",
  "summary": "one-sentence plain-English bottom line",
  "findings": [
    {
      "location": "where, e.g. 'RPA p17 Real Estate Brokers Section' or 'BCO #1 para 4'",
      "issue": "what is missing or wrong",
      "severity": "missing" | "qc_flag" | "review",
      "detail": "one sentence of specifics"
    }
  ]
}
Rules for PART 2:
- "overall_status": "complete" if every required signature/initial is present and only normal-at-this-stage blanks remain; "issues_found" if a required signature/initial is genuinely missing; "needs_review" if you could not clearly determine something and a human must check.
- "findings": include every genuine missing signature/initial (severity "missing"), every QC issue (severity "qc_flag"), and every spot you could not clearly read (severity "review"). If there are none, use an empty array.
- The JSON must be valid and parseable. PART 1 prose is the audit; PART 2 JSON is the machine-readable summary of it -- they must agree.`;
}

// ============================================================================
// THE OUTPUT ENVELOPE -- designed for the full vision.
// Phase 1 populates `audit`. `extracted` and `reconciled` are reserved (null)
// and get populated when Phases 2-3 widen the prompt. Keeping them in the
// envelope now means downstream consumers (the test page, later Keeva) have a
// stable shape to read against.
// ============================================================================
function buildEnvelope(auditPart) {
  return {
    phase: 1,
    audit: auditPart,        // { prose, structured } -- populated in Phase 1
    extracted: null,         // Phase 2: property/transaction fields
    reconciled: null,        // Phase 3: counter-offer final values
  };
}

exports.handler = async function (event) {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    console.error('[audit-background] invalid JSON body');
    return { statusCode: 400 };
  }

  const { jobId, buyerCount = 1, sellerCount = 1, sellerEntity, buyerEntity } = body;
  if (!jobId) {
    console.error('[audit-background] missing jobId');
    return { statusCode: 400 };
  }

  // The PDF lives in audit-payloads (the orchestrator copied it there before
  // extraction ran -- the extractor deletes extraction-payloads on completion).
  const payloadStore = getStore(blobsConfig('audit-payloads'));
  const resultsStore = getStore(blobsConfig('audit-results'));

  let payload;
  try {
    payload = await payloadStore.get(jobId, { type: 'json' });
  } catch (err) {
    console.error(`[audit-background] jobId=${jobId} failed to read payload:`, err.message);
    await resultsStore.setJSON(jobId, {
      status: 'error', completedAt: Date.now(),
      error: `Failed to read payload: ${err.message}`,
    });
    return { statusCode: 500 };
  }
  if (!payload) {
    console.error(`[audit-background] jobId=${jobId} payload not found in audit-payloads`);
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
    status: 'pending', stage: 'audit', startedAt: Date.now(),
  });
  console.log(`[audit-background] jobId=${jobId} starting holistic audit (buyers=${buyerCount} sellers=${sellerCount})`);

  try {
    const prompt = buildAuditPrompt({ buyerCount, sellerCount, sellerEntity, buyerEntity });

    // ONE call. Whole PDF + the standardized prompt.
    const raw = await callClaude(prompt, pdfBase64);

    // Split PART 1 prose from the PART 2 structured JSON.
    const auditPart = parseAuditResponse(raw);

    const envelope = buildEnvelope(auditPart);

    await resultsStore.setJSON(jobId, {
      status: 'complete',
      completedAt: Date.now(),
      result: envelope,
    });
    console.log(`[audit-background] jobId=${jobId} complete -- overall_status=${auditPart.structured && auditPart.structured.overall_status}`);
    return { statusCode: 200 };
  } catch (err) {
    console.error(`[audit-background] jobId=${jobId} ERROR:`, err.message);
    await resultsStore.setJSON(jobId, {
      status: 'error', completedAt: Date.now(),
      error: err.message,
    });
    return { statusCode: 500 };
  }
};

// ----------------------------------------------------------------------------
// Split the model's response into { prose, structured }.
// PART 1 is everything before the ===STRUCTURED=== marker; PART 2 is the JSON
// after it. If the marker or JSON is missing/unparseable, we still return the
// prose (the audit is never lost) and flag structured as null so the UI can
// fall back to showing prose only.
// ----------------------------------------------------------------------------
function parseAuditResponse(raw) {
  const text = raw || '';
  const marker = '===STRUCTURED===';
  const idx = text.indexOf(marker);

  if (idx === -1) {
    console.warn('[audit-background] no ===STRUCTURED=== marker in response');
    return { prose: text.trim(), structured: null };
  }

  const prose = text.slice(0, idx).trim();
  let jsonPart = text.slice(idx + marker.length).trim();
  jsonPart = jsonPart.replace(/```json|```/g, '').trim();

  let structured = null;
  try {
    const m = jsonPart.match(/\{[\s\S]*\}/);
    structured = m ? JSON.parse(m[0]) : JSON.parse(jsonPart);
  } catch (e) {
    console.warn('[audit-background] structured JSON parse failed:', e.message);
    structured = null;
  }

  return { prose, structured };
}

// ----------------------------------------------------------------------------
// Anthropic call. Whole PDF as a document block + the prompt. Generous
// max_tokens because the holistic audit produces substantial prose.
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
      max_tokens: 8000,
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
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
