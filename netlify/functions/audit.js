// netlify/functions/audit.js
//
// Signature audit function for Keeva — anchor-driven version.
//
// Accepts a PDF + form_id + party counts, runs anchor-based signature audit
// against the matching schema, returns structured audit results.
//
// FLOW:
//   1. Load PDF + schema
//   2. Extract per-page text via pdf-parse (in parallel)
//   3. Detect which pages belong to this form (footer_patterns match)
//   4. One combined Claude call: detect contract state + entity scenarios
//      + extract entity/signer names
//   5. Expand schema signature_locations → flat list of check tuples,
//      applying phase + scenario + party filters
//   6. Run all checks in parallel (one Claude vision call per check)
//   7. Compile results + summary
//
// V1 NOTES:
// - Synchronous function. If we hit Netlify's 26s limit on large fully-
//   executed contracts, convert to a background function with webhook return.
// - Form detection within a packet is implicit (footer_patterns); for multi-
//   form packets we'd run audit per form.

const { PDFDocument } = require('pdf-lib');
const pdfParse = require('pdf-parse');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

const SCHEMAS = {
  'CAR-RPA-1225': require('./schemas/CAR-RPA-1225.json'),
  'AD-BUYER-1224': require('./schemas/AD-BUYER-1224.json'),
};

// ===== Handler =====

exports.handler = async function (event) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };
  }

  try {
    const { pdfBase64, formId, buyerCount = 1, sellerCount = 1 } = JSON.parse(event.body);

    if (!pdfBase64 || !formId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'pdfBase64 and formId are required' }),
      };
    }

    const schema = loadSchema(formId);
    if (!schema) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: `Schema not found: ${formId}` }),
      };
    }

    // 1. Load PDF
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const totalPages = pdfDoc.getPageCount();

    // 2. Extract text from every page (parallel)
    const pageTexts = await extractAllPageTexts(pdfDoc);

    // 3. Detect which pages belong to this form
    const formPages = detectFormPages(schema, pageTexts);

    if (formPages.length === 0) {
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          formId: schema.form_id,
          formName: schema.form_name,
          error: 'No pages in the uploaded PDF matched this form\'s footer_patterns. Check that the correct form schema was selected and that the PDF contains the expected form.',
          totalPages,
          formPages,
        }, null, 2),
      };
    }

    // 4. Combined upfront detection: state + entity scenarios + names
    const detection = await detectStateAndScenarios(schema, pdfDoc, pageTexts, formPages);

    // 5. Expand checks
    const checks = expandChecks(schema, pageTexts, formPages, detection, buyerCount, sellerCount);

    // 6. Run all checks in parallel
    const settled = await Promise.allSettled(checks.map((c) => runCheck(pdfDoc, c, detection)));
    const results = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return { ...checks[i], status: 'error', error: r.reason?.message || String(r.reason) };
    });

    // 7. Compile output
    const output = {
      formId: schema.form_id,
      formName: schema.form_name,
      totalPages,
      formPages,
      partyCount: { buyers: buyerCount, sellers: sellerCount },
      detection,
      checksRun: checks.length,
      results,
      summary: summarize(results),
    };

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(output, null, 2),
    };
  } catch (err) {
    console.error('Audit error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message, stack: err.stack }),
    };
  }
};

// ===== Schema =====

function loadSchema(formId) {
  return SCHEMAS[formId] || null;
}

// ===== Text extraction =====

async function extractAllPageTexts(pdfDoc) {
  const totalPages = pdfDoc.getPageCount();
  const promises = [];
  for (let i = 0; i < totalPages; i++) {
    promises.push(extractPageText(pdfDoc, i));
  }
  return Promise.all(promises);
}

async function extractPageText(pdfDoc, pageIndex) {
  try {
    const singleDoc = await PDFDocument.create();
    const [copied] = await singleDoc.copyPages(pdfDoc, [pageIndex]);
    singleDoc.addPage(copied);
    const bytes = await singleDoc.save();
    const result = await pdfParse(Buffer.from(bytes));
    const text = result.text || '';
    console.log(`[extractPageText] page ${pageIndex + 1}: ${text.length} chars extracted`);
    return text;
  } catch (err) {
    console.error(`[extractPageText] page ${pageIndex + 1} FAILED:`, err.message);
    return '';
  }
}

// ===== Form-page detection =====

