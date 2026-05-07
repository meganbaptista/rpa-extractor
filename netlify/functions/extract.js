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

    // ── RLA / CUSTOM PROMPT PATH (unchanged JSON-text behavior) ───────────────
    if (body.prompt_override) {
      content.push({ type: 'text', text: body.prompt_override });

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
    }

    // ── RPA PATH: TOOL USE (structured outputs) ───────────────────────────────
    // Each field is defined as a tool parameter with its own description.
    // The model fills each field with the field's description in active context,
    // which dramatically improves accuracy on commonly-missed fields like
    // date_rpa_prepared and buyer_agent_*.

    const FIELDS = {
      // ─── PROPERTY ─────────────────────────────────────────────────────────
      property_address: {
        type: "string",
        description: "Full property address INCLUDING street, city, state, and ZIP — combined into a single string. Priority source order: (1) Property Profile Report header (e.g. '650 Harbor St #4, Venice, CA 90291-4785, Los Angeles County' → return '650 Harbor St #4, Venice, CA 90291' or include the +4 if present); (2) MLS Listing header; (3) RPA paragraph 1B as last resort — agents sometimes mistype street type, e.g. 'Drive' vs 'Terrace'. CRITICAL: when pulling from the property profile, use the FULL address from the header — NOT just the street line. The property profile header always includes city, state, and ZIP on the same line as the street; combine them. Do NOT return only '650 Harbor Street Unit 4' when the full address '650 Harbor St #4, Venice, CA 90291' is available. If a city/state/ZIP is shown elsewhere on page 1 of the property profile (e.g. in 'Tax Billing City & State'), use those to complete the address. Empty string only if no source has the address."
      },
      apn: { type: "string", description: "Assessor's Parcel Number from RPA page 1 paragraph 1B or property profile. Empty string if not found." },
      county: { type: "string", description: "County name. Proper case." },
      city: { type: "string", description: "City name. Proper case." },
      zip_code: { type: "string", description: "5-digit ZIP code." },
      year_built: { type: "string", description: "Year structure was built, from MLS or property profile." },
      property_type: {
        type: "string",
        description: "Use PROP SUB TYPE from MLS or Type from Property Profile. NEVER derive from contract form name. Valid values: SFR, Condo, Probate, Revocable Trust, Vacant Land, Mobile Home, New Construction, Commercial, Duplex, Triplex, Quadruplex."
      },

      // ─── SQUARE FOOTAGE — return ONLY numeric values, never the field label ─
      sqft_structure: {
        type: "string",
        description: "Building square footage from the Property Profile Report ONLY. Find the 'Building Sq Ft' row in the CHARACTERISTICS section on page 2 (NOT the 'MLS Sq Ft' summary box on page 1). RETURN ONLY THE VALUE — do NOT include the field label 'Building Sq Ft:'. Example: source shows 'Building Sq Ft: 2,888' → return '2,888'. EXCEPTION: if the property profile shows BOTH a tax-recorded value AND an MLS value distinctly (e.g. 'Tax: 1,666 / MLS: 6,087'), return both with their qualifying labels: 'Tax: 1,666 MLS: 6,087'. Empty string if no property profile is provided."
      },
      sqft_lot: {
        type: "string",
        description: "Lot size from the Property Profile Report ONLY. Find the 'Lot Area' row in the CHARACTERISTICS section. RETURN ONLY THE NUMERIC VALUE — do NOT include the field label 'Lot Area:'. Example: source shows 'Lot Area: 8,712' → return '8,712'. Empty string if no property profile is provided."
      },

      // ─── DATES ────────────────────────────────────────────────────────────
      date_rpa_prepared: {
        type: "string",
        description: "ISO date (YYYY-MM-DD) of the RPA. The ONLY valid source is the literal label 'Date Prepared:' (with the colon) at the top-left of page 1 of the original purchase agreement (RPA / VLPA / RIPA / CPA). Confirm you are on page 1 by checking the footer for 'RPA REVISED 12/25 (PAGE 1 OF 17)' or similar. CRITICAL — DO NOT use any of these (every one of these is a known wrong-source error): the 'Date' field at the top of a Buyer Counter Offer (BCO), the 'Date' field at the top of a Seller Counter Offer (SCO), any signature/acceptance date, paragraph 33 acceptance date, the DocuSign envelope timestamp in the document header, or the property-address-line date that appears on pages 2-17 of the RPA. The label 'Date Prepared:' appears EXACTLY ONCE in the entire document set, on RPA page 1 only. If you cannot locate the literal label 'Date Prepared:', return empty string — do NOT substitute any other date."
      },
      date_of_acceptance: { type: "string", description: "ISO date (YYYY-MM-DD) the last party signed the FINAL accepted document — that is, the latest counter offer if any exist, otherwise the original RPA acceptance in paragraph 33." },
      emd_due_date: { type: "string", description: "Earnest money deposit due date in ISO format. Calculated from RPA paragraph 3D(1) ('within 3 business days after Acceptance' by default)." },
      emd_amount: { type: "string", description: "Initial deposit dollar amount from RPA paragraph 3D(1), e.g. '39,000' or '39000.00'." },
      close_of_escrow_date: { type: "string", description: "ISO date for COE from RPA paragraph 3B (either days-after-acceptance calculated, or specific date)." },
      loan_contingency_date: { type: "string", description: "ISO date for loan contingency removal per RPA paragraph 3L(1). Empty if 'No loan contingency' is checked." },
      appraisal_contingency_date: { type: "string", description: "ISO date for appraisal contingency removal per RPA paragraph 3L(2). Empty if 'No appraisal contingency' is checked." },
      inspection_contingency_date: { type: "string", description: "ISO date for investigation/inspection contingency per RPA paragraph 3L(3)." },
      seller_disclosures_due_date: { type: "string", description: "ISO date Seller must deliver disclosures per RPA paragraph 3N(1)." },
      sprp_date: { type: "string", description: "Seller Purchase of Replacement Property contingency date if SPRP addendum attached. Empty if not applicable." },
      cop_date: { type: "string", description: "Sale of Buyer's Property contingency date if COP addendum attached. Empty if not applicable." },

      // ─── PRICE & FINANCIAL ────────────────────────────────────────────────
      final_purchase_price: { type: "string", description: "Final agreed purchase price. Use the LATEST counter offer price (BCO or SCO) if any exist; otherwise use RPA paragraph 3A. Numeric only, e.g. '1315000' or '1,315,000'." },
      buyer_agent_commission_amount: { type: "string", description: "Buyer's broker compensation from RPA paragraph 3G(3). Either percentage (e.g. '2.5%') or fixed amount (e.g. '$15,000')." },
      seller_credit_referenced: { type: "string", description: "Yes/No. 'Yes' if any Seller credit to Buyer is referenced in paragraph 3G(1) or 3G(2); 'No' otherwise." },
      is_all_cash: { type: "string", description: "Yes/No. 'Yes' if 'All Cash' box is checked in RPA paragraph 3A; 'No' if a loan amount is specified." },

      // ─── HOME WARRANTY ────────────────────────────────────────────────────
      home_warranty: { type: "string", description: "Yes/No. 'Yes' if home warranty is included per RPA paragraph 3Q(18); 'No' if 'Buyer waives home warranty plan' is checked." },
      home_warranty_who_pays: { type: "string", description: "'Buyer', 'Seller', or 'Both' per RPA paragraph 3Q(18). Empty if waived." },
      home_warranty_amount: { type: "string", description: "Dollar cap on Seller's contribution to home warranty per paragraph 3Q(18) (e.g. '800.00'). Empty if not specified or waived." },
      home_warranty_company: { type: "string", description: "Issuer/company name from paragraph 3Q(18) 'Issued by:' field. Empty if not specified." },

      // ─── BUYER ────────────────────────────────────────────────────────────
      buyer_names: { type: "string", description: "Buyer name(s). The ONLY valid source is the 'THIS IS AN OFFER FROM ___' line on page 1 of the RPA (paragraph 1A). Do NOT use property profile (that's the seller), MLS, or anywhere else. PRESERVE the exact separator used in the source document — if buyers are listed with commas (e.g. 'John Smith, Jane Smith'), return them with commas. Do not change commas to ' and ' or vice versa. Mirror the source formatting exactly." },

      // ─── SELLER ───────────────────────────────────────────────────────────
      seller_names: {
        type: "string",
        description: "Seller name(s). NEVER blank — if seller is an entity, copy the entity name in here too. Priority: (1) Property Profile Report 'Owner Name', (2) MLS owner field, (3) RPA paragraph 33 Acceptance signatures (use the actual signed/printed name, NOT the printed label like 'Owner of Record'). If seller is 'Basad LLC' → seller_names: 'Basad LLC'. PRESERVE the exact separator used in the source document — if sellers are listed with commas (e.g. 'John Doe, Jane Doe'), return them with commas. Do not change commas to ' and ' or vice versa. Mirror the source formatting exactly."
      },
      seller_entity_name: { type: "string", description: "Full legal entity name if seller is a trust, LLC, estate, or corporation. Empty string if seller is an individual." },
      seller_type: { type: "string", description: "Exactly one of: Individual, Trust, LLC, Estate, Power of Attorney. Default to Individual if unclear." },
      seller_signer_1: { type: "string", description: "First actual human signer on the seller side (real person, not entity name). From paragraph 33." },
      seller_signer_2: { type: "string", description: "Second human signer. Empty if only one." },
      seller_signer_3: { type: "string", description: "Third human signer. Empty if not applicable." },
      seller_signer_4: { type: "string", description: "Fourth human signer. Empty if not applicable." },
      trust_full_name: { type: "string", description: "Full legal trust name if seller is a trust. Empty otherwise." },
      trust_date: { type: "string", description: "Date trust was established (ISO format if known). Empty otherwise." },

      // ─── MLS ──────────────────────────────────────────────────────────────
      mls_number: { type: "string", description: "MLS Listing ID from the MLS document (e.g. 'OC25196571'). NOT the APN. Empty if no MLS provided." },
      mls_list_price: { type: "string", description: "Current list price from MLS LIST PRICE field." },
      mls_list_date: { type: "string", description: "ISO date from MLS LIST CONTRACT DATE or ON MARKET DATE." },

      // ─── BUYER AGENT — LAST PAGE OF RPA ONLY ───────────────────────────────
      buyer_agent_name: {
        type: "string",
        description: "Buyer's primary agent name. Source: ONLY the LAST PAGE of the RPA (e.g. 'PAGE 17 OF 17'), titled 'REAL ESTATE BROKERS SECTION', subsection A 'Buyer's Brokerage Firm'. The agent name is the printed name on the FIRST 'By' line under that subsection. NEVER source from: page 1 paragraph 2 (Agency Confirmation) — that section confuses brokerage DRE with agent DRE; the MLS (MLS only has seller agents); the property profile; or the BRBC (Buyer Representation Agreement is a separate document and may name a different agent than the one who actually wrote this offer). Example: line reads 'By Jack Lopez   DRE Lic. # 02150816   Date 05/03/2026' → return 'Jack Lopez'."
      },
      buyer_agent_dre: {
        type: "string",
        description: "Buyer's primary agent INDIVIDUAL DRE license number from the FIRST 'By' line in subsection A on the LAST PAGE of the RPA. This is the individual agent's DRE, NOT the brokerage's DRE (the brokerage DRE sits on a different line, next to the firm name). CRITICAL: subsection B 'Seller's Brokerage Firm' sits directly below subsection A on the same page with an identical layout. DO NOT pull this DRE from subsection B — that is the seller's agent DRE, a completely different number. The buyer agent DRE you want is on the line directly under 'A. Buyer's Brokerage Firm'. Example: 'By Jack Lopez   DRE Lic. # 02150816' → return '02150816'."
      },
      buyer_agent_name_2: {
        type: "string",
        description: "Second buyer agent name from the SECOND 'By' line in subsection A on the LAST PAGE of the RPA. Empty string if that line is blank or unsigned. CRITICAL: if the checkbox 'More than one agent from the same firm represents Buyer' is marked (X or checked) in subsection A, then there ARE two agents and you MUST populate this field — do not leave it blank when the checkbox is marked. DO NOT pull this from subsection B (Seller's Brokerage Firm)."
      },
      buyer_agent_dre_2: { type: "string", description: "Second buyer agent's DRE on the SECOND 'By' line in subsection A. Empty if no second agent. If buyer_agent_name_2 is populated, this MUST be populated too. DO NOT pull from subsection B." },
      buyer_agent_brokerage_name: { type: "string", description: "Buyer's brokerage firm name from the 'Buyer's Brokerage Firm' line in subsection A on the LAST PAGE of the RPA. CRITICAL: subsection B 'Seller's Brokerage Firm' is directly below on the same page and has its own brokerage name (the listing brokerage) — that is NOT the buyer's brokerage. The buyer's brokerage name appears on the line that begins 'A. Buyer's Brokerage Firm'. Example: 'A. Buyer's Brokerage Firm Anvil Real Estate' → return 'Anvil Real Estate'." },
      buyer_agent_brokerage_dre: { type: "string", description: "Brokerage DRE on the SAME LINE as the buyer brokerage firm name in subsection A (NOT the agent's line). DO NOT pull from subsection B (Seller's Brokerage Firm) — that is the seller's brokerage DRE, a different number. The buyer brokerage DRE is on the same line as the firm named in subsection A. Example: 'A. Buyer's Brokerage Firm Anvil Real Estate   DRE Lic. # 02014153' → return '02014153'." },
      buyer_agent_address: { type: "string", description: "Buyer agent OFFICE STREET ADDRESS from subsection A on the LAST PAGE of the RPA. The Address line sits between the 'By' lines and the Email line. Combine the Address + City + State + Zip into one string. CRITICAL: this field is a STREET ADDRESS, never a phone number — if you find yourself returning digits like '949-707-4400', that is a phone number and is wrong. The address line begins with the label 'Address' followed by a street, then 'City', 'State', 'Zip'. DO NOT pull from subsection B — that is the seller agent's office address. Example: source shows 'Address 23046 Avenida De La Carlota, Ste 600   City Laguna Hills   State CA   Zip 92653-1537' → return '23046 Avenida De La Carlota, Ste 600, Laguna Hills, CA 92653-1537'." },
      buyer_agent_email: {
        type: "string",
        description: "Buyer agent email from subsection A on the LAST PAGE of the RPA. The email line sits BETWEEN the Address line and the checkbox lines, and SHARES the line with 'Phone #'. The line reads: 'Email name@domain.com   Phone # (xxx) xxx-xxxx'. NEVER source from CCPA pages, broker compensation forms, advisories, the document footer, or any other 'Email' label outside subsection A. CRITICAL: subsection B (Seller's Brokerage Firm) on the same page also has an Email line — DO NOT use that one, that is the seller agent's email. The buyer agent email is in the upper half of the page under 'A. Buyer's Brokerage Firm'. Example: 'Email jack@century21ontarget.com' → return 'jack@century21ontarget.com'. CRITICAL: if you successfully extracted buyer_agent_phone, the email is on the SAME line — they appear together. Never return one without the other when an agent is filled in."
      },
      buyer_agent_phone: { type: "string", description: "Buyer agent phone from subsection A, on the SAME line as buyer_agent_email, after 'Phone #'. DO NOT pull from subsection B — that is the seller agent's phone. Example: '(562) 431-2011'." },

      // ─── SELLER AGENT ──────────────────────────────────────────────────────
      seller_agent_name: { type: "string", description: "Seller agent name. Priority: (1) MLS Listing Agent (LA) — combine with CoLA as 'LA Name / CoLA Name' if both present; (2) RPA page 1 paragraph 2 'Seller's Agent' line; (3) RPA last page subsection B. NEVER use property profile for seller agent (that's historical listing data and may be from a previous sale)." },
      seller_agent_dre: { type: "string", description: "Seller agent individual DRE. Combine as 'DRE1 / DRE2' if two listing agents. Same priority as seller_agent_name." },
      seller_agent_brokerage_name: { type: "string", description: "Seller's brokerage/listing office name. Priority: (1) MLS LO (Listing Office) — if a CoLO (Co-Listing Office) is also present AND it's a DIFFERENT brokerage than LO, combine as 'LO Name / CoLO Name'. If LO and CoLO are the same brokerage, just return the single name. (2) RPA fallback. Example with two different brokerages: LO='Berkshire Hathaway' and CoLO='Compass' → return 'Berkshire Hathaway / Compass'. Example with same brokerage on both: just 'Berkshire Hathaway'." },
      seller_agent_brokerage_dre: { type: "string", description: "Seller brokerage DRE. Priority: (1) MLS LO State License — if a CoLO State License is also present AND from a DIFFERENT brokerage, combine as 'LO_DRE / CoLO_DRE' matching the order used in seller_agent_brokerage_name. If LO and CoLO are the same brokerage, just return the single DRE. (2) RPA last page subsection B same-line-as-firm-name DRE. Example: '01317331 / 01991628'. NOT the agent's individual DRE." },
      seller_agent_address: { type: "string", description: "Seller agent office address." },
      seller_agent_email: { type: "string", description: "Primary listing agent email. Use LA EMAIL from MLS if available, otherwise Offers Email." },
      seller_agent_email_2: { type: "string", description: "Co-listing agent email (CoLA EMAIL from MLS). Empty if no co-listing agent." },
      seller_agent_phone: { type: "string", description: "Seller agent phone number." },

      // ─── ESCROW / TITLE / HOA ─────────────────────────────────────────────
      escrow_company: { type: "string", description: "Escrow holder/company from RPA paragraph 3Q(7) 'Escrow Holder:' field. May be 'Seller's Choice' or 'Buyer's Choice' if not yet selected." },
      escrow_officer_name: { type: "string", description: "Named escrow officer if specified. Empty if not yet assigned." },
      title_company: { type: "string", description: "Title company from RPA paragraph 3Q(8). May be 'Seller's Choice' if same as escrow." },
      hoa_fee: { type: "string", description: "Monthly HOA fee if disclosed. Empty if not applicable or not disclosed." },
      hoa_name: { type: "string", description: "HOA name if disclosed. Empty if not applicable." }
    };

    const extractionTool = {
      name: "extract_contract_fields",
      description: "Extract structured fields from a California real estate purchase agreement package. The package may include the original purchase agreement (RPA, VLPA, RIPA, or CPA — all use the same structure), counter offers (BCO, SCO), addenda, MLS listing, and property profile report. Cross-reference all documents to fill gaps. Each field below has its own specific extraction rules — read each field's description carefully before populating it. Normalize all text to proper case (never ALL CAPS). Use empty string for any field not found.",
      input_schema: {
        type: "object",
        properties: FIELDS,
        required: Object.keys(FIELDS)
      }
    };

    // Build content for the main extraction call.
    const mainContent = [...content, {
      type: 'text',
      text: 'Extract all required fields from the attached California real estate purchase agreement package by calling the extract_contract_fields tool. Read each field description carefully — they contain specific source-priority and disambiguation rules.'
    }];

    const callApi = (msgContent, tool) => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        tools: [tool],
        tool_choice: { type: "tool", name: tool.name },
        messages: [{ role: 'user', content: msgContent }]
      })
    }).then(r => r.json());

    const findToolUse = (resp) => Array.isArray(resp.content)
      ? resp.content.find(b => b.type === 'tool_use')
      : null;

    // ─── MAIN CALL ────────────────────────────────────────────────────────────
    // Always runs. Extracts all 60 fields.
    const mainData = await callApi(mainContent, extractionTool);
    const mainTool = findToolUse(mainData);
    let mergedFields = mainTool && mainTool.input ? { ...mainTool.input } : {};

    // ─── TARGETED CALL — CONDITIONAL ──────────────────────────────────────────
    // Only fire if the main call missed any of the high-failure fields.
    // This means small/normal contracts pay one API call; only the contracts
    // that genuinely need the targeted help pay for two. Big contracts that
    // succeed on the first pass don't risk the function timeout.
    const TARGETED_FIELD_NAMES = [
      'date_rpa_prepared',
      'buyer_agent_name',
      'buyer_agent_dre',
      'buyer_agent_brokerage_name',
      'buyer_agent_brokerage_dre',
      'buyer_agent_address',
      'buyer_agent_email',
      'buyer_agent_phone'
      // buyer_agent_name_2 and _dre_2 intentionally NOT in the trigger list —
      // they're legitimately empty when only one agent signs, so an empty
      // value here doesn't mean the main call failed.
    ];

    const mainCallMissedFields = TARGETED_FIELD_NAMES.some(fieldName => {
      const value = mergedFields[fieldName];
      return !value || value.trim() === '';
    });

    if (mainCallMissedFields) {
      const TARGETED_FIELDS = {
        date_rpa_prepared: FIELDS.date_rpa_prepared,
        buyer_agent_name: FIELDS.buyer_agent_name,
        buyer_agent_dre: FIELDS.buyer_agent_dre,
        buyer_agent_name_2: FIELDS.buyer_agent_name_2,
        buyer_agent_dre_2: FIELDS.buyer_agent_dre_2,
        buyer_agent_brokerage_name: FIELDS.buyer_agent_brokerage_name,
        buyer_agent_brokerage_dre: FIELDS.buyer_agent_brokerage_dre,
        buyer_agent_address: FIELDS.buyer_agent_address,
        buyer_agent_email: FIELDS.buyer_agent_email,
        buyer_agent_phone: FIELDS.buyer_agent_phone
      };

      const targetedTool = {
        name: "extract_targeted_fields",
        description: "Extract a small set of fields from a California real estate purchase agreement package. You have ONE job: locate two specific pages and extract from them. (1) Find page 1 of the original RPA/VLPA/RIPA/CPA — identifiable by the literal label 'Date Prepared:' at the top-left and the footer 'PAGE 1 OF 17' or similar — and extract the date next to that label. (2) Find the LAST PAGE of the same RPA — identifiable by the 'REAL ESTATE BROKERS SECTION' header and the footer 'PAGE 17 OF 17' or similar — and extract everything from subsection A 'Buyer's Brokerage Firm'. Both pages exist in the package. The RPA is always present. Read each field description carefully and return values directly from those two pages.",
        input_schema: {
          type: "object",
          properties: TARGETED_FIELDS,
          required: Object.keys(TARGETED_FIELDS)
        }
      };

      const targetedContent = [...content, {
        type: 'text',
        text: `Your task is narrow and specific. The attached package contains a California real estate purchase agreement (RPA / VLPA / RIPA / CPA). Find these two pages in the document set and extract from them by calling the extract_targeted_fields tool:

• Page 1 of the RPA — top-left contains the literal text "Date Prepared:" followed by a date. The footer on this page reads "RPA REVISED 12/25 (PAGE 1 OF 17)" or similar variant. Extract the date for date_rpa_prepared.

• Last page of the RPA (typically PAGE 17 OF 17) — titled "REAL ESTATE BROKERS SECTION". This page contains TWO subsections that look almost identical:

  ┌─────────────────────────────────────────────────────────┐
  │ A. Buyer's Brokerage Firm  [BUYER firm]    DRE # [...]  │  ← extract from HERE
  │    By [BUYER agent 1]                      DRE # [...]  │  ← extract from HERE
  │    By [BUYER agent 2 if any]               DRE # [...]  │  ← extract from HERE
  │    Address [BUYER office addr]  City  State  Zip        │  ← extract from HERE
  │    Email [BUYER agent email]    Phone # [BUYER phone]   │  ← extract from HERE
  │    ☐ More than one agent from the same firm...          │
  ├─────────────────────────────────────────────────────────┤
  │ B. Seller's Brokerage Firm [SELLER firm]   DRE # [...]  │  ← DO NOT use this
  │    By [SELLER agent 1]                     DRE # [...]  │  ← DO NOT use this
  │    Address [SELLER office addr] City State Zip          │  ← DO NOT use this
  │    Email [SELLER email]         Phone # [SELLER phone]  │  ← DO NOT use this
  └─────────────────────────────────────────────────────────┘

EVERY buyer_agent_* field MUST come from subsection A only. Subsection B is the seller's information and is a trap — it has the same field labels (DRE, Address, Email, Phone) but the values are completely different people. A common failure mode is correctly identifying subsection A for the agent name, then drifting into subsection B for the remaining fields. Do not do this. Re-anchor on "A. Buyer's Brokerage Firm" before each field.

The buyer_agent_address field is a STREET ADDRESS like "23046 Avenida De La Carlota, Ste 600, Laguna Hills, CA 92653" — never a phone number. If you are about to return digits like "949-707-4400" for an address, stop and re-read the Address line in subsection A.

The RPA is always present in the package. If you have already located these two pages, the values are clearly visible — do not return empty strings unless a field is genuinely blank on the page itself.`
      }];

      try {
        const targetedData = await callApi(targetedContent, targetedTool);
        const targetedToolBlock = findToolUse(targetedData);

        if (targetedToolBlock && targetedToolBlock.input) {
          for (const [key, value] of Object.entries(targetedToolBlock.input)) {
            // Targeted call wins ONLY if it produced a non-empty value.
            // Never overwrite a main-call success with a targeted-call empty.
            if (value && value.trim() !== '') {
              mergedFields[key] = value;
            }
          }
        }
      } catch (targetedErr) {
        // If the targeted call fails for any reason, we still have the main
        // call's results. Better to return partial data than to fail entirely.
        console.error('Targeted call failed, using main call results only:', targetedErr.message);
      }
    }

    if (Object.keys(mergedFields).length > 0) {
      // Reshape to match the caller's existing parsing: data.content[0].text
      // is the JSON string of all fields, exactly as before.
      const reshaped = {
        ...mainData,
        content: [{ type: 'text', text: JSON.stringify(mergedFields) }]
      };
      return { statusCode: 200, headers, body: JSON.stringify(reshaped) };
    }

    // Fallback: return raw main response if main tool call didn't produce output.
    return { statusCode: 200, headers, body: JSON.stringify(mainData) };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: { message: err.message } })
    };
  }
};
