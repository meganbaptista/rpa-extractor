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
    const req = https.request({
      hostname: opts.hostname, path: opts.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
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
  console.log('PS_API_KEY:', PS_API_KEY ? PS_API_KEY.slice(0,8) + '...' : 'NOT SET');

  const BASE = 'https://public-api.process.st/api/v1/templates';

  // Try format 1: X-API-KEY header
  const r1 = await httpsGet(BASE, { 'X-API-KEY': PS_API_KEY });
  console.log('X-API-KEY result:', r1.status, r1.body.slice(0,100));

  // Try format 2: Authorization Bearer
  const r2 = await httpsGet(BASE, { 'Authorization': 'Bearer ' + PS_API_KEY });
  console.log('Bearer result:', r2.status, r2.body.slice(0,100));

  // Try format 3: Authorization with just the key
  const r3 = await httpsGet(BASE, { 'Authorization': PS_API_KEY });
  console.log('Auth key result:', r3.status, r3.body.slice(0,100));

  const msg = '*PS API Auth Test*\n' +
    '1. X-API-KEY: ' + r1.status + ' — ' + r1.body.slice(0,80) + '\n\n' +
    '2. Bearer: ' + r2.status + ' — ' + r2.body.slice(0,80) + '\n\n' +
    '3. Auth key: ' + r3.status + ' — ' + r3.body.slice(0,80);

  await httpsPost(SLACK_WEBHOOK, { text: msg });
  return { statusCode: 200, body: 'Auth test sent to Slack' };
};
