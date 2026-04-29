const https = require('https');

const PS_API_KEY = process.env.PS_API_KEY;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const options = { hostname: opts.hostname, path: opts.pathname + opts.search, headers };
    https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const payload = JSON.stringify(body);
    const options = {
      hostname: opts.hostname, path: opts.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

exports.handler = async function(event, context) {
  try {
    const headers = { 'X-API-KEY': PS_API_KEY, 'Content-Type': 'application/json' };

    // Step 1 — test basic API connection
    console.log('Testing PS API connection...');
    const testResp = await httpsGet('https://public-api.process.st/api/v1/templates', headers);
    console.log('PS API status:', testResp.status);
    console.log('PS API body (first 500 chars):', testResp.body.slice(0, 500));

    // Send raw result to Slack so we can see it
    await httpsPost(SLACK_WEBHOOK, {
      text: '*Keeva Debug* — PS API status: ' + testResp.status + '\n```' + testResp.body.slice(0, 500) + '```'
    });

    return { statusCode: 200, body: 'Debug info sent to Slack' };

  } catch(err) {
    console.error('Error:', err.message);
    try {
      await httpsPost(SLACK_WEBHOOK, { text: '⚠️ *Keeva debug error:* ' + err.message });
    } catch(e) {}
    return { statusCode: 500, body: err.message };
  }
};
