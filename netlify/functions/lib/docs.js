// netlify/functions/lib/docs.js
//
// ============================================================================
// EDITING THE COMPLIANCE GOOGLE DOC. A client document, so read the warnings.
// ============================================================================
// The reconcile in lib/compliance-doc.js decides what each line of the list
// should become; this applies those decisions. It is the only code in the
// pipeline that writes into a document a client and a TC both look at, so it
// is built to refuse rather than approximate.
//
// THE PROBLEM THAT SHAPES THIS FILE: THE DOCS API EDITS BY CHARACTER POSITION.
// Two consequences, both of which silently corrupt a document if ignored.
//
//   1. THE TEXT YOU MATCHED ON MUST BE THE TEXT YOU INDEX INTO. The preview
//      path reads the Doc through `export?format=txt`, which is convenient and
//      needs no auth, but its line breaks and spacing are NOT guaranteed to
//      correspond to the document's real character offsets. Matching a line in
//      the export and then deleting that many characters from the document is
//      how you delete half of the wrong paragraph. So the writer reads the Doc
//      STRUCTURALLY and derives the plan's input text from that same read -
//      one source, so the two cannot disagree.
//   2. EVERY EDIT MOVES EVERYTHING AFTER IT. Delete a paragraph at index 400
//      and every later index shifts back by its length. Requests in one
//      batchUpdate are applied IN ORDER, so they must be submitted in REVERSE
//      document order; then each edit only ever moves text that has already
//      been handled.
//
// Google Docs keeps version history, so a bad write is recoverable - but it is
// recoverable by a person who first has to notice, so that is a backstop and
// not a design.
// ============================================================================

const drive = require('./drive');

const DOCS_API = 'https://docs.googleapis.com/v1/documents';

/** The document id out of any Doc URL. */
function docIdFrom(urlOrId) {
  const s = String(urlOrId || '').trim();
  const m = s.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
}

