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
const { EVENTS } = require('./lib/events');
const { planDoc, findComplianceDocUrl, fetchDocText } = require('./lib/compliance-doc');

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
        'Add the Doc link to that row (column F).');
      return { statusCode: 200 };
    }

    const { text } = await fetchDocText(docUrl);
    if (!text.trim()) throw new Error(`compliance Doc exported empty (${docUrl})`);

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
      await alert(`compliance-preview:${address}`, report, { force: true });
      if (eventId) await done.setJSON(doneKey, { at: new Date().toISOString(), previewed: changes.length });
      return { statusCode: 200 };
    }

    // Writing is enabled — but the write itself is the next brick. Until it
    // exists, say so plainly rather than silently behaving like preview.
    await alert(`compliance-write-unbuilt:${address}`,
      'COMPLIANCE_DOC_WRITE is true but the Doc writer is not built yet, so nothing was changed.\n\n' + report);
    return { statusCode: 200 };
  } catch (err) {
    console.error('[disclosure-compliance] ERROR:', err.message);
    await alert(`compliance-failed:${address}`,
      `Could not update the compliance list for ${address}: ${err.message}`);
    return { statusCode: 500 };
  }
};

console.log('[disclosure-compliance] module fully loaded, handler ready');
