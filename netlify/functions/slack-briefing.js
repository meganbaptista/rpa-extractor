const https = require('https');

exports.handler = async function(event, context) {
  const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
  console.log('Handler started. SLACK_WEBHOOK set:', !!SLACK_WEBHOOK);

  try {
    const url = new URL(SLACK_WEBHOOK);
    const payload = JSON.stringify({ text: 'Keeva test — function is alive!' });

    await new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { console.log('Slack response:', res.statusCode, data); resolve(); });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    return { statusCode: 200, body: 'Hello sent to Slack!' };
  } catch(err) {
    console.error('Error:', err.message);
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