function detectFormPages(schema, pageTexts) {
  const patterns = (schema.detection && schema.detection.footer_patterns) || [];
  const formPages = [];

  console.log(`\n[detectFormPages] === START ===`);
  console.log(`[detectFormPages] schema patterns: ${JSON.stringify(patterns)}`);
  console.log(`[detectFormPages] total pages: ${pageTexts.length}`);

  pageTexts.forEach((text, i) => {
    const pageNum = i + 1;
    const preview = (text || '').substring(0, 400).replace(/\s+/g, ' ').trim();
    const matchedPattern = patterns.find((p) => text.includes(p));

    console.log(`[detectFormPages] page ${pageNum}: len=${text.length}, ` +
      `has "RPA"=${text.includes('RPA')}, ` +
      `has "Residential Purchase"=${text.includes('Residential Purchase')}, ` +
      `has "California Residential"=${text.includes('California Residential')}, ` +
      `matched="${matchedPattern || 'NONE'}"`);
    console.log(`[detectFormPages] page ${pageNum} preview: "${preview}"`);

    if (matchedPattern) formPages.push(pageNum);
  });

  console.log(`[detectFormPages] result: ${JSON.stringify(formPages)}`);
  console.log(`[detectFormPages] === END ===\n`);

  return formPages;
}

// ===== Anchor resolution =====

function resolveAnchor(anchor, pageTexts, formPages) {
  if (!anchor) return [];

  // Type 1: scope-based (all form pages, with optional exclusions)
  if (anchor.scope === 'all_form_pages') {
    let pages = [...formPages];
    if (anchor.exclude_anchor) {
      const excluded = resolveAnchor(anchor.exclude_anchor, pageTexts, formPages);
      pages = pages.filter((p) => !excluded.includes(p));
    }
    return pages;
  }

  // Type 2: text-based (any_of)
  if (anchor.any_of && Array.isArray(anchor.any_of)) {
    const matches = [];
    pageTexts.forEach((text, i) => {
      const page = i + 1;
      if (formPages.includes(page) && anchor.any_of.some((pattern) => text.includes(pattern))) {
        matches.push(page);
      }
    });
    return matches;
  }

  return [];
}

// ===== State + entity scenario detection =====

async function detectStateAndScenarios(schema, pdfDoc, pageTexts, formPages) {
  const hasSellerPhase = schema.signature_locations.some((loc) => loc.phase === 'seller_acceptance');
  const hasEntityScenarios = schema.signature_locations.some(
    (loc) => loc.scenario === 'buyer_is_entity' || loc.scenario === 'seller_is_entity'
  );

  // If schema has no phase/scenario complexity (e.g., AD form), short-circuit
  if (!hasSellerPhase && !hasEntityScenarios) {
    return {
      state: 'all',
      buyer_is_entity: false,
      seller_is_entity: false,
      buyer_entity_name: null,
      buyer_signer_names: null,
      seller_entity_name: null,
      seller_signer_names: null,
    };
  }

  // Find the seller signature page via its anchor
  const sellerSigPages = resolveAnchor({ any_of: ['Printed name of SELLER:'] }, pageTexts, formPages);

  if (sellerSigPages.length === 0) {
    // Anchor didn't match — conservative default
    return {
      state: 'offer_only',
      buyer_is_entity: false,
      seller_is_entity: false,
      buyer_entity_name: null,
      buyer_signer_names: null,
      seller_entity_name: null,
      seller_signer_names: null,
    };
  }

  const sigPageIndex = sellerSigPages[0] - 1;
  const pageBase64 = await singlePagePdfBase64(pdfDoc, sigPageIndex);

  const prompt = `You are examining the signature page of a California Residential Purchase Agreement.

Determine ALL of the following from this single page and return as one JSON object:

1. CONTRACT STATE — examine the Seller signature block in Section 33:
   - seller_signed: Are seller signature lines filled with actual signatures (handwritten or DocuSign image stamps)? Boolean.
   - counter_offer_checked: Is the "Seller Counter Offer (C.A.R. Form SCO or SMCO)" checkbox in Section 33A checked? Boolean.

2. ENTITY DETECTION:
   - buyer_is_entity: Is the "ENTITY BUYERS:" checkbox in Section 32B checked? Boolean.
   - seller_is_entity: Is the "ENTITY SELLERS:" checkbox in Section 33B checked? Boolean.

3. ENTITY NAMES — only if respective entity flag is true; otherwise null:
   - buyer_entity_name: Text from Section 32B(2) "Full entity name:" field.
   - buyer_signer_names: Array of names from Section 32B(4)(B) "name(s) of the Legally Authorized Signer(s)".
   - seller_entity_name: Text from Section 33B(2) "Full entity name:" field.
   - seller_signer_names: Array of names from Section 33B(4)(B) "name(s) of the Legally Authorized Signer(s)".

Return ONLY this JSON object (no markdown fences, no other text):
{
  "seller_signed": true|false,
  "counter_offer_checked": true|false,
  "buyer_is_entity": true|false,
  "seller_is_entity": true|false,
  "buyer_entity_name": "..." or null,
  "buyer_signer_names": ["...", "..."] or null,
  "seller_entity_name": "..." or null,
  "seller_signer_names": ["...", "..."] or null
}`;

  try {
    const response = await callClaude(prompt, pageBase64);
    const parsed = parseJsonResponse(response);

    let state;
    if (parsed.seller_signed) state = 'fully_executed';
    else if (parsed.counter_offer_checked) state = 'counter_pending';
    else state = 'offer_only';

    return {
      state,
      buyer_is_entity: !!parsed.buyer_is_entity,
      seller_is_entity: !!parsed.seller_is_entity,
      buyer_entity_name: parsed.buyer_entity_name || null,
      buyer_signer_names: parsed.buyer_signer_names || null,
      seller_entity_name: parsed.seller_entity_name || null,
      seller_signer_names: parsed.seller_signer_names || null,
    };
  } catch (err) {
    console.error('Detection error:', err.message);
    return {
      state: 'offer_only',
      buyer_is_entity: false,
      seller_is_entity: false,
      buyer_entity_name: null,
      buyer_signer_names: null,
      seller_entity_name: null,
      seller_signer_names: null,
    };
  }
}

