// netlify/functions/disclosure-compliance-background.js
//
// ============================================================================
// Consumer: update the deal's compliance Google Doc from what is in its folder.
// ============================================================================
// Megan, 2026-09-23: "it should find the google doc compliance list associated
// with the address and update the list" — cross off what arrived, annotate what
// is still short a signature. The slot for this has been in lib/consumers.js
// since the pipeline was designed; this fills it.
//
// PREVIEW FIRST, AND THAT IS THE DEFAULT. Her words on why this has to earn
// trust: "We need to be able to trust this 100%." So out of the box this
// function changes NOTHING. It resolves the Doc, computes the plan, and reports
// what it WOULD do. Set COMPLIANCE_DOC_WRITE=true to let it write, once a few
// previews on real deals have read correctly.
//
// IT READS THE DEAL FOLDER, NOT THE PACKAGE THAT TRIGGERED IT. A form filed by
// hand counts the same as one the splitter wrote — she had added a BA AVID and
// a Booklets receipt that arrived separately. It is also idempotent: the second
// run over an unchanged folder plans nothing.
//
// THE DECISION LOGIC IS IN lib/compliance-doc.js and is pure, deterministic and
// AI-free. The splitter already identified each form and audited its
// signatures, writing the verdict into the filename; this only has to read
// filenames against a list.
// ============================================================================

console.log('[disclosure-compliance] module loading');

const { getStore } = require('@netlify/blobs');
const drive = require('./lib/drive');
const { parseRequestBody } = require('./lib/parse-body');
const { alert } = require('./lib/alert');
const docs = require('./lib/docs');
const { EVENTS } = require('./lib/events');
const { planDoc, findComplianceDocUrl } = require('./lib/compliance-doc');

const DONE_STORE = 'disclosure-compliance-done';

function blobsConfig(name) {
  return { name, siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN };
}

/** Writing is opt-in. Absent or anything but "true" means preview. */
function writingEnabled() {
  return String(process.env.COMPLIANCE_DOC_WRITE || '').toLowerCase() === 'true';
}

/** A human-readable account of the plan, for the alert hook and the logs. */
function describe(address, plan, docUrl, coverage, writing) {
  const deletions = plan.lines.filter((l) => l.action === 'delete');
  const annotations = plan.lines.filter((l) => l.action === 'annotate');
  const flagged = plan.lines.filter((l) => l.action === 'review');
  const out = [];
  out.push(`${writing ? 'UPDATED' : 'PREVIEW — no change made to'} the compliance list for ${address}.`);
  out.push(`${deletions.length} line(s) received, ${annotations.length} still short a signature, ${flagged.length} to look at.`);
  if (deletions.length) out.push('\nReceived (line removed):\n' + deletions.map((l) => `  - ${l.text}`).join('\n'));
  if (annotations.length) out.push('\nStill short a signature:\n' + annotations.map((l) => `  - ${l.text}  ->  ${l.to}`).join('\n'));
  /**
   * A FILE WHOSE STATUS CANNOT BE READ is the one thing a person must look at.
   * Inspection reports carry no C.A.R. signature block and arrive named
   * however the inspector sent them, and whether the buyer has seen one is a
   * judgement about its contents. Megan: "leave it and flag it."
   */
  if (flagged.length) {
    out.push('\nA file exists but Keeva cannot tell if it is complete — these lines were LEFT alone:\n' +
      flagged.map((l) => `  - ${l.text}  <-  ${l.file}`).join('\n'));
  }
  if (plan.unmatched.length) {
    out.push('\nIn the folder, but nothing on the list asks for them:\n' +
      plan.unmatched.map((f) => `  - ${f}`).join('\n'));
  }
  /**
   * AN INCOMPLETE SPLIT IS SAID HERE TOO. The list can only be as complete as
   * the folder, and a package that lost pages produces a list that goes on
   * asking for something that did arrive. Safe, but worth knowing about while
   * reading the rest of this.
   */
  if (coverage && coverage.complete === false) {
    out.push(`\nNote: the split of this package was INCOMPLETE (${coverage.unsortedPages.length} unsorted page(s), ` +
      `${coverage.failedForms.length} form(s) failed to build), so the folder may be missing something that did arrive.`);
  }
  out.push(`\n${docUrl}`);
  return out.join('\n');
}

