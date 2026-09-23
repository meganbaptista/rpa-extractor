// netlify/functions/docs-selftest.js
//
// ============================================================================
// THROWAWAY — can Keeva EDIT a Google Doc with the credentials it already has?
// ============================================================================
// Written 2026-09-23 to settle one question before building the compliance-Doc
// writer: the service account already reads the compliance Docs through their
// public export URL, with no auth at all. Writing needs a real authorised call,
// and domain-wide delegation grants are matched on the EXACT scope string — so
// "the Drive scope should cover the Docs API" is a claim worth proving rather
// than assuming.
//
// SAFE BY CONSTRUCTION. It never touches a compliance Doc. It creates its own
// scratch Doc, strikes a line through some text in it, reads it back, and
// trashes it. If any step is unauthorised the response says which one.
//
// Optionally pass ?docUrl=<a real compliance Doc> to ALSO prove it can read
// that one through the API (still read-only, still no edit).
//
//   /.netlify/functions/docs-selftest
//   /.netlify/functions/docs-selftest?docUrl=https://docs.google.com/document/d/XXXX/edit
//
// DELETE THIS FILE once the answer is recorded.
// ============================================================================

const { getAccessToken } = require('./lib/drive');

const DOCS = 'https://docs.googleapis.com/v1/documents';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

async function call(url, init = {}) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { ok: res.ok, status: res.status, body };
}

/** Every run of text in the doc, with the index range the API addresses it by. */
function paragraphs(doc) {
  const out = [];
  for (const el of (doc.body && doc.body.content) || []) {
    const para = el.paragraph;
    if (!para) continue;
    const text = (para.elements || [])
      .map((e) => (e.textRun && e.textRun.content) || '')
      .join('');
    out.push({ start: el.startIndex, end: el.endIndex, text: text.replace(/\n$/, '') });
  }
  return out;
}

exports.handler = async function (event) {
  const q = (event && event.queryStringParameters) || {};
  const steps = [];
  const note = (name, result, detail) => steps.push({ step: name, result, detail });

  let scratchId = '';
  try {
    // 1. Token. Proves the JWT + delegation still work at all.
    const token = await getAccessToken();
    note('mint a token (impersonating ' + (process.env.GOOGLE_IMPERSONATE_SUBJECT || 'nobody') + ')',
      token ? 'ok' : 'FAILED', token ? `${token.length} chars` : '');

    // 2. CREATE a scratch doc. First real Docs API call — this is the one that
    //    fails if the delegation does not cover the Docs API.
    const created = await call(DOCS, {
      method: 'POST',
      body: JSON.stringify({ title: 'Keeva docs-selftest (safe to delete)' }),
    });
    note('create a scratch Doc', created.ok ? 'ok' : 'FAILED',
      created.ok ? created.body.documentId : JSON.stringify(created.body).slice(0, 400));
    if (!created.ok) {
      return json({ verdict: 'The Docs API is NOT authorised for this credential.', steps });
    }
    scratchId = created.body.documentId;

    // 3. Write a line, then STRIKE IT THROUGH — the exact operation the
    //    compliance writer would perform on a received item.
    const line = 'TDS - Real Estate Transfer Disclosure Statement\n';
    const wrote = await call(`${DOCS}/${scratchId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ insertText: { location: { index: 1 }, text: line } }],
      }),
    });
    note('insert a line', wrote.ok ? 'ok' : 'FAILED',
      wrote.ok ? '' : JSON.stringify(wrote.body).slice(0, 300));

    const struck = await call(`${DOCS}/${scratchId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          updateTextStyle: {
            range: { startIndex: 1, endIndex: line.length },
            textStyle: { strikethrough: true },
            fields: 'strikethrough',
          },
        }],
      }),
    });
    note('strike a line through', struck.ok ? 'ok' : 'FAILED',
      struck.ok ? '' : JSON.stringify(struck.body).slice(0, 300));

    // 4. And DELETE a line, which is what Megan actually wants: her after-doc
    //    has received items gone, not crossed out.
    const deleted = await call(`${DOCS}/${scratchId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: line.length } } }],
      }),
    });
    note('delete a line', deleted.ok ? 'ok' : 'FAILED',
      deleted.ok ? '' : JSON.stringify(deleted.body).slice(0, 300));

    // 5. Read it back, so "ok" means the change actually landed rather than
    //    the API merely accepting the request.
    const readBack = await call(`${DOCS}/${scratchId}`);
    note('read it back', readBack.ok ? 'ok' : 'FAILED',
      readBack.ok ? `${paragraphs(readBack.body).length} paragraph(s) left` : '');

    // 6. OPTIONAL: read one of the real compliance Docs through the API, and
    //    show the DISCLOSURES lines with the index ranges a writer would use.
    const docUrl = String(q.docUrl || '');
    const id = (docUrl.match(/\/document\/d\/([a-zA-Z0-9_-]+)/) || [])[1];
    if (id) {
      const real = await call(`${DOCS}/${id}`);
      if (!real.ok) {
        note('read the compliance Doc', 'FAILED', JSON.stringify(real.body).slice(0, 300));
      } else {
        const lines = paragraphs(real.body);
        const start = lines.findIndex((l) => /^\s*DISCLOSURES\s*:?\s*$/i.test(l.text));
        const stop = lines.findIndex((l, i) => i > start && /^\s*CLOSING PACKAGE ITEMS/i.test(l.text));
        const items = start < 0 ? [] : lines.slice(start + 1, stop < 0 ? undefined : stop)
          .filter((l) => l.text.trim());
        note('read the compliance Doc', 'ok', {
          title: real.body.title,
          disclosureItems: items.length,
          firstFive: items.slice(0, 5).map((l) => ({ text: l.text.trim(), range: [l.start, l.end] })),
        });
      }
    }
  } catch (err) {
    note('unhandled', 'FAILED', err.message);
  } finally {
    // 7. Always clean up, even if a step failed.
    if (scratchId) {
      const trashed = await call(`${DRIVE}/${scratchId}?supportsAllDrives=true`, {
        method: 'PATCH',
        body: JSON.stringify({ trashed: true }),
      });
      note('trash the scratch Doc', trashed.ok ? 'ok' : 'FAILED (delete it by hand)', scratchId);
    }
  }

  const failed = steps.filter((s) => String(s.result).startsWith('FAILED'));
  return json({
    verdict: failed.length
      ? `${failed.length} step(s) failed — see below.`
      : 'Keeva can already read, edit and delete lines in a Google Doc with the credentials it has. No new scope or sharing needed.',
    steps,
  });
};

function json(body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body, null, 2),
  };
}
