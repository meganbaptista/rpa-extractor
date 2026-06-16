// netlify/functions/lib/rpa-fields.js
//
// SINGLE SOURCE OF TRUTH for the RPA extraction field schema. Required by both
// extract.js (legacy /extract endpoint, external/Zapier callers) and
// extract-background.js (the live submit->poll worker). Kept here so a field
// change can never again go live in one path but not the other.
//
// Pure data: no requires, no closure dependencies -> esbuild bundles it cleanly
// into each function. Lives in lib/ so Netlify does not treat it as a function.

const FIELDS = {
      // ─── PROPERTY ─────────────────────────────────────────────────────────
      property_address: {
        type: "string",
        description: "Full property address as a single string: street, city, state, and 5-DIGIT ZIP only — e.g. '5071 Shirley Ave, Tarzana, CA 91356'. Priority source order: (1) Property Profile Report header; (2) MLS Listing header; (3) RPA paragraph 1B as last resort — agents sometimes mistype street type, e.g. 'Drive' vs 'Terrace'. CRITICAL — FORMAT RULES (apply to whichever source you use): (a) 5-DIGIT ZIP ONLY. If the source shows a ZIP+4 extension (e.g. '91356-4427'), DROP the '-4427' and return just '91356'. (b) NO COUNTY. The property profile header often appends the county after the ZIP (e.g. '650 Harbor St #4, Venice, CA 90291-4785, Los Angeles County') — return '650 Harbor St #4, Venice, CA 90291' with NO county name and NO +4 extension. (c) Use the FULL street + city + state + ZIP from the header — NOT just the street line. Do NOT return only '650 Harbor Street Unit 4' when the full address '650 Harbor St #4, Venice, CA 90291' is available. If a city/state/ZIP is shown elsewhere on page 1 of the property profile (e.g. in 'Tax Billing City & State'), use those to complete the address. Empty string only if no source has the address."
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
      buyer_names: { type: "string", description: "CRITICAL ANTI-SWAP RULE: The buyer is the party listed on the 'THIS IS AN OFFER FROM ___' line on RPA paragraph 1A (page 1) — the party making the offer to purchase. The buyer is NEVER the current property owner from the Property Profile. If the name you are about to return matches the Property Profile's 'Owner Name' or 'Owner Name 2' field, STOP — that name is the seller. Re-read RPA paragraph 1A and return the OFFER FROM party instead.\n\nSOURCE: The ONLY valid source is the 'THIS IS AN OFFER FROM ___' line on page 1 of the RPA (paragraph 1A). Do NOT use property profile (that's the seller), MLS, or anywhere else.\n\nENTITY BUYERS: An entity (trust, LLC, estate, corporation) can be the BUYER — do NOT assume entities are always sellers. If the 'THIS IS AN OFFER FROM' line, or RPA paragraph 32B 'ENTITY BUYERS', names an entity, copy the full entity name into buyer_names (e.g. 'Beckman Family Trust dated February 18, 1993'). Entity names are not in Last-First order and do not need rebuilding. The individual trustees/members who sign on the entity's behalf go in buyer_signer_1..4, NOT here.\n\nPRESERVE the exact separator used in the source document — if buyers are listed with commas (e.g. 'John Smith, Jane Smith'), return them with commas. Do not change commas to ' and ' or vice versa. Mirror the source formatting exactly." },
      buyer_entity_name: { type: "string", description: "Full legal entity name if the BUYER is a trust, LLC, estate, or corporation. Source: RPA paragraph 32B 'ENTITY BUYERS' Full entity name field, or the paragraph 1A 'THIS IS AN OFFER FROM' line. Empty string if the buyer is an individual. NEVER source from the property profile — the buyer is not the owner of record." },
      buyer_type: { type: "string", description: "Exactly one of: Individual, Trust, LLC, Estate, Power of Attorney — for the BUYER. Default to Individual if unclear. Determine from the CONTRACT only: RPA paragraph 32B 'ENTITY BUYERS' box and the paragraph 1A offer-from name. If 1A names a trust or paragraph 32B is completed as a trust → 'Trust'; if the name ends in 'LLC' → 'LLC'; 'Estate of' → 'Estate'; etc. NEVER infer buyer_type from the property profile — the buyer is the party making the offer, not the owner of record. An entity can be the buyer; do not assume entities are sellers." },
      buyer_signer_1: { type: "string", description: "First actual human signer on the BUYER side (a real person, not the entity name). For an entity buyer, this is the first Legally Authorized Signer from RPA paragraph 32B (e.g. a trustee). For an individual buyer, the first buyer. Empty if not applicable." },
      buyer_signer_2: { type: "string", description: "Second human signer on the buyer side. Empty if only one." },
      buyer_signer_3: { type: "string", description: "Third human signer on the buyer side. Empty if not applicable." },
      buyer_signer_4: { type: "string", description: "Fourth human signer on the buyer side. Empty if not applicable." },
      buyer_1: {
        type: "string",
        description: `First buyer, split out for downstream systems that need one buyer per field. ONE HUMAN OR ONE ENTITY PER SLOT. Source: the RPA paragraph 1A "THIS IS AN OFFER FROM" line (and paragraph 32B for the full entity name). These names are already in natural First-Last order — do NOT rebuild them like the courthouse Last-First seller fields.

SPLITTING RULES:
• Individual buyers listed together like 'James Gann, Camila Gann' or 'James & Camila Gann' → one person per slot: buyer_1: 'James Gann', buyer_2: 'Camila Gann'. A ',' or '&' between names means SEPARATE PEOPLE.
• Couple sharing a surname like 'Nick & Marina Avedissian' → buyer_1: 'Nick Avedissian', buyer_2: 'Marina Avedissian' (append the shared surname to each).

ENTITY BUYERS: an entity (LLC, trust, estate, corporation) is ONE legal buyer that fills exactly ONE slot regardless of how many trustees or members it has. buyer_1 = the FULL entity name, and buyer_2..4 are empty. NEVER split an entity name on its internal commas — a trust name often contains a comma in its date. Example: 'Beckman Family Trust dated February 18, 1993' → buyer_1: 'Beckman Family Trust dated February 18, 1993', buyer_2..4 empty. The individual trustees/members who sign on the entity's behalf are captured in buyer_signer_1 through buyer_signer_4, NOT here.

buyer_1 must NEVER be blank — at minimum the primary buyer goes here.` },
      buyer_2: { type: "string", description: "Second buyer, one human or entity per slot. See buyer_1 description for splitting rules. Empty string if there is only one buyer (including any single entity buyer)." },
      buyer_3: { type: "string", description: "Third buyer, one human or entity per slot. See buyer_1 description for splitting rules. Empty string if there are fewer than three buyers." },
      buyer_4: { type: "string", description: "Fourth buyer, one human or entity per slot. See buyer_1 description for splitting rules. Empty string if there are fewer than four buyers." },

      // ─── SELLER ───────────────────────────────────────────────────────────
      seller_names: {
        type: "string",
        description: `CRITICAL ANTI-SWAP RULE: The seller is the current property owner shown in the Property Profile's 'Owner Name' and 'Owner Name 2' fields. The seller is NEVER the party in 'THIS IS AN OFFER FROM ___' on RPA paragraph 1A — that's the buyer. If the name you are about to return matches the OFFER FROM line on the RPA, STOP — that's the buyer. Use the Property Profile owner instead.

Seller name(s) in natural First-Last order, NEVER blank. PRIORITY 1: when a Property Profile Report is provided, the 'Owner Name' and 'Owner Name 2' fields are the authoritative source — but they are in courthouse 'Last First' order and MUST be rebuilt to natural 'First Last' order. DO NOT use the 'Mail Owner Name' field even though it appears to be in the right order — it sometimes silently omits co-owners with different last names. Always rebuild from Owner Name and Owner Name 2.

REBUILD RULES:
• Single name: 'Walters Shauna' → 'Shauna Walters'. The first word is the surname; everything after is the given name(s).
• Couple sharing surname: 'Avedissian Nick & Marina' → 'Nick & Marina Avedissian'. Surname is first word; the remainder describes one or more given names joined with '&' or ','.
• With middle initial: 'Wingard Joseph A' → 'Joseph A Wingard'.
• Two Owner Name fields with same surname (e.g. Owner Name 'Wingard Joseph A' + Owner Name 2 'Wingard Susan L'): combine as 'Joseph A & Susan L Wingard'.
• Two Owner Name fields with DIFFERENT surnames (e.g. 'Avedissian Nick & Marina' + 'Derian Michael R & Rina'): rebuild each independently and join with ' & ' between them: 'Nick & Marina Avedissian & Michael R & Rina Derian'. NEVER drop a co-owner just because the surname differs.

COURTHOUSE CODES: County records sometimes append codes in parentheses like '(Te)' for trustee, '(Tr)' for trustee, '(JT)' for joint tenants, '(TC)' for tenants in common, '(Et Al)' meaning 'and others'. PRESERVE these codes in the rebuilt name in their original position relative to the person they describe. Example: 'Grinberg Benjamin (Te) & Ellen' → 'Benjamin (Te) & Ellen Grinberg'. The code stays attached to the same given name it was attached to in the source.

EDGE CASES: For names with particles like 'de la' or 'van der', or hyphenated surnames, the surname may be more than one word. Use judgment based on capitalization and common patterns — e.g. 'De La Cruz Maria' → 'Maria De La Cruz'.

PRIORITY 2 (only if no Property Profile): use MLS owner field. PRIORITY 3 (only if no profile and no MLS): use RPA paragraph 33 acceptance signatures (the actual signed/printed names, NOT the printed label like 'Owner of Record').

ENTITY SELLERS: If seller is an entity (LLC, trust, estate, corporation), copy the full entity name into seller_names. Example: seller is 'Basad LLC' → seller_names: 'Basad LLC'. Entity names do not need rebuilding since they are not in Last-First order.

PRESERVE the exact separator used in the source document for entity-vs-entity or co-owner separation — if source uses commas, use commas; if source uses '&', use '&'. Mirror the source formatting exactly. seller_names must NEVER be blank.`
      },
      seller_entity_name: { type: "string", description: "Full legal entity name if seller is a trust, LLC, estate, or corporation. Empty string if seller is an individual." },
      seller_type: { type: "string", description: "Exactly one of: Individual, Trust, LLC, Estate, Power of Attorney. Default to Individual if unclear. SIGNAL FROM PROPERTY PROFILE: county records sometimes append courthouse codes in the Owner Name field that indicate ownership form. If you see '(Tr)' or '(Te)' or 'Trustee' next to a name → seller_type is 'Trust'. If you see '(LLC)' or the name itself ends in 'LLC' → seller_type is 'LLC'. If you see 'Estate of' or '(Et Al)' alone (without a trust indicator) → consider 'Estate'. These codes from the property profile are reliable signals. If the seller name is a clear entity (e.g. 'Basad LLC', 'Smith Family Trust'), match accordingly even without explicit codes." },
      seller_signer_1: { type: "string", description: "First actual human signer on the seller side (real person, not entity name). From paragraph 33." },
      seller_signer_2: { type: "string", description: "Second human signer. Empty if only one." },
      seller_signer_3: { type: "string", description: "Third human signer. Empty if not applicable." },
      seller_signer_4: { type: "string", description: "Fourth human signer. Empty if not applicable." },
      seller_1: {
        type: "string",
        description: `First seller, split out for downstream systems that need one seller per field. ONE HUMAN OR ONE ENTITY PER SLOT.

Splitting rule for property profile sources (rebuilt from Owner Name fields):
• Single owner like 'Walters Shauna' → seller_1: 'Shauna Walters'.
• Couple sharing surname like 'Avedissian Nick & Marina' → seller_1: 'Nick Avedissian', seller_2: 'Marina Avedissian'. The '&' between two given names means TWO DISTINCT PEOPLE who happen to share a surname — they go in separate slots, each with the full surname appended.
• Owner Name + Owner Name 2 with same surname like 'Wingard Joseph A' + 'Wingard Susan L' → seller_1: 'Joseph A Wingard', seller_2: 'Susan L Wingard'.
• Two Owner Name fields with different surnames like 'Avedissian Nick & Marina' + 'Derian Michael R & Rina' → seller_1: 'Nick Avedissian', seller_2: 'Marina Avedissian', seller_3: 'Michael R Derian', seller_4: 'Rina Derian'. Up to 4 humans across all owner fields.
• Courthouse codes stay attached: 'Grinberg Benjamin (Te) & Ellen' → seller_1: 'Benjamin Grinberg (Te)', seller_2: 'Ellen Grinberg'.

ENTITIES: an entity (LLC, trust, estate, corporation) is ONE legal seller that fills exactly ONE slot regardless of how many trustees or members it has. Examples: 'Basad LLC' → seller_1: 'Basad LLC'. 'Smith Family Trust' → seller_1: 'Smith Family Trust'. The trustees who sign on behalf of the entity are captured in seller_signer_1 through seller_signer_4, NOT here.

If no Property Profile is provided, fall back to MLS or RPA paragraph 33 signatures, applying the same one-human-per-slot rule to whatever source you're using. seller_1 must NEVER be blank — at minimum the primary seller goes here.`
      },
      seller_2: { type: "string", description: "Second seller, one human or entity per slot. See seller_1 description for splitting rules. Empty string if there is only one seller." },
      seller_3: { type: "string", description: "Third seller, one human or entity per slot. See seller_1 description for splitting rules. Empty string if there are fewer than three sellers." },
      seller_4: { type: "string", description: "Fourth seller, one human or entity per slot. See seller_1 description for splitting rules. Empty string if there are fewer than four sellers." },
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
      seller_agent_name: { type: "string", description: "Seller agent name. Priority: (1) MLS Listing Agent (LA) — combine with CoLA as 'LA Name / CoLA Name' if both present; (2) RPA last page subsection B 'Seller's Brokerage Firm' — the first 'By' line. Do NOT use the RPA page 1 paragraph 2 'Seller's Agent' line: in dual-agency deals its agency checkboxes muddy which agent is on which side, so the page-17 brokers section is the authoritative source. NEVER use property profile for seller agent (that's historical listing data and may be from a previous sale)." },
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

module.exports = { FIELDS };
