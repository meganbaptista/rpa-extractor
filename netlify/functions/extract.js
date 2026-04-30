exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: { message: 'Method Not Allowed' } }) };
  }

  try {
    const body = JSON.parse(event.body);
    const AT_TOKEN = process.env.AIRTABLE_TOKEN;
    const AT_BASE  = process.env.AIRTABLE_BASE_ID || 'appZ9ucNHFtNRNQMg';

    // ── AIRTABLE SEARCH ───────────────────────────────────────────────────────
    if (body.airtable_search) {
      if (!AT_TOKEN) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'AIRTABLE_TOKEN not set' } }) };
      }
      const { table, field, value } = body.airtable_search;
      const formula = encodeURIComponent('LOWER({' + field + '})=LOWER("' + value.replace(/"/g, '') + '")');
      const searchResp = await fetch(
        'https://api.airtable.com/v0/' + AT_BASE + '/' + encodeURIComponent(table) + '?filterByFormula=' + formula + '&maxRecords=1',
        { headers: { 'Authorization': 'Bearer ' + AT_TOKEN } }
      );
      const searchData = await searchResp.json();
      return { statusCode: 200, headers, body: JSON.stringify(searchData) };
    }

    // ── AIRTABLE CREATE ───────────────────────────────────────────────────────
    if (body.airtable_table) {
      if (!AT_TOKEN) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'AIRTABLE_TOKEN not set' } }) };
      }
      const atResp = await fetch(
        'https://api.airtable.com/v0/' + AT_BASE + '/' + encodeURIComponent(body.airtable_table),
        {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + AT_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: body.fields })
        }
      );
      const atData = await atResp.json();
      return { statusCode: 200, headers, body: JSON.stringify(atData) };
    }

    // ── CLAUDE EXTRACTION ─────────────────────────────────────────────────────
    if (!process.env.ANTHROPIC_API_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY not set' } }) };
    }

    const documents = body.documents || [];
    const content = [];

    documents.forEach(doc => {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: doc.data },
        title: doc.label
      });
    });

    // Use custom prompt if provided (RLA), otherwise use default RPA prompt
    const extractionPrompt = body.prompt_override || `Extract all of the following fields from the uploaded documents. Cross-reference all documents to fill gaps. Return ONLY valid JSON with exactly these keys, no preamble, no markdown:
{"property_address":"","date_of_acceptance":"","emd_due_date":"","emd_amount":"","close_of_escrow_date":"","loan_contingency_date":"","appraisal_contingency_date":"","inspection_contingency_date":"","seller_disclosures_due_date":"","sprp_date":"","cop_date":"","date_rpa_prepared":"","final_purchase_price":"","buyer_agent_commission_amount":"","seller_credit_referenced":"","is_all_cash":"","home_warranty":"","home_warranty_who_pays":"","home_warranty_amount":"","home_warranty_company":"","buyer_names":"","seller_names":"","seller_entity_name":"","seller_type":"","seller_signer_1":"","seller_signer_2":"","seller_signer_3":"","seller_signer_4":"","trust_full_name":"","trust_date":"","apn":"","sqft_structure":"","sqft_lot":"","county":"","city":"","zip_code":"","mls_number":"","year_built":"","buyer_agent_name":"","buyer_agent_dre":"","buyer_agent_brokerage_name":"","buyer_agent_brokerage_dre":"","buyer_agent_address":"","buyer_agent_email":"","buyer_agent_phone":"","seller_agent_name":"","seller_agent_dre":"","seller_agent_brokerage_name":"","seller_agent_brokerage_dre":"","seller_agent_address":"","seller_agent_email":"","seller_agent_phone":"","escrow_company":"","escrow_officer_name":"","title_company":"","hoa_fee":"","hoa_name":"","property_type":""}

Important rules:

SELLER NAME (highest priority source order — use the first source that has it):
1. Property Profile Report "Owner Name" field — this is always the most accurate source. Use it if present.
2. MLS Listing seller/owner name field.
3. RPA paragraph 33 Acceptance section — only use as last resort. Do NOT use the printed label text (e.g. "Owner of Record") — only use the actual handwritten or DocuSigned name value.

BUYER AGENT INFO (two reliable sources — check both and use the clearest values):
- Primary source: RPA page 1, paragraph 2 Agency section — "Buyer's Brokerage Firm" and "Buyer's Agent" lines. These have the brokerage name, agent name, and license numbers clearly printed.
- Secondary source: RPA Real Estate Brokers Section (last page, Section A) — use the first signed "By" line for the agent name and DRE. If two agents appear on two "By" lines, use the first one.
- buyer_agent_brokerage_name: firm name on the "Buyer's Brokerage Firm" line.
- buyer_agent_brokerage_dre: DRE Lic. # or License Number next to the brokerage firm name.
- buyer_agent_name: agent's full name from the "Buyer's Agent" line (page 1) or the first signed "By" line (last page).
- buyer_agent_dre: DRE Lic. # or License Number next to the buyer agent name.
- buyer_agent_address: Address field in the buyer's brokerage section on the last page.
- buyer_agent_email: Email field in the buyer's brokerage section on the last page.
- buyer_agent_phone: Phone # field in the buyer's brokerage section on the last page.

SELLER AGENT INFO (priority source order — use the first source that has it):
1. MLS Listing — use the Agent and Office/Brokerage fields in the listing agent section. This is the preferred source.
2. RPA page 1, paragraph 2 Agency section — "Seller's Brokerage Firm" and "Seller's Agent" lines.
3. RPA Real Estate Brokers Section (last page, section B "Seller's Brokerage Firm") — use as last resort.
- seller_agent_name: agent's full name.
- seller_agent_dre: agent's DRE license number.
- seller_agent_brokerage_name: brokerage/office name.
- seller_agent_brokerage_dre: brokerage DRE license number.
- seller_agent_address: agent's office address.
- seller_agent_email: agent's email address.
- seller_agent_phone: agent's phone number.

DATE RULES:
- date_rpa_prepared: ALWAYS use the "Date Prepared" field at the top of page 1 of the RPA only. Never pull this from a counter offer, addendum, or any other document.
- date_of_acceptance: the date the seller signed or accepted the offer, found in the RPA acceptance section or a counter offer acceptance date.
- All dates must be in ISO format YYYY-MM-DD.

SELLER ENTITY RULES:
- For seller_entity_name: if the seller is a trust, LLC, estate or other entity, put the full legal entity name here. Leave empty if seller is an individual.
- For seller_type: use exactly one of these values — Individual, Trust, LLC, Estate, Power of Attorney. Default to Individual if unclear.
- For seller_signer_1 through seller_signer_4: list the actual human signers. These are the real people who sign, not the entity name.
- For trust_full_name: full legal name of the trust if applicable.
- For trust_date: date the trust was established if shown.

OTHER RULES:
- For buyer_names: ONLY use the "THIS IS AN OFFER FROM ___" line on page 1 of the RPA. Do not pull buyer names from the property profile, MLS, or any other source. The property profile owner is the SELLER, not the buyer.
- For sqft_structure and sqft_lot: pull the full line as it appears in the document.
- For property_type: always use the SUB TYPE field from the MLS listing or the Type field from the Property Profile report — never derive it from the contract form name. Valid values are: SFR, Condo, Probate, Revocable Trust, Vacant Land, Mobile Home, New Construction, Commercial, Duplex, Triplex, Quadruplex.
- Normalize all text to proper case — never return values in ALL CAPS even if the source document is in all caps.
- Leave any field as empty string if not found.`;

    content.push({ type: 'text', text: extractionPrompt });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content }]
      })
    });

    const data = await response.json();
    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: { message: err.message } })
    };
  }
};
