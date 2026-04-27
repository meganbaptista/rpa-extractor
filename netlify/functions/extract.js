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

    // ── AIRTABLE PROXY ────────────────────────────────────────────────────────
    if (body.airtable_table) {
      const AT_TOKEN = process.env.AIRTABLE_TOKEN;
      const AT_BASE  = process.env.AIRTABLE_BASE_ID || 'appZ9ucNHFtNRNQMg';

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

    // Build content array from uploaded documents
    const documents = body.documents || [];
    const content = [];

    documents.forEach(doc => {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: doc.data },
        title: doc.label
      });
    });

    content.push({
      type: 'text',
      text: 'Extract all of the following fields from the uploaded documents. Cross-reference all documents to fill gaps. Return ONLY valid JSON with exactly these keys, no preamble, no markdown: {"property_address":"","date_of_acceptance":"","emd_due_date":"","emd_amount":"","close_of_escrow_date":"","loan_contingency_date":"","appraisal_contingency_date":"","inspection_contingency_date":"","seller_disclosures_due_date":"","sprp_date":"","cop_date":"","date_rpa_prepared":"","final_purchase_price":"","buyer_agent_commission_amount":"","seller_credit_referenced":"","is_all_cash":"","home_warranty":"","home_warranty_who_pays":"","home_warranty_amount":"","home_warranty_company":"","buyer_names":"","seller_names":"","apn":"","sqft_structure":"","sqft_lot":"","county":"","city":"","zip_code":"","mls_number":"","year_built":"","buyer_agent_name":"","buyer_agent_dre":"","buyer_agent_brokerage_name":"","buyer_agent_brokerage_dre":"","buyer_agent_address":"","buyer_agent_email":"","buyer_agent_phone":"","seller_agent_name":"","seller_agent_dre":"","seller_agent_brokerage_name":"","seller_agent_brokerage_dre":"","seller_agent_address":"","seller_agent_email":"","seller_agent_phone":"","escrow_company":"","escrow_officer_name":"","title_company":"","hoa_fee":"","hoa_name":"","property_type":""}. Use ISO format YYYY-MM-DD for all dates. Leave fields as empty string if not found.'
    });

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
