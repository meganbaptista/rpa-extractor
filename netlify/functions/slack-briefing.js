const https = require('https');

const PS_API_KEY = process.env.PS_API_KEY;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const WORKFLOW_NAME = 'ESCROW CHECKLIST';

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
      hostname: opts.hostname,
      path: opts.pathname,
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
  now.setHours(0,0,0,0);
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  d.setHours(0,0,0,0);
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
    console.log('Starting briefing. PS_API_KEY set:', !!PS_API_KEY, 'SLACK_WEBHOOK set:', !!SLACK_WEBHOOK);

    const headers = { 'X-API-KEY': PS_API_KEY, 'Content-Type': 'application/json' };

    // Step 1 - get templates
    console.log('Fetching templates...');
    const tResp = await httpsGet('https://public-api.process.st/api/v1/templates', headers);
    console.log('Templates status:', tResp.status, 'body:', tResp.body.slice(0, 300));

    let templates = [];
    try { templates = JSON.parse(tResp.body); } catch(e) { throw new Error('Templates parse error: ' + tResp.body.slice(0, 200)); }
    if (!Array.isArray(templates)) templates = templates.data || [];

    const template = templates.find(t => t.name === WORKFLOW_NAME);
    if (!template) {
      const names = templates.map(t => t.name).join(', ');
      throw new Error('Template "' + WORKFLOW_NAME + '" not found. Found: ' + names);
    }
    console.log('Found template:', template.id, template.name);

    // Step 2 - get active checklists
    const cResp = await httpsGet(
      'https://public-api.process.st/api/v1/checklists?templateId=' + template.id + '&status=active',
      headers
    );
    console.log('Checklists status:', cResp.status, 'body:', cResp.body.slice(0, 300));

    let checklists = [];
    try { checklists = JSON.parse(cResp.body); } catch(e) { throw new Error('Checklists parse error: ' + cResp.body.slice(0, 200)); }
    if (!Array.isArray(checklists)) checklists = checklists.data || [];

    if (checklists.length === 0) {
      await httpsPost(SLACK_WEBHOOK, { text: 'Good morning MTC team! No active escrows found today.' });
      return { statusCode: 200, body: 'No active checklists' };
    }
    console.log('Found', checklists.length, 'active checklists');

    // Step 3 - get form fields for each checklist
    const transactions = [];
    for (const cl of checklists) {
      try {
        const fResp = await httpsGet(
          'https://public-api.process.st/api/v1/checklists/' + cl.id + '/form-fields',
          headers
        );
        let fields = [];
        try { fields = JSON.parse(fResp.body); } catch(e) { continue; }
        if (!Array.isArray(fields)) fields = fields.data || [];

        const fm = {};
        fields.forEach(f => { if (f.label) fm[f.label] = f.value || ''; });

        transactions.push({
          address: fm['Property Address'] || fm['PROPERTY ADDRESS'] || fm['Street Address'] || cl.name || 'Unknown',
          coe: fm['CLOSE OF ESCROW'] || '',
          inspection: fm['CR - Inspection Due Date'] || '',
          disclosures: fm['Disclosures Received by Seller'] || ''
        });
      } catch(e) {
        console.error('Field fetch error for', cl.id, e.message);
      }
    }

    // Step 4 - sort by COE
    transactions.sort((a, b) => {
      const da = a.coe ? new Date(a.coe) : new Date('9999-12-31');
      const db = b.coe ? new Date(b.coe) : new Date('9999-12-31');
      return da - db;
    });

    // Step 5 - build message
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles'
    });

    const urgent = [];
    const rest = [];
    transactions.forEach(tx => {
      const days = [daysFromNow(tx.coe), daysFromNow(tx.inspection), daysFromNow(tx.disclosures)];
      const isUrgent = days.some(d => d !== null && d <= 7);
      if (isUrgent) urgent.push(tx); else rest.push(tx);
    });

    let msg = 'Good morning MTC team! Here is your daily escrow briefing for ' + today + '.\n';
    msg += 'Active Escrows: ' + transactions.length + '\n\n';

    if (urgent.length > 0) {
      msg += '*NEEDS ATTENTION THIS WEEK (' + urgent.length + ')*\n\n';
      urgent.forEach(tx => {
        msg += '*' + tx.address + '*\n';
        if (tx.coe) { const d = daysFromNow(tx.coe); if (d !== null && d <= 7) msg += '  COE: ' + formatDate(tx.coe) + ' ' + urgencyLabel(d) + '\n'; }
        if (tx.inspection) { const d = daysFromNow(tx.inspection); if (d !== null && d <= 7) msg += '  Inspection: ' + formatDate(tx.inspection) + ' ' + urgencyLabel(d) + '\n'; }
        if (tx.disclosures) { const d = daysFromNow(tx.disclosures); if (d !== null && d <= 7) msg += '  Disclosures: ' + formatDate(tx.disclosures) + ' ' + urgencyLabel(d) + '\n'; }
        msg += '\n';
      });
    }

    if (rest.length > 0) {
      msg += '*UPCOMING*\n\n';
      rest.forEach(tx => {
        msg += '*' + tx.address + '*\n';
        if (tx.coe) msg += '  COE: ' + formatDate(tx.coe) + ' ' + urgencyLabel(daysFromNow(tx.coe)) + '\n';
        if (tx.inspection) msg += '  Inspection: ' + formatDate(tx.inspection) + '\n';
        if (tx.disclosures) msg += '  Disclosures: ' + formatDate(tx.disclosures) + '\n';
        msg += '\n';
      });
    }

    msg += 'Have a great day! — Keeva';

    await httpsPost(SLACK_WEBHOOK, { text: msg });
    return { statusCode: 200, body: 'Sent! ' + transactions.length + ' transactions.' };

  } catch(err) {
    console.error('Briefing error:', err.message);
    try { await httpsPost(SLACK_WEBHOOK, { text: 'Keeva briefing error: ' + err.message }); } catch(e) {}
    return { statusCode: 500, body: err.message };
  }
};