// ===== Check expansion =====

function expandChecks(schema, pageTexts, formPages, detection, buyerCount, sellerCount) {
  const checks = [];

  for (const loc of schema.signature_locations) {
    // Phase filtering
    if (detection.state === 'offer_only' && loc.phase === 'seller_acceptance') continue;

    // Scenario filtering
    if (loc.scenario === 'buyer_is_entity' && !detection.buyer_is_entity) continue;
    if (loc.scenario === 'seller_is_entity' && !detection.seller_is_entity) continue;

    // Resolve target pages via anchor
    const pages = resolveAnchor(loc.page_anchor, pageTexts, formPages);
    if (pages.length === 0) continue;

    // Party filtering
    const presentParties = filterParties(loc.parties, buyerCount, sellerCount);

    for (const page of pages) {
      for (const party of presentParties) {
        checks.push({
          locationId: loc.id,
          locationDescription: loc.description,
          page,
          party,
          markType: loc.mark_type,
          requirement: loc.requirement,
          phase: loc.phase,
          scenario: loc.scenario,
          condition: loc.condition,
        });
      }
    }
  }

  return checks;
}

function filterParties(parties, buyerCount, sellerCount) {
  return parties.filter((p) => {
    const bm = p.match(/^Buyer (\d+)$/);
    if (bm) return parseInt(bm[1], 10) <= buyerCount;
    const sm = p.match(/^Seller (\d+)$/);
    if (sm) return parseInt(sm[1], 10) <= sellerCount;
    return true;
  });
}

// ===== Per-check execution =====

async function runCheck(pdfDoc, check, detection) {
  const pageBase64 = await singlePagePdfBase64(pdfDoc, check.page - 1);
  const prompt = buildPrompt(check, detection);

  try {
    const response = await callClaude(prompt, pageBase64);
    const parsed = parseJsonResponse(response);
    return {
      ...check,
      status: parsed.status,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
    };
  } catch (err) {
    return { ...check, status: 'error', error: err.message };
  }
}

