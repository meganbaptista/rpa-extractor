// netlify/functions/audit.js
//
// Signature audit function for Keeva.
// Accepts a PDF + form_id + party counts, runs phase-aware signature audit
// against the matching schema, returns structured audit results.
//
// V1 NOTES:
// - Synchronous function. If we hit Netlify's 26s limit on real contracts,
//   convert to a background function with a polling/webhook pattern.
// - Form detection is skipped — caller specifies formId. Form detection
//   will be added when this is integrated into the main extractor flow.
// - Schemas are read from ./schemas/{formId}.json (inside this functions
//   folder, so they get bundled with the deploy).

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

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

    // 1. Load schema
    const schema = loadSchema(formId);
    if (!schema) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: `Schema not found: ${formId}` }),
      };
    }

    // 2. Load PDF
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();

    // 3. Detect contract state (only if schema has phase-based locations)
    const state = await detectContractState(schema, pdfDoc, totalPages);

    // 4. Expand schema into concrete check tuples
    const checks = expandChecks(schema, totalPages, state, buyerCount, sellerCount);

    // 5. Run all checks in parallel
    const settled = await Promise.allSettled(checks.map((c) => runCheck(pdfDoc, c)));

    // 6. Compile output
    const results = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return {
        ...checks[i],
        status: 'error',
        error: r.reason?.message || String(r.reason),
      };
    });

    const output = {
      formId: schema.form_id,
      formName: schema.form_name,
      contractState: state,
      partyCount: { buyers: buyerCount, sellers: sellerCount },
      totalPages,
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

// ----- Schema loading -----

function loadSchema(formId) {
  const schemaPath = path.join(
  process.cwd(),
  'netlify',
  'functions',
  'schemas',
  `${formId}.json`
);

console.log('Loading schema from:', schemaPath);
  if (!fs.existsSync(schemaPath)) return null;
  return JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
}

// ----- Page scope resolution -----

function resolvePages(pageScope, totalPages) {
  let pages = [];
  switch (pageScope.type) {
    case 'every_page':
      pages = Array.from({ length: totalPages }, (_, i) => i + 1);
      break;
    case 'page_range': {
      const from = pageScope.from || 1;
      const to = pageScope.to || totalPages;
      pages = Array.from({ length: to - from + 1 }, (_, i) => i + from);
      break;
    }
    case 'specific':
      pages = [pageScope.page];
      break;
    case 'first':
      pages = [1];
      break;
    case 'last':
      pages = [totalPages];
      break;
    case 'relative_to_last': {
      const target = totalPages + pageScope.offset;
      pages = target >= 1 && target <= totalPages ? [target] : [];
      break;
    }
    default:
      throw new Error(`Unknown page_scope type: ${pageScope.type}`);
  }

  // Apply exclusions
  if (pageScope.exclude && Array.isArray(pageScope.exclude)) {
    for (const exScope of pageScope.exclude) {
      const exPages = resolvePages(exScope, totalPages);
      pages = pages.filter((p) => !exPages.includes(p));
    }
  }

  return pages;
}

// ----- Contract state detection -----

async function detectContractState(schema, pdfDoc, totalPages) {
  // If schema has no seller_acceptance phase items, no state detection needed
  const hasSellerPhase = schema.signature_locations.some(
    (loc) => loc.phase === 'seller_acceptance'
  );
  if (!hasSellerPhase) return 'all';

  // For RPA-like schemas: check page N-1 (signature page)
  // Page index is 0-based; "second to last" page = totalPages - 2
  const sigPageIndex = totalPages - 2;
  if (sigPageIndex < 0) return 'offer_only';

  const pageBase64 = await singlePagePdfBase64(pdfDoc, sigPageIndex);

  const prompt = `You are examining the signature page of a California Residential Purchase Agreement (RPA).

Look at this page and determine the current state of the contract by examining two things:
1. The Seller signature block (Section 33). Are the seller signature lines filled with actual signatures, OR are they blank?
2. The "Seller Counter Offer (C.A.R. Form SCO or SMCO)" checkbox in Section 33A. Is it checked?

Return ONLY a JSON object with this exact structure (no other text, no markdown code fences):
{
  "seller_signed": true | false,
  "counter_offer_checked": true | false,
  "state": "offer_only" | "counter_pending" | "fully_executed",
  "confidence": "high" | "medium" | "low"
}

State logic:
- seller_signed is true → "fully_executed"
- seller_signed is false AND counter_offer_checked is true → "counter_pending"
- Otherwise → "offer_only"`;

  try {
    const response = await callClaude(prompt, pageBase64);
    const parsed = parseJsonResponse(response);
    return parsed.state || 'offer_only';
  } catch (err) {
    console.error('State detection error:', err);
    return 'offer_only'; // safe default
  }
}

// ----- Check expansion -----

function expandChecks(schema, totalPages, state, buyerCount, sellerCount) {
  const checks = [];

  for (const loc of schema.signature_locations) {
    // Phase filtering
    if (state === 'offer_only' && loc.phase === 'seller_acceptance') continue;
    // (counter_pending and fully_executed both include seller_acceptance items)

    const pages = resolvePages(loc.page_scope, totalPages);
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
    // Agents and other roles: keep for now (could refine later)
    return true;
  });
}

// ----- Per-check execution -----

async function runCheck(pdfDoc, check) {
  const pageBase64 = await singlePagePdfBase64(pdfDoc, check.page - 1);

  const prompt = `You are auditing a single page of a California real estate contract for the presence of a specific mark.

LOCATION TO CHECK: ${check.locationDescription}
PARTY: ${check.party}
MARK TYPE: ${check.markType}

Determine whether ${check.party}'s ${check.markType} is present at that location on this page.

CRITICAL GUIDANCE:
- "signature": Look for an actual handwritten signature OR a DocuSign-style image stamp. A typed/printed name in the signature line area without an actual signature glyph is NOT a signature — that is "absent".
- "initial": Look for handwritten initials OR a DocuSign initial stamp in the specified box.
- "date": Look for a written date next to the signature/initial location.
- If the expected line/box is NOT VISIBLE on this page (form variant, trimmed page), return "not_applicable".
- Bias toward flagging. If unsure, return "unclear" — never default to "present" when uncertain.

Return ONLY a JSON object with this exact structure (no other text, no markdown code fences):
{
  "status": "present" | "absent" | "unclear" | "not_applicable",
  "confidence": "high" | "medium" | "low",
  "reasoning": "one-sentence explanation of what you observed"
}`;

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

// ----- PDF helper -----

async function singlePagePdfBase64(sourceDoc, pageIndex) {
  const newDoc = await PDFDocument.create();
  const [copied] = await newDoc.copyPages(sourceDoc, [pageIndex]);
  newDoc.addPage(copied);
  const bytes = await newDoc.save();
  return Buffer.from(bytes).toString('base64');
}

// ----- Claude API -----

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

// ----- Summary -----

function summarize(results) {
  const summary = {
    present: 0,
    absent: 0,
    unclear: 0,
    not_applicable: 0,
    error: 0,
    missingItems: [],
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
  }

  return summary;
}