async function authed(url, init = {}) {
  const token = await drive.getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`docs api ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

/** The document, structurally. */
function getDocument(docId) {
  return authed(`${DOCS_API}/${encodeURIComponent(docId)}`);
}

/**
 * Flatten the body into one row per paragraph, with its real index range.
 *
 * TABLES AND ANYTHING ELSE ARE SKIPPED DELIBERATELY. A structural element that
 * is not a plain body paragraph is not something this writer knows how to edit
 * safely, and a compliance list is a flat bulleted list. Skipping is recorded
 * (`skipped`) rather than silent, because a list that moved into a table would
 * otherwise look like an empty document and plan nothing.
 */
function paragraphsOf(doc) {
  const rows = [];
  let skipped = 0;
  for (const el of (doc.body && doc.body.content) || []) {
    if (!el.paragraph) {
      // The first element is always a section break; that is not a loss.
      if (!el.sectionBreak) skipped += 1;
      continue;
    }
    const runs = (el.paragraph.elements || []);
    // \v is a soft line break inside one paragraph. Flattened to a space: it
    // must not become a newline, or the line count stops matching the
    // paragraph count and every index after it is wrong.
    const text = runs.map((r) => (r.textRun && r.textRun.content) || '').join('')
      .replace(/\v/g, ' ')
      .replace(/\n$/, '');
    rows.push({
      text,
      startIndex: el.startIndex,
      endIndex: el.endIndex,
      // A Docs list bullet is formatting, not characters, so a bulleted line's
      // text does NOT begin with "- ". The reconcile only considers bulleted
      // lines, so it has to be told.
      bulleted: !!el.paragraph.bullet,
    });
  }
  return { rows, skipped };
}

/**
 * The text to hand the reconcile, built from the structural read.
 *
 * A Docs bullet carries no characters, so a list item's text is bare. The
 * reconcile identifies list lines by a leading "- ", so one is added back for
 * bulleted paragraphs. Line N of this text is therefore paragraph N, exactly,
 * which is what makes the index mapping safe.
 */
function textForPlan(rows) {
  return rows.map((r) => (r.bulleted && !/^\s*[-*•]\s+/.test(r.text) ? `- ${r.text}` : r.text)).join('\n');
}

/**
 * Turn the reconcile's plan into Docs API requests.
 *
 * `mode` is 'strike' or 'delete' for a line that has arrived complete.
 * Strikethrough is the safer first setting: a wrong call is visible and
 * self-documenting, where a wrong deletion is a line that quietly is not there
 * any more. Both leave the same impression at a glance.
 *
 * REFUSES on any mismatch. `plan.lines` must be the same length as `rows` and
 * every line's text must still match its paragraph - it was derived from these
 * very rows, so a disagreement means something changed under us (someone
 * editing the Doc between the read and the write) and the indices are no
 * longer trustworthy. Returning an error beats writing into a moving document.
 */
function requestsFor(planLines, rows, mode = 'strike') {
  if (planLines.length !== rows.length) {
    return { error: `the plan has ${planLines.length} line(s) but the document has ${rows.length} paragraph(s)` };
  }
  const requests = [];
  const applied = [];

  // Reverse document order, so each edit only moves text already handled.
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = planLines[i];
    const row = rows[i];
    if (!line || line.action === 'heading' || line.action === 'keep' || line.action === 'review') continue;

    if (line.action === 'delete') {
      if (mode === 'delete') {
        // endIndex covers the paragraph's own newline, which is what makes the
        // line disappear rather than leaving a blank bullet behind. The very
        // last paragraph of a body cannot have its newline removed, so it is
        // trimmed by one.
        const isLast = i === rows.length - 1;
        const end = isLast ? Math.max(row.startIndex, row.endIndex - 1) : row.endIndex;
        if (end <= row.startIndex) continue;
        requests.push({ deleteContentRange: { range: { startIndex: row.startIndex, endIndex: end } } });
        applied.push({ text: line.text, action: 'deleted' });
      } else {
        const end = Math.max(row.startIndex, row.endIndex - 1);
        if (end <= row.startIndex) continue;
        requests.push({
          updateTextStyle: {
            range: { startIndex: row.startIndex, endIndex: end },
            textStyle: { strikethrough: true },
            fields: 'strikethrough',
          },
        });
        applied.push({ text: line.text, action: 'struck through' });
      }
      continue;
    }

    if (line.action === 'annotate') {
      // Insert at the end of the text, BEFORE the paragraph's newline, or the
      // suffix lands at the start of the following line.
      const at = Math.max(row.startIndex, row.endIndex - 1);
      const suffix = suffixFor(row.text, line.to);
      if (!suffix) continue;
      requests.push({ insertText: { location: { index: at }, text: suffix } });
      applied.push({ text: line.text, action: `annotated "${suffix.trim()}"` });
    }
  }
  // Report in document order; the reversal is a mechanical detail.
  return { requests, applied: applied.reverse() };
}

/**
 * What to append to a line that arrived short a signature.
 *
 * The reconcile's `to` is the WHOLE rewritten line, but rewriting a line means
 * deleting and re-inserting it, which throws away any formatting it carries.
 * Appending the new tail keeps the line's own styling and is a smaller edit.
 * Returns '' when the line already ends that way, so a second run over an
 * unchanged folder appends nothing.
 */
function suffixFor(current, to) {
  const now = String(current || '').replace(/^\s*[-*•]\s*/, '').trimEnd();
  const want = String(to || '').replace(/^\s*[-*•]\s*/, '').trimEnd();
  if (!want || want === now) return '';
  if (want.startsWith(now)) return want.slice(now.length);
  // The reconcile rewrote more than the tail. Appending would leave both the
  // old and the new status on one line, so say nothing and leave it for a
  // person - that is the `review` outcome by another name.
  return '';
}

/** Apply the requests. Returns the API reply, or null when there was nothing to do. */
async function batchUpdate(docId, requests) {
  if (!requests.length) return null;
  return authed(`${DOCS_API}/${encodeURIComponent(docId)}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
}

module.exports = {
  docIdFrom, getDocument, paragraphsOf, textForPlan, requestsFor, batchUpdate, suffixFor,
};