function buildPrompt(check, detection) {
  const header = `You are auditing a single page of a California real estate contract.

LOCATION TO CHECK: ${check.locationDescription}
PARTY: ${check.party}
MARK TYPE: ${check.markType}
`;

  let body = '';
  let returnSchema = `{
  "status": "present" | "absent" | "unclear" | "not_applicable",
  "confidence": "high" | "medium" | "low",
  "reasoning": "one-sentence explanation of what you observed"
}`;

  switch (check.markType) {
    case 'signature':
      body = `Determine whether ${check.party}'s signature is present at the location described above.

GUIDANCE:
- Look for an actual handwritten signature OR a DocuSign-style image stamp.
- A typed/printed name in the signature line area WITHOUT an actual signature glyph is NOT a signature — that is "absent".
- If the expected line is NOT VISIBLE on this page, return "not_applicable".
- Bias toward flagging. If unsure, return "unclear" — never default to "present" when uncertain.`;
      break;

    case 'initial':
      body = `Determine whether ${check.party}'s initials are present at the location described above.

GUIDANCE:
- Look for handwritten initials OR a DocuSign initial stamp in the specified box.
- If the expected box is NOT VISIBLE on this page, return "not_applicable".
- Bias toward flagging. If unsure, return "unclear".`;
      break;

    case 'date':
      body = `Determine whether a date value is present at the date field for ${check.party}'s signature/initial.

GUIDANCE:
- Look for any date format (MM/DD/YYYY, M/D/YY, written date, etc.).
- The date should be next to or associated with ${check.party}'s signature or initial.
- If the date field is NOT VISIBLE on this page, return "not_applicable".`;
      break;

    case 'checkbox':
      body = `Determine whether the specific checkbox described above is marked.

GUIDANCE:
- A marked checkbox has an X, checkmark, filled box, or similar marking.
- An empty/blank checkbox is "absent".
- If the checkbox is NOT VISIBLE on this page, return "not_applicable".`;
      break;

    case 'filled_text':
      body = `Determine whether the specific text field described above contains any content.

GUIDANCE:
- Any non-blank content in the field counts as "present" — we are not validating the correctness of the content.
- An empty/blank field is "absent".
- If the field is NOT VISIBLE on this page, return "not_applicable".
- Include the extracted content in your reasoning if present.`;
      break;

    case 'identity_match': {
      const isBuyerScenario = check.scenario === 'buyer_is_entity';
      const entityName = isBuyerScenario ? detection.buyer_entity_name : detection.seller_entity_name;
      const signerNames = isBuyerScenario ? detection.buyer_signer_names : detection.seller_signer_names;
      const signerList =
        signerNames && signerNames.length ? signerNames.map((n) => `"${n}"`).join(', ') : 'unknown';

      body = `The signing party is an ENTITY. The signature glyph must show a HUMAN signer's name, NOT the entity name itself. Common error: agents sign the entity name as the signature glyph instead of the authorized signer's name.

CONTEXT FROM THIS CONTRACT:
- Entity name: "${entityName || 'unknown'}"
- Authorized signer name(s): ${signerList}

Examine the visible signature for ${check.party} at the described location. Compare what the signature glyph appears to depict against the entity name and the authorized signer names listed above.

POSSIBLE STATUS VALUES (use these exact strings):
- "matches_signer" — signature glyph shows one of the authorized signer names (CORRECT)
- "matches_entity" — signature glyph shows the entity name itself (INCORRECT — must be flagged)
- "matches_other" — signature shows a name not in the authorized signer list
- "unclear" — signature is unreadable, ambiguous, or absent
- "not_applicable" — no signature visible at this location`;
      returnSchema = `{
  "status": "matches_signer" | "matches_entity" | "matches_other" | "unclear" | "not_applicable",
  "confidence": "high" | "medium" | "low",
  "reasoning": "one-sentence explanation, including what name the signature appears to depict"
}`;
      break;
    }

    default:
      body = `Determine whether ${check.party}'s mark is present at the location described above. If uncertain, return "unclear".`;
  }

  return `${header}
${body}

Return ONLY a JSON object with this exact structure (no markdown code fences, no other text):
${returnSchema}`;
}

// ===== PDF helper =====

async function singlePagePdfBase64(sourceDoc, pageIndex) {
  const newDoc = await PDFDocument.create();
  const [copied] = await newDoc.copyPages(sourceDoc, [pageIndex]);
  newDoc.addPage(copied);
  const bytes = await newDoc.save();
  return Buffer.from(bytes).toString('base64');
}

// ===== Claude API =====

async function callClaude(prompt, pdfBase64) {
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
      max_tokens: 1024,
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

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

function parseJsonResponse(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// ===== Summary =====

function summarize(results) {
  const summary = {
    present: 0,
    absent: 0,
    unclear: 0,
    not_applicable: 0,
    error: 0,
    matches_signer: 0,
    matches_entity: 0,
    matches_other: 0,
    missingItems: [],
    flaggedItems: [],
  };

  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;

    if (r.status === 'absent' || r.status === 'unclear') {
      summary.missingItems.push({
        page: r.page,
        party: r.party,
        markType: r.markType,
        locationId: r.locationId,
        status: r.status,
        confidence: r.confidence,
        reasoning: r.reasoning,
      });
    }

    if (r.status === 'matches_entity' || r.status === 'matches_other') {
      summary.flaggedItems.push({
        page: r.page,
        party: r.party,
        markType: r.markType,
        locationId: r.locationId,
        status: r.status,
        confidence: r.confidence,
        reasoning: r.reasoning,
      });
    }
  }

  return summary;
}