exports.handler = async function (event) {
  const parsedBody = parseRequestBody(event);
  if (!parsedBody.ok) {
    console.error('[disclosure-compliance] bad body:', parsedBody.error);
    return { statusCode: 400 };
  }
  const envelope = parsedBody.body;
  const location = envelope.location || {};
  const eventId = envelope.id || '';
  const address = location.propertyFolderName || '';
  const propertyFolderId = location.propertyFolderId;

  if (envelope.event && envelope.event !== EVENTS.DISCLOSURE_SPLIT) {
    console.log(`[disclosure-compliance] ignoring event type ${envelope.event}`);
    return { statusCode: 200 };
  }
  if (!propertyFolderId || !address) {
    console.error('[disclosure-compliance] missing location.propertyFolderId / propertyFolderName');
    return { statusCode: 400 };
  }

  try {
    /**
     * IDEMPOTENT ON THE EVENT ID, which the pipeline requires of every
     * consumer. Keyed with the mode as well: a preview must not stop the
     * later real write of the same event from happening.
     */
    const done = getStore(blobsConfig(DONE_STORE));
    const doneKey = `${eventId}:${writingEnabled() ? 'write' : 'preview'}`;
    if (eventId && (await done.get(doneKey, { type: 'json' }).catch(() => null))) {
      console.log(`[disclosure-compliance] already handled ${doneKey}, skipping`);
      return { statusCode: 200 };
    }

    const docUrl = await findComplianceDocUrl(address);
    if (!docUrl) {
      /**
       * NO DOC IS NOT AN ERROR WORTH WAKING SOMEBODY FOR, but it IS worth
       * saying: the deal has no row in the master sheet, or the row has no
       * URL, and its list will never be updated by anything.
       */
      console.warn(`[disclosure-compliance] no compliance Doc URL for "${address}"`);
      await alert(`compliance-doc-missing:${address}`,
        `No compliance Doc URL in the master sheet for "${address}", so its list cannot be updated. ` +
        'Add the Doc link to that row (column F).', { source: 'disclosure-pipeline', label: 'Disclosure Pipeline' });
      return { statusCode: 200 };
    }

    /**
     * ONE READ, STRUCTURAL, FOR BOTH PREVIEW AND WRITE.
     *
     * It used to read the Doc through `export?format=txt`, which is convenient
     * and needs no auth. But the Docs API edits by CHARACTER POSITION, and the
     * text export's line breaks are not guaranteed to correspond to the
     * document's real offsets - matching a line in the export and then
     * deleting that many characters is how you delete part of the wrong
     * paragraph. So the plan is now built from the SAME structural read the
     * writer indexes into, and a preview predicts the write exactly rather
     * than approximately.
     */
    const docId = docs.docIdFrom(docUrl);
    if (!docId) throw new Error(`could not read a document id out of "${docUrl}"`);
    const doc = await docs.getDocument(docId);
    const { rows, skipped } = docs.paragraphsOf(doc);
    const text = docs.textForPlan(rows);
    if (!text.trim()) throw new Error(`compliance Doc read empty (${docUrl})`);
    if (skipped) {
      // A list that moved into a table would otherwise look like a short
      // document and quietly plan nothing.
      console.warn(`[disclosure-compliance] ${skipped} non-paragraph element(s) in the Doc were not read`);
    }

    const files = (await drive.listChildren(propertyFolderId, { excludeFolders: true }))
      .map((f) => String(f.name || ''))
      .filter((n) => n.toLowerCase().endsWith('.pdf'));

    const plan = planDoc(text, files);
    const changes = plan.lines.filter((l) => l.action === 'delete' || l.action === 'annotate');

    const report = describe(address, plan, docUrl, envelope.coverage, writingEnabled() && changes.length > 0);
    console.log('[disclosure-compliance]\n' + report);

    if (!writingEnabled()) {
      /**
       * PREVIEW. Reported through the same channel an incomplete split uses,
       * so it lands wherever she already reads these. `force` because this is
       * not a recurring fault condition being throttled - it is one deal's
       * result, and suppressing it would look like the pipeline did nothing.
       */
      await alert(`compliance-preview:${address}`, report, { force: true, ...{ source: 'disclosure-pipeline', label: 'Disclosure Pipeline' } });
      if (eventId) await done.setJSON(doneKey, { at: new Date().toISOString(), previewed: changes.length });
      return { statusCode: 200 };
    }

    /**
     * THE WRITE. Strikethrough by default, not deletion.
     *
     * Megan chose delete for a received line, and `COMPLIANCE_DOC_MODE=delete`
     * does exactly that. But the first live runs default to strikethrough,
     * because the two look the same at a glance and a WRONG call reads
     * completely differently: a struck line is visible and self-documenting,
     * where a wrong deletion is a line that quietly is not there any more. Same
     * reason the reconcile ran in preview first.
     */
    const mode = String(process.env.COMPLIANCE_DOC_MODE || 'strike').toLowerCase() === 'delete'
      ? 'delete' : 'strike';
    const { requests, applied, error } = docs.requestsFor(plan.lines, rows, mode);
    if (error) {
      /**
       * REFUSE RATHER THAN APPROXIMATE. The plan was derived from these very
       * paragraphs, so a disagreement means the document changed between the
       * read and the write - somebody editing it right now. Its indices are
       * stale, and writing stale indices into a client's document mangles it.
       */
      await alert(`compliance-write-stale:${address}`,
        `Did not touch the compliance list for ${address}: ${error}. The Doc looks like it was being ` +
        'edited while this ran. Nothing was changed; it will try again on the next delivery.\n\n' + report,
        { source: 'disclosure-pipeline', label: 'Disclosure Pipeline' });
      return { statusCode: 200 };
    }
    if (!requests.length) {
      console.log('[disclosure-compliance] nothing to change');
      if (eventId) await done.setJSON(doneKey, { at: new Date().toISOString(), applied: 0 });
      return { statusCode: 200 };
    }

    await docs.batchUpdate(docId, requests);
    console.log(`[disclosure-compliance] ${applied.length} line(s) updated in ${docUrl}`);

    /**
     * MARK DONE ONLY AFTER THE WRITE SUCCEEDED. Ahead of it, a failed
     * batchUpdate would be recorded as handled and the deal's list would never
     * be updated by anything.
     */
    if (eventId) await done.setJSON(doneKey, { at: new Date().toISOString(), applied: applied.length, mode });

    await alert(`compliance-updated:${address}`,
      `${report}\n\nApplied (${mode}):\n` + applied.map((a) => `  - ${a.text} — ${a.action}`).join('\n'),
      { force: true, source: 'disclosure-pipeline', label: 'Disclosure Pipeline' });
    return { statusCode: 200 };
  } catch (err) {
    console.error('[disclosure-compliance] ERROR:', err.message);
    await alert(`compliance-failed:${address}`,
      `Could not update the compliance list for ${address}: ${err.message}`, { source: 'disclosure-pipeline', label: 'Disclosure Pipeline' });
    return { statusCode: 500 };
  }
};

console.log('[disclosure-compliance] module fully loaded, handler ready');
