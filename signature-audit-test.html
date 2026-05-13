<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Signature Audit — Test</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      max-width: 900px;
      margin: 2rem auto;
      padding: 0 1rem;
      color: #1a202c;
    }
    h1 { margin-top: 0; }
    p.intro { color: #4a5568; }
    form {
      background: #f7fafc;
      padding: 1.25rem;
      border-radius: 6px;
      border: 1px solid #e2e8f0;
    }
    label {
      display: flex;
      align-items: center;
      margin: 0.6rem 0;
      gap: 0.75rem;
    }
    label > span {
      display: inline-block;
      width: 11rem;
      font-weight: 500;
    }
    input, select {
      padding: 0.45rem 0.6rem;
      font-size: 1rem;
      border: 1px solid #cbd5e0;
      border-radius: 4px;
      flex: 1;
      max-width: 24rem;
    }
    button {
      padding: 0.7rem 1.4rem;
      font-size: 1rem;
      cursor: pointer;
      background: #2c5282;
      color: white;
      border: 0;
      border-radius: 4px;
      margin-top: 0.6rem;
    }
    button:disabled { opacity: 0.55; cursor: wait; }
    #results { margin-top: 2rem; }
    .summary {
      background: #fff;
      padding: 1rem 1.25rem;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      margin-bottom: 1rem;
      line-height: 1.7;
    }
    .summary.clean {
      background: #f0fff4;
      border-left: 4px solid #38a169;
    }
    .missing-item {
      background: #fff5f5;
      padding: 0.6rem 1rem;
      border-left: 3px solid #c53030;
      margin: 0.4rem 0;
      border-radius: 0 4px 4px 0;
    }
    .unclear-item {
      background: #fffaf0;
      padding: 0.6rem 1rem;
      border-left: 3px solid #d69e2e;
      margin: 0.4rem 0;
      border-radius: 0 4px 4px 0;
    }
    .missing-item small, .unclear-item small {
      color: #4a5568;
      font-style: italic;
    }
    pre {
      background: #1a202c;
      color: #cbd5e0;
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 0.82rem;
      line-height: 1.4;
    }
    details { margin-top: 1.5rem; }
    summary { cursor: pointer; font-weight: 500; padding: 0.4rem 0; }
  </style>
</head>
<body>
  <h1>Signature Audit — Test</h1>
  <p class="intro">
    Upload a contract PDF, pick the matching schema, and the audit will run against the
    expected signature/initial locations defined in that schema. This is a test page for
    validation — not the production workflow.
  </p>

  <form id="auditForm">
    <label>
      <span>Form schema</span>
      <select name="formId" required>
        <option value="CAR-RPA-1225">CAR-RPA-1225 (California RPA, 12/25 revision)</option>
        <option value="AD-BUYER-1224">AD-BUYER-1224 (Agency Disclosure, buyer side)</option>
      </select>
    </label>
    <label>
      <span>Buyer count</span>
      <input type="number" name="buyerCount" value="1" min="1" max="4" required />
    </label>
    <label>
      <span>Seller count</span>
      <input type="number" name="sellerCount" value="1" min="1" max="4" required />
    </label>
    <label>
      <span>PDF file</span>
      <input type="file" name="pdf" accept="application/pdf" required />
    </label>
    <button type="submit">Run audit</button>
  </form>

  <div id="results"></div>

  <script>
    document.getElementById('auditForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      const results = document.getElementById('results');

      btn.disabled = true;
      btn.textContent = 'Running… (20–40 seconds typical)';
      results.innerHTML = '';

      try {
        const fd = new FormData(e.target);
        const file = fd.get('pdf');
        const formId = fd.get('formId');
        const buyerCount = parseInt(fd.get('buyerCount'), 10);
        const sellerCount = parseInt(fd.get('sellerCount'), 10);

        const pdfBase64 = await fileToBase64(file);

        const response = await fetch('/.netlify/functions/audit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pdfBase64, formId, buyerCount, sellerCount }),
        });

        const data = await response.json();
        renderResults(data);
      } catch (err) {
        results.innerHTML = `<div class="missing-item">Error: ${escapeHtml(err.message)}</div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Run audit';
      }
    });

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
    }

    function renderResults(data) {
      const results = document.getElementById('results');

      if (data.error) {
        results.innerHTML = `<div class="missing-item"><strong>Server error:</strong> ${escapeHtml(
          data.error
        )}</div>`;
        return;
      }

      const s = data.summary || {};
      const missing = (s.missingItems || []).filter((i) => i.status === 'absent');
      const unclear = (s.missingItems || []).filter((i) => i.status === 'unclear');

      const isClean = missing.length === 0 && unclear.length === 0;

      let html = `<div class="summary${isClean ? ' clean' : ''}">
        <strong>Form:</strong> ${escapeHtml(data.formName)} (${escapeHtml(data.formId)})<br>
        <strong>Contract state:</strong> ${escapeHtml(data.contractState)}<br>
        <strong>Parties:</strong> ${data.partyCount.buyers} buyer(s), ${data.partyCount.sellers} seller(s)<br>
        <strong>Pages:</strong> ${data.totalPages}<br>
        <strong>Checks run:</strong> ${data.checksRun}<br>
        <strong>Present:</strong> ${s.present || 0} &nbsp;|&nbsp;
        <strong>Absent:</strong> ${s.absent || 0} &nbsp;|&nbsp;
        <strong>Unclear:</strong> ${s.unclear || 0} &nbsp;|&nbsp;
        <strong>N/A:</strong> ${s.not_applicable || 0} &nbsp;|&nbsp;
        <strong>Errors:</strong> ${s.error || 0}
      </div>`;

      if (isClean) {
        html += `<div class="summary clean"><strong>No missing signatures or initials detected.</strong></div>`;
      } else {
        if (missing.length > 0) {
          html += `<h2>Missing (${missing.length})</h2>`;
          for (const item of missing) {
            html += `<div class="missing-item">
              <strong>${escapeHtml(item.party)} — ${escapeHtml(item.markType)}</strong>
              on page ${item.page} &nbsp;·&nbsp; <code>${escapeHtml(item.locationId)}</code><br>
              <small>${escapeHtml(item.reasoning || '')}</small>
            </div>`;
          }
        }
        if (unclear.length > 0) {
          html += `<h2>Needs human review (${unclear.length})</h2>`;
          for (const item of unclear) {
            html += `<div class="unclear-item">
              <strong>${escapeHtml(item.party)} — ${escapeHtml(item.markType)}</strong>
              on page ${item.page} &nbsp;·&nbsp; <code>${escapeHtml(item.locationId)}</code><br>
              <small>${escapeHtml(item.reasoning || '')}</small>
            </div>`;
          }
        }
      }

      html += `<details><summary>Raw JSON output</summary><pre>${escapeHtml(
        JSON.stringify(data, null, 2)
      )}</pre></details>`;

      results.innerHTML = html;
    }

    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
  </script>
</body>
</html>
