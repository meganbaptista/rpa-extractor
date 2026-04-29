const https = require('https');

const PS_API_KEY = process.env.PS_API_KEY;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const WORKFLOW_NAME = 'ESCROW CHECKLIST';

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const options = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      headers
    };
    https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 300))); }
      });
    }).on('error', reject);
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const payload = JSON.stringify(body);
    const options = {
      hostname: opts.hostname,
      path: opts.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
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
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    timeZone: 'America/Los_Angeles'
  });
}

function daysFromNow(dateStr) {
  if (!dateStr) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  d.setHours(0, 0, 0, 0);
  return Math.round((d - now) / (1000 * 60 * 60 * 24));
}

function urgencyLabel(days) {
  if (days === null) return '';
  if (days < 0) return '🔴 OVERDUE by ' + Math.abs(days) + ' day(s)';
  if (days === 0) return '🚨 TODAY';
  if (days === 1) return '⚠️ TOMORROW';
  if (days <= 3) return '🟠 In ' + days + ' days';
  if (days <= 7) return '🟡 In ' + days + ' days';
  return '🟢 In ' + days + ' days';
}

exports.handler = async function(event, context) {
  try {
    const headers = {
      'X-API-KEY': PS_API_KEY,
      'Content-Type': 'application/json'
    };

    // 1. Get all checklists (workflow runs) for ESCROW CHECKLIST template
    // First find the template
    const templatesResp = await httpsGet('https://public-api.process.st/api/v1/templates', headers);
    const templates = templatesResp.data || templatesResp;
    const template = Array.isArray(templates)
      ? templates.find(t => t.name === WORKFLOW_NAME)
      : null;

    if (!template) {
      // Log what we got to help debug
      throw new Error('Template "' + WORKFLOW_NAME + '" not found. Available: ' +
        JSON.stringify((Array.isArray(templates) ? templates : []).map(t => t.name)));
    }

    // 2. Get active checklists for this template
    const checklistsResp = await httpsGet(
      'https://public-api.process.st/api/v1/checklists?templateId=' + template.id + '&status=active',
      headers
    );
    const checklists = checklistsResp.data || checklistsResp;

    if (!checklists || !Array.isArray(checklists) || checklists.length === 0) {
      await httpsPost(SLACK_WEBHOOK, {
        text: '☀️ *Good morning, MTC team!* No active escrows found today.'
      });
      return { statusCode: 200, body: 'No active checklists' };
    }

    // 3. For each checklist, get form field values
    const transactions = [];
    for (const cl of checklists) {
      try {
        const fieldsResp = await httpsGet(
          'https://public-api.process.st/api/v1/checklists/' + cl.id + '/form-fields',
          headers
        );
        const fields = fieldsResp.data || fieldsResp;
        const fieldMap = {};
        if (Array.isArray(fields)) {
          fields.forEach(f => {
            if (f.label) fieldMap[f.label] = f.value || '';
          });
        }

        const address = fieldMap['Property Address'] ||
                        fieldMap['PROPERTY ADDRESS'] ||
                        fieldMap['Street Address'] ||
                        cl.name || 'Unknown Address';

        transactions.push({
          address,
          coe: fieldMap['CLOSE OF ESCROW'] || '',
          inspection: fieldMap['CR - Inspection Due Date'] || '',
          disclosures: fieldMap['Disclosures Received by Seller'] || ''
        });
      } catch(e) {
        console.error('Error fetching fields for checklist ' + cl.id + ':', e.message);
      }
    }

    // 4. Sort by COE date soonest first
    transactions.sort((a, b) => {
      const da = a.coe ? new Date(a.coe) : new Date('9999-12-31');
      const db = b.coe ? new Date(b.coe) : new Date('9999-12-31');
      return da - db;
    });

    // 5. Build Slack message
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      timeZone: 'America/Los_Angeles'
    });

    // Split into urgent (anything due within 7 days) and the rest
    const urgent = [];
    const rest = [];
    transactions.forEach(tx => {
      const days = [daysFromNow(tx.coe), daysFromNow(tx.inspection), daysFromNow(tx.disclosures)];
      const isUrgent = days.some(d => d !== null && d <= 7);
      if (isUrgent) urgent.push(tx);
      else rest.push(tx);
    });

    let msg = '☀️ *Good morning, MTC team!*\n';
    msg += '*Daily Escrow Briefing — ' + today + '*\n';
    msg += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    msg += '*Active Escrows: ' + transactions.length + '*\n\n';

    if (urgent.length > 0) {
      msg += '*🚨 NEEDS ATTENTION (' + urgent.length + ' escrow' + (urgent.length > 1 ? 's' : '') + ')*\n\n';
      urgent.forEach(tx => {
        msg += '*' + tx.address + '*\n';
        if (tx.coe) {
          const d = daysFromNow(tx.coe);
          if (d !== null && d <= 7) msg += '  🏁 Close of Escrow: ' + formatDate(tx.coe) + '  ' + urgencyLabel(d) + '\n';
        }
        if (tx.inspection) {
          const d = daysFromNow(tx.inspection);
          if (d !== null && d <= 7) msg += '  🔍 Inspection contingency: ' + formatDate(tx.inspection) + '  ' + urgencyLabel(d) + '\n';
        }
        if (tx.disclosures) {
          const d = daysFromNow(tx.disclosures);
          if (d !== null && d <= 7) msg += '  📄 Seller disclosures: ' + formatDate(tx.disclosures) + '  ' + urgencyLabel(d) + '\n';
        }
        msg += '\n';
      });
    }

    if (rest.length > 0) {
      msg += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      msg += '*📅 UPCOMING (' + rest.length + ')*\n\n';
      rest.forEach(tx => {
        msg += '*' + tx.address + '*\n';
        if (tx.coe) msg += '  🏁 COE: ' + formatDate(tx.coe) + '  ' + urgencyLabel(daysFromNow(tx.coe)) + '\n';
        if (tx.inspection) msg += '  🔍 Inspection: ' + formatDate(tx.inspection) + '\n';
        if (tx.disclosures) msg += '  📄 Disclosures: ' + formatDate(tx.disclosures) + '\n';
        msg += '\n';
      });
    }

    msg += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    msg += '_Have a great day! — Keeva 🏡_';

    await httpsPost(SLACK_WEBHOOK, { text: msg });
    return { statusCode: 200, body: 'Sent! ' + transactions.length + ' transactions.' };

  } catch(err) {
    console.error('Briefing error:', err);
    try {
      await httpsPost(SLACK_WEBHOOK, {
        text: '⚠️ *Keeva daily briefing failed:* ' + err.message
      });
    } catch(e) {}
    return { statusCode: 500, body: err.message };
  }
};
