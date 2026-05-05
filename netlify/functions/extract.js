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
    const extractionPrompt = body.prompt_override || `You are extracting fields from a California real estate purchase agreement package. The package may include the original purchase agreement (RPA, VLPA, RIPA, or CPA) plus counter offers (BCO, SCO), addenda, MLS listings, and property profile reports.

Return ONLY valid JSON with exactly the keys shown in the schema below. No preamble, no markdown, no commentary.

══════════════════════════════════════════════════════════════
TWO HIGH-PRIORITY FIELDS — READ THESE RULES BEFORE ANY OTHERS
══════════════════════════════════════════════════════════════

▼ FIELD: date_rpa_prepared

The ONLY valid source is the literal text "Date Prepared:" (with the colon) found at the top-left of page 1 of the original purchase agreement (RPA / VLPA / RIPA / CPA).

How to find it:
1. Scan every page in the document set for the exact label "Date Prepared:"
2. Confirm you are on page 1 of the RPA by checking the footer — it will read "RPA REVISED 12/25 (PAGE 1 OF 17)" or similar (VLPA / RIPA / CPA equivalents are also valid).
3. The date value sits immediately next to or directly below the "Date Prepared:" label.
4. Convert to ISO format YYYY-MM-DD.

DO NOT use any of these (common errors):
✗ The "Date" field at the top of a Buyer Counter Offer (BCO) — that label is "Date", not "Date Prepared:"
✗ The "Date" field at the top of a Seller Counter Offer (SCO) — same reason
✗ Any signature date next to a "By" or "Buyer" or "Seller" line
✗ The acceptance date in paragraph 33
✗ The date stamped in the document header by DocuSign
✗ The date in the property address line at the top of pages 2-17 of the RPA

If "Date Prepared:" cannot be located on any page, return empty string. Do not substitute another date.

EXAMPLE — for the contract attached, the RPA page 1 shows:
"Date Prepared: April 27, 2026"
→ date_rpa_prepared: "2026-04-27"

▼ FIELDS: buyer_agent_name, buyer_agent_dre, buyer_agent_name_2, buyer_agent_dre_2, buyer_agent_brokerage_name, buyer_agent_brokerage_dre, buyer_agent_address, buyer_agent_email, buyer_agent_phone

The ONLY valid source is the LAST PAGE of the RPA / VLPA / RIPA / CPA. This page is titled "REAL ESTATE BROKERS SECTION" and is the final numbered page (e.g. "PAGE 17 OF 17").

DO NOT extract buyer agent fields from:
✗ Page 1 of the RPA (paragraph 2 "Agency Confirmation") — this section conflates brokerage DRE and agent DRE and is a known source of errors
✗ The MLS listing — MLS only has SELLER agent info, never buyer agent
✗ The property profile report — never has buyer info
✗ The Buyer Representation Agreement (BRBC) — this is a separate listing-style document and may name a different agent than the one who actually wrote the offer

The "REAL ESTATE BROKERS SECTION" has two subsections labeled "A." and "B.":
• Subsection A is "Buyer's Brokerage Firm" → use ONLY this for buyer fields
• Subsection B is "Seller's Brokerage Firm" → do NOT use for buyer fields

Subsection A is laid out exactly like this:

  A. Buyer's Brokerage Firm  [FIRM_NAME]                          DRE Lic. # [BROKERAGE_DRE]
     By [AGENT_1_NAME]                                            DRE Lic. # [AGENT_1_DRE]   Date [...]
     By [AGENT_2_NAME]                                            DRE Lic. # [AGENT_2_DRE]   Date [...]
     Address [STREET]              City [CITY]                    State [ST]   Zip [ZIP]
     Email [EMAIL]                                                Phone # [PHONE]
     ☐ More than one agent from the same firm represents Buyer.

Extract as follows:
• buyer_agent_brokerage_name  ← firm name on the "Buyer's Brokerage Firm" line
• buyer_agent_brokerage_dre   ← DRE Lic. # on the SAME line as the brokerage firm name
• buyer_agent_name            ← printed name on the FIRST "By" line
• buyer_agent_dre             ← DRE Lic. # on the FIRST "By" line (this is the agent's INDIVIDUAL DRE, not the brokerage DRE)
• buyer_agent_name_2          ← printed name on the SECOND "By" line — leave empty string if that line is blank or unsigned
• buyer_agent_dre_2           ← DRE Lic. # on the SECOND "By" line — leave empty string if no second agent
• buyer_agent_address         ← combine street + city + state + zip into one string
• buyer_agent_email           ← the email address that appears on the line starting with "Email" inside subsection A. This line sits BETWEEN the Address line and the checkbox lines, and shares the line with "Phone #". It will look like "Email name@domain.com   Phone # (xxx) xxx-xxxx". You MUST extract this — it is never blank when an agent is filled in. Do NOT pull email from any other section (CCPA, advisories, broker compensation forms, brokerage footer). Only the one inside subsection A on the last page.
• buyer_agent_phone           ← phone number on the SAME line as the email, after "Phone #"

REMINDER: buyer_agent_email and buyer_agent_phone come from the SAME physical line. If you successfully extracted the phone, the email is on that same line — do not return empty for one and not the other.

CRITICAL CHECKBOX HINT: When the "More than one agent from the same firm represents Buyer" checkbox is marked (X or checked), there ARE two agents and you MUST populate buyer_agent_name_2 and buyer_agent_dre_2. If you see two filled "By" lines but leave the _2 fields blank, that is a bug.

EXAMPLE 1 — extraction with two agents:
"A. Buyer's Brokerage Firm Rodeo Realty, Inc. - Beverly Hills    DRE Lic. # 00951359
    By Jennifer Perez                                            DRE Lic. # 02125070   Date 4/27/2026
    By Jimmy Heckenberg                                          DRE Lic. # 01910100   Date 4/27/2026
    Address 202 N. Canon Dr.   City Beverly Hills   State CA   Zip 90210
    Email j.perez@rodeore.com                                    Phone # (818) 299-3880
    [X] More than one agent from the same firm represents Buyer."

→ buyer_agent_brokerage_name: "Rodeo Realty, Inc. - Beverly Hills"
→ buyer_agent_brokerage_dre:  "00951359"
→ buyer_agent_name:           "Jennifer Perez"
→ buyer_agent_dre:            "02125070"
→ buyer_agent_name_2:         "Jimmy Heckenberg"
→ buyer_agent_dre_2:          "01910100"
→ buyer_agent_address:        "202 N. Canon Dr., Beverly Hills, CA 90210"
→ buyer_agent_email:          "j.perez@rodeore.com"
→ buyer_agent_phone:          "(818) 299-3880"

EXAMPLE 2 — extraction with one agent (showing email/phone pairing):
"A. Buyer's Brokerage Firm Century 21 On Target                  DRE Lic. # 01257829
    By Jack Lopez                                                DRE Lic. # 02150816   Date 05/03/2026
    By                                                           DRE Lic. #            Date
    Address 5515 E. Stearns St.   City Long Beach   State CA   Zip 90815
    Email jack@century21ontarget.com                             Phone # (562) 431-2011"

→ buyer_agent_brokerage_name: "Century 21 On Target"
→ buyer_agent_brokerage_dre:  "01257829"
→ buyer_agent_name:           "Jack Lopez"
→ buyer_agent_dre:            "02150816"
→ buyer_agent_name_2:         ""
→ buyer_agent_dre_2:          ""
→ buyer_agent_address:        "5515 E. Stearns St., Long Beach, CA 90815"
→ buyer_agent_email:          "jack@century21ontarget.com"
→ buyer_agent_phone:          "(562) 431-2011"

══════════════════════════════════════════════════════════════
JSON SCHEMA (return EXACTLY these keys)
══════════════════════════════════════════════════════════════

{"property_address":"","date_of_acceptance":"","emd_due_date":"","emd_amount":"","close_of_escrow_date":"","loan_contingency_date":"","appraisal_contingency_date":"","inspection_contingency_date":"","seller_disclosures_due_date":"","sprp_date":"","cop_date":"","date_rpa_prepared":"","final_purchase_price":"","buyer_agent_commission_amount":"","seller_credit_referenced":"","is_all_cash":"","home_warranty":"","home_warranty_who_pays":"","home_warranty_amount":"","home_warranty_company":"","buyer_names":"","seller_names":"","seller_entity_name":"","seller_type":"","seller_signer_1":"","seller_signer_2":"","seller_signer_3":"","seller_signer_4":"","trust_full_name":"","trust_date":"","apn":"","sqft_structure":"","sqft_lot":"","county":"","city":"","zip_code":"","mls_number":"","mls_list_price":"","mls_list_date":"","year_built":"","buyer_agent_name":"","buyer_agent_dre":"","buyer_agent_name_2":"","buyer_agent_dre_2":"","buyer_agent_brokerage_name":"","buyer_agent_brokerage_dre":"","buyer_agent_address":"","buyer_agent_email":"","buyer_agent_phone":"","seller_agent_name":"","seller_agent_dre":"","seller_agent_brokerage_name":"","seller_agent_brokerage_dre":"","seller_agent_address":"","seller_agent_email":"","seller_agent_email_2":"","seller_agent_phone":"","escrow_company":"","escrow_officer_name":"","title_company":"","hoa_fee":"","hoa_name":"","property_type":""}

══════════════════════════════════════════════════════════════
REMAINING FIELD RULES
══════════════════════════════════════════════════════════════

PROPERTY ADDRESS — priority source order:
1. Property Profile Report — most accurate, use if present
2. MLS Listing header
3. RPA page 1 — last resort only (agents sometimes mistype the street type, e.g. "Drive" instead of "Terrace")

SELLER NAME — priority source order:
1. Property Profile Report "Owner Name" field — most accurate, use if present
2. MLS Listing seller/owner name field
3. RPA paragraph 33 Acceptance section — last resort. Do NOT use the printed label text (e.g. "Owner of Record"); only use the actual handwritten or DocuSigned name value.

CRITICAL: seller_names must NEVER be empty. If the seller is an entity (LLC, trust, estate), copy the entity name into seller_names. Example: seller is "Basad LLC" → seller_names: "Basad LLC", seller_entity_name: "Basad LLC".

SELLER AGENT INFO — priority source order:
IMPORTANT: Do NOT use the property profile report for seller agent info — it contains historical listing data that may be from a previous sale.
1. MLS Listing Agent/Office section (most accurate) — look for LA (Listing Agent) and CoLA (Co-Listing Agent) fields. If both are present, combine as "LA Name / CoLA Name" for seller_agent_name and "LA DRE / CoLA DRE" for seller_agent_dre. Use LO (Listing Office) for brokerage name and LO State License for brokerage DRE.
2. RPA page 1, paragraph 2 Agency section — "Seller's Brokerage Firm" and "Seller's Agent" lines. The License Number next to "Seller's Brokerage Firm" is the seller_agent_brokerage_dre. The License Number next to "Seller's Agent" is the seller_agent_dre.
3. RPA Real Estate Brokers Section (last page, subsection B "Seller's Brokerage Firm") — same line-by-line layout as buyer subsection A described above, but for the seller side.

• seller_agent_name: agent's full name (or "Agent 1 / Agent 2" if two listing agents).
• seller_agent_dre: agent's individual DRE (or "DRE1 / DRE2" if two listing agents).
• seller_agent_brokerage_name: brokerage/office name.
• seller_agent_brokerage_dre: brokerage's DRE — same line as the brokerage firm name, NOT the agent's line.
• seller_agent_address: agent's office address.
• seller_agent_email: primary listing agent's email (use LA EMAIL from MLS if available, otherwise Offers Email).
• seller_agent_email_2: co-listing agent's email (use CoLA EMAIL from MLS if available); empty if no co-listing agent.
• seller_agent_phone: agent's phone number.

MLS FIELDS:
• mls_number: use the Listing ID from the MLS (e.g. "OC25196571"). Do not use APN or any other number.
• mls_list_price: current list price from the MLS listing header or LIST PRICE field.
• mls_list_date: use the LIST CONTRACT DATE or ON MARKET DATE from the MLS. ISO format YYYY-MM-DD.

DATE RULES:
• date_of_acceptance: the date the last party signed the final counter offer or original agreement — whichever is the final accepted document.
• All dates must be in ISO format YYYY-MM-DD.

SELLER ENTITY RULES:
• seller_entity_name: if the seller is a trust, LLC, estate, or other entity, put the full legal entity name here. Empty if seller is an individual.
• seller_names: NEVER blank. If individual, use full name. If entity, copy entity name in.
• seller_type: exactly one of — Individual, Trust, LLC, Estate, Power of Attorney. Default to Individual if unclear.
• seller_signer_1 through seller_signer_4: the actual human signers — real people, not the entity name.
• trust_full_name: full legal name of the trust if applicable.
• trust_date: date the trust was established if shown.

OTHER RULES:
• buyer_names: ONLY use the "THIS IS AN OFFER FROM ___" line on page 1 of the RPA. Do not pull from property profile, MLS, or anywhere else. The property profile owner is the SELLER, not the buyer.
• sqft_structure: use ONLY the Property Profile Report. Find the "Building Sq Ft" row in the CHARACTERISTICS section (page 2) — NOT the "MLS Sq Ft" summary box on page 1. Return value exactly as written including all labels (e.g. "Tax: 1,666 MLS: 6,087"). Empty if no property profile.
• sqft_lot: use ONLY the Property Profile Report. Find the "Lot Area" row in the CHARACTERISTICS section. Empty if no property profile.
• property_type: always use the PROP SUB TYPE field from the MLS or the Type field from the Property Profile — never derive from the contract form name. Valid values: SFR, Condo, Probate, Revocable Trust, Vacant Land, Mobile Home, New Construction, Commercial, Duplex, Triplex, Quadruplex.
• Normalize all text to proper case — never return values in ALL CAPS even if the source is in all caps.
• Leave any field as empty string if not found.`;

    content.push({ type: 'text', text: extractionPrompt });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2500,
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
