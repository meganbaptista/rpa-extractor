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
    const extractionPrompt = body.prompt_override || `The purchase agreement may be a C.A.R. RPA, VLPA, RIPA, or other California purchase agreement form — all follow the same structure, so treat them identically. Extract all of the following fields from the uploaded documents. Cross-reference all documents to fill gaps. Return ONLY valid JSON with exactly these keys, no preamble, no markdown:
{"property_address":"","date_of_acceptance":"","emd_due_date":"","emd_amount":"","close_of_escrow_date":"","loan_contingency_date":"","appraisal_contingency_date":"","inspection_contingency_date":"","seller_disclosures_due_date":"","sprp_date":"","cop_date":"","date_rpa_prepared":"","final_purchase_price":"","buyer_agent_commission_amount":"","seller_credit_referenced":"","is_all_cash":"","home_warranty":"","home_warranty_who_pays":"","home_warranty_amount":"","home_warranty_company":"","buyer_names":"","seller_names":"","seller_entity_name":"","seller_type":"","seller_signer_1":"","seller_signer_2":"","seller_signer_3":"","seller_signer_4":"","trust_full_name":"","trust_date":"","apn":"","sqft_structure":"","sqft_lot":"","county":"","city":"","zip_code":"","mls_number":"","mls_list_price":"","mls_list_date":"","year_built":"","buyer_agent_name":"","buyer_agent_dre":"","buyer_agent_brokerage_name":"","buyer_agent_brokerage_dre":"","buyer_agent_address":"","buyer_agent_email":"","buyer_agent_phone":"","seller_agent_name":"","seller_agent_dre":"","seller_agent_brokerage_name":"","seller_agent_brokerage_dre":"","seller_agent_address":"","seller_agent_email":"","seller_agent_email_2":"","seller_agent_phone":"","escrow_company":"","escrow_officer_name":"","title_company":"","hoa_fee":"","hoa_name":"","property_type":""}

Important rules:

PROPERTY ADDRESS (highest priority source order — use the first source that has it):
1. Property Profile Report — always the most accurate source for the property address. Use it if present.
2. MLS Listing — use the address from the listing header.
3. RPA — only use as last resort. Agents sometimes mistype the street type (e.g. "Drive" instead of "Terrace"). Never prefer the RPA address over the property profile or MLS.

SELLER NAME (highest priority source order — use the first source that has it):
1. Property Profile Report "Owner Name" field — this is always the most accurate source. Use it if present.
2. MLS Listing seller/owner name field.
3. RPA paragraph 33 Acceptance section — only use as last resort. Do NOT use the printed label text (e.g. "Owner of Record") — only use the actual handwritten or DocuSigned name value.

BUYER AGENT INFO (source: RPA ONLY — never use the MLS for buyer agent info):
- The buyer agent is ALWAYS in the RPA, never in the MLS. The MLS only contains seller/listing agent info.
- Primary source: RPA page 1, paragraph 2 Agency section — "Buyer's Brokerage Firm" and "Buyer's Agent" lines.
- Secondary source: RPA Real Estate Brokers Section (last page, Section A "Buyer's Brokerage Firm") — the first signed "By" line. If two agents appear, use the first one.
- buyer_agent_brokerage_name: firm name on the "Buyer's Brokerage Firm" line in the RPA.
- buyer_agent_brokerage_dre: DRE Lic. # or License Number next to the buyer brokerage firm name in the RPA.
- buyer_agent_name: agent's full name from the "Buyer's Agent" line (page 1) or the first signed "By" line under Section A (last page) of the RPA.
- buyer_agent_dre: DRE Lic. # or License Number next to the buyer agent name in the RPA.
- buyer_agent_address: Address field in the buyer's brokerage section on the last page of the RPA.
- buyer_agent_email: Email field in the buyer's brokerage section on the last page of the RPA.
- buyer_agent_phone: Phone # field in the buyer's brokerage section on the last page of the RPA.

SELLER AGENT INFO (priority source order — use the first source that has it):
1. MLS Listing Agent/Office section (most accurate) — look for LA (Listing Agent) and CoLA (Co-Listing Agent) fields. If both are present, combine as "LA Name / CoLA Name" for seller_agent_name and "LA DRE / CoLA DRE" for seller_agent_dre. Use LO (Listing Office) for brokerage name and LO State License for brokerage DRE.
2. RPA page 1, paragraph 2 Agency section — "Seller's Brokerage Firm" and "Seller's Agent" lines. The License Number next to "Seller's Brokerage Firm" is the seller_agent_brokerage_dre. The License Number next to "Seller's Agent" is the seller_agent_dre.
3. RPA Real Estate Brokers Section (last page, section B "Seller's Brokerage Firm") — the DRE Lic. # printed on the same line as the brokerage firm name is the seller_agent_brokerage_dre. The DRE Lic. # on the "By" agent line is the seller_agent_dre.
- seller_agent_name: agent's full name (or "Agent 1 / Agent 2" if two listing agents).
- seller_agent_dre: agent's individual DRE license number (or "DRE1 / DRE2" if two listing agents).
- seller_agent_brokerage_name: brokerage/office name.
- seller_agent_brokerage_dre: the brokerage's DRE license number — this is on the same line as the brokerage firm name, NOT the agent's line. Do not confuse agent DRE with brokerage DRE.
- seller_agent_address: agent's office address.
- seller_agent_email: primary listing agent's email address (use LA EMAIL from MLS if available, otherwise Offers Email).
- seller_agent_email_2: co-listing agent's email address (use CoLA EMAIL from MLS if available). Leave empty if no co-listing agent or no CoLA email found.
- seller_agent_phone: agent's phone number.

MLS FIELDS:
- mls_number: use the Listing ID field from the MLS (e.g. "OC25196571"). Do not use the APN or any other number.
- mls_list_price: the current list price from the MLS listing header or LIST PRICE field.
- mls_list_date: use the LIST CONTRACT DATE or ON MARKET DATE from the MLS. Use ISO format YYYY-MM-DD.

DATE RULES:
- date_rpa_prepared: ALWAYS use the "Date Prepared" field at the top of page 1 of the RPA only. Never pull this from a counter offer, addendum, or any other document.
- date_of_acceptance: the date the seller signed or accepted the offer, found in the RPA acceptance section or a counter offer acceptance date.
- All dates must be in ISO format YYYY-MM-DD.

SELLER ENTITY RULES:
- For seller_entity_name: if the seller is a trust, LLC, estate or other entity, put the full legal entity name here. Leave empty if seller is an individual.
- For seller_names: always populate this field. If the seller is an individual, use their full name. If the seller is an entity (trust, LLC, estate etc.), copy the entity name here as well so this field is never blank.
- For seller_type: use exactly one of these values — Individual, Trust, LLC, Estate, Power of Attorney. Default to Individual if unclear.
- For seller_signer_1 through seller_signer_4: list the actual human signers. These are the real people who sign, not the entity name.
- For trust_full_name: full legal name of the trust if applicable.
- For trust_date: date the trust was established if shown.

OTHER RULES:
- For buyer_names: ONLY use the "THIS IS AN OFFER FROM ___" line on page 1 of the RPA. Do not pull buyer names from the property profile, MLS, or any other source. The property profile owner is the SELLER, not the buyer.
- For sqft_structure: ALWAYS use the Property Profile Report. Find the row labeled "Building Sq Ft" in the Characteristics section and return the entire value cell contents verbatim — every number and label in that cell, nothing added, nothing removed. The property profile may show "Tax: 1,666 MLS: 6,087" or just "6,087" or "1,666" — whatever is in that cell, return it as-is. Do not interpret, do not select the larger or more recent number, do not reformat. Only use MLS or RPA if no property profile is provided.
- For sqft_lot: ALWAYS use the "Lot Area" field from the Property Profile Report. Copy the exact value as written. Only use MLS or RPA if no property profile is provided.
- For property_type: always use the PROP SUB TYPE field from the MLS listing or the Type field from the Property Profile report — never derive it from the contract form name. Valid values are: SFR, Condo, Probate, Revocable Trust, Vacant Land, Mobile Home, New Construction, Commercial, Duplex, Triplex, Quadruplex.
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
