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
    // If the request includes an airtable_table field, proxy it to Airtable
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
        system: 'You are a real estate transaction coordinator specializing in California residential purchase agreements. Extract field values precisely as written in the documents. If a field is not found, return an empty string. Return ONLY a valid JSON object — no markdown, no backticks, no explanation.',
        messages: body.messages
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
