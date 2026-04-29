const https = require('https');

const PS_API_KEY = process.env.PS_API_KEY;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const WORKFLOW_NAME = 'ESCROW CHECKLIST';
const DATE_FIELDS = ['CLOSE OF ESCROW', 'CR - Inspection Due Date', 'Disclosures Received by Seller'];

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const options = { hostname: opts.hostname, path: opts.pathname + opts.search, headers };
    https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
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

function formatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
}

function daysFromNow(dateStr) {
  if (!dateStr) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const d = new Date(dateStr);
  d.setHours(0, 0, 0, 0);
  return Math.round((d - now) / (1000 * 60 * 60 * 24));
}

function urgencyEmoji(days) {
  if (days === null) return '';
  if (days < 0) return '🔴 OVERDUE';
  if (days === 0) return '🚨 TODAY';
  if (days === 1) return '⚠️ TOMORROW';
  if (days <= 3) return '🟠 ' + days + ' days';
  if (days <= 7) return '🟡 ' + days + ' days';
  return '🟢 ' + days + ' days';
}

exports.handler = async function(event, context) {
  try {
    // 1. Get all workflow runs for ESCROW CHECKLIST
    const headers = { 'Authorization': 'Bearer ' + PS_API_KEY, 'Content-Type': 'application/json' };

    // Get templates first to find ESCROW CHECKLIST id
    const templates = await httpsGet('https://api.process.st/api/v1/templates', headers);
    const template = (templates.data || templates).find(t => t.name === WORKFLOW_NAME);
    if (!template) throw new Error('Workflow "' + WORKFLOW_NAME + '" not found');

    // Get active runs for this template
    const runsResp = await httpsGet(
      'https://api.process.st/api/v1/workflow-runs?templateId=' + template.id + '&status=active',
      headers
    );
    const runs = runsResp.data || runsResp;
    if (!runs || !runs.length) {
      await httpsPost(SLACK_WEBHOOK, {
        text: '☀️ *Good morning, MTC team!* No active escrows found for today.'
      });
      return { statusCode: 200, body: 'No active runs' };
    }

    // 2. For each run, get its form fields
    const transactions = [];
    for (const run of runs) {
      try {
        const fieldsResp = await httpsGet(
          'https://api.process.st/api/v1/workflow-runs/' + run.id + '/form-fields',
          headers
        );
        const fields = fieldsResp.data || fieldsResp;
        const fieldMap = {};
        (fields || []).forEach(f => { fieldMap[f.label] = f.value; });

        // Get property address — try common field names
        const address = fieldMap['Property Address'] || fieldMap['PROPERTY ADDRESS'] ||
                        fieldMap['Address'] || fieldMap['address'] || run.name || 'Unknown Address';

        const coe = fieldMap['CLOSE OF ESCROW'];
        const inspection = fieldMap['CR - Inspection Due Date'];
        const disclosures = fieldMap['Disclosures Received by Seller'];

        transactions.push({ address, coe, inspection, disclosures });
      } catch(e) {
        console.error('Error fetching fields for run ' + run.id, e);
      }
    }

    // 3. Sort transactions — soonest COE first
    transactions.sort((a, b) => {
      const da = a.coe ? new Date(a.coe) : new Date('9999-12-31');
      const db = b.coe ? new Date(b.coe) : new Date('9999-12-31');
      return da - db;
    });

    // 4. Build Slack message
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles'
    });

    // Separate into urgent (due within 7 days) and upcoming
    const urgent = [];
    const upcoming = [];
    transactions.forEach(tx => {
      const coeDays = daysFromNow(tx.coe);
      const inspDays = daysFromNow(tx.inspection);
      const discDays = daysFromNow(tx.disclosures);
      const isUrgent = [coeDays, inspDays, discDays].some(d => d !== null && d <= 7);
      if (isUrgent) urgent.push(tx);
      else upcoming.push(tx);
    });

    let message = '☀️ *Good morning, MTC team!* Here\'s your daily escrow briefing for *' + today + '*\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    message += '*📋 Active Escrows: ' + transactions.length + '*\n\n';

    if (urgent.length > 0) {
      message += '*🚨 NEEDS ATTENTION THIS WEEK (' + urgent.length + ')*\n\n';
      urgent.forEach(tx => {
        message += '*' + tx.address + '*\n';
        if (tx.coe) {
          const days = daysFromNow(tx.coe);
          if (days !== null && days <= 7) message += '  🏁 COE: ' + formatDate(tx.coe) + ' — ' + urgencyEmoji(days) + '\n';
        }
        if (tx.inspection) {
          const days = daysFromNow(tx.inspection);
          if (days !== null && days <= 7) message += '  🔍 Inspection contingency: ' + formatDate(tx.inspection) + ' — ' + urgencyEmoji(days) + '\n';
        }
        if (tx.disclosures) {
          const days = daysFromNow(tx.disclosures);
          if (days !== null && days <= 7) message += '  📄 Seller disclosures: ' + formatDate(tx.disclosures) + ' — ' + urgencyEmoji(days) + '\n';
        }
        message += '\n';
      });
    }

    if (upcoming.length > 0) {
      message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      message += '*📅 UPCOMING CLOSINGS*\n\n';
      upcoming.forEach(tx => {
        message += '*' + tx.address + '*\n';
        if (tx.coe) message += '  🏁 COE: ' + formatDate(tx.coe) + ' — ' + urgencyEmoji(daysFromNow(tx.coe)) + '\n';
        if (tx.inspection) message += '  🔍 Inspection: ' + formatDate(tx.inspection) + '\n';
        if (tx.disclosures) message += '  📄 Disclosures: ' + formatDate(tx.disclosures) + '\n';
        message += '\n';
      });
    }

    message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    message += '_Have a great day! — Keeva 🏡_';

    await httpsPost(SLACK_WEBHOOK, { text: message });

    return { statusCode: 200, body: 'Briefing sent! ' + transactions.length + ' transactions.' };

  } catch(err) {
    console.error('Briefing error:', err);
    // Notify Slack of error too
    try {
      await httpsPost(SLACK_WEBHOOK, {
        text: '⚠️ *Keeva daily briefing failed:* ' + err.message
      });
    } catch(e) {}
    return { statusCode: 500, body: err.message };
  }
};
