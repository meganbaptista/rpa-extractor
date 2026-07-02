// netlify/functions/lib/watch.js
//
// ============================================================================
// The producer core for the Disclosure Intake Pipeline (see
// DISCLOSURE-INTAKE-PIPELINE.md). Scans every "Incoming" folder the service
// account can see, and for each NEW file emits a `disclosure.uploaded` event.
// Shared by the scheduled poller (disclosure-watch-poller.js) and the manual
// beta trigger (disclosure-watch-run.js) so both run identical logic.
// ============================================================================
// DEDUPE, not folder moves: a Netlify Blobs "seen" store keyed by
// `${fileId}:${modifiedTime}` records which files we have already emitted for.
// The producer never moves or deletes files (that is a consumer's job) — that is
// what lets many consumers each read the same original. A re-uploaded/edited file
// gets a new modifiedTime, so it is treated as new and re-emitted.
//
// The producer is deliberately CHEAP: it never opens the PDF. It emits folder +
// file metadata only; heavy reading (OCR, reading the address off the forms)
// belongs to a consumer.
//
// COLD-START / BACKLOG NOTE: on go-live, only files that are NEW to the seen
// store fire. During beta the folder allowlist blocks dispatch for non-test
// folders, but those files are still marked seen — so flipping the allowlist off
// does NOT dump the pre-existing backlog. To (re)process an old file, re-drop it.
// ============================================================================

const { getStore } = require('@netlify/blobs');
const drive = require('./drive');
const { makeEvent, publish, EVENTS } = require('./events');
const { passesBetaGuard } = require('./consumers');

const SEEN_STORE = 'disclosure-intake-seen';
// The folder name that marks a drop zone. Overridable if the convention changes.
const INCOMING_FOLDER_NAME = process.env.INCOMING_FOLDER_NAME || 'Incoming';

function seenStore() {
  return getStore({
    name: SEEN_STORE,
    siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

// Scan all Incoming folders and emit an event per new PDF.
// opts.dryRun = true -> build events and report what WOULD dispatch, but do not
// publish and do not mark anything seen (safe to run repeatedly during beta).
async function scanIncoming({ dryRun = false } = {}) {
  const store = seenStore();
  const summary = {
    dryRun,
    incomingFolders: 0,
    scanned: 0,
    emitted: [],
    skippedSeen: 0,
    skippedNonPdf: [],
    errors: [],
  };

  // Memoize folder-meta lookups within a run (property + agent folders).
  const metaCache = new Map();
  async function metaOf(id) {
    if (!id) return null;
    if (metaCache.has(id)) return metaCache.get(id);
    const m = await drive.getFileMeta(id, 'id,name,parents');
    metaCache.set(id, m);
    return m;
  }

  const incomingFolders = await drive.findFoldersByName(INCOMING_FOLDER_NAME);
  summary.incomingFolders = incomingFolders.length;

  for (const inc of incomingFolders) {
    try {
      const propertyFolderId = (inc.parents && inc.parents[0]) || null;
      const property = propertyFolderId ? await metaOf(propertyFolderId) : null;
      const agent = property && property.parents && property.parents[0]
        ? await metaOf(property.parents[0])
        : null;

      const files = await drive.listChildren(inc.id, { excludeFolders: true });
      for (const f of files) {
        summary.scanned++;
        if (f.mimeType !== 'application/pdf') {
          summary.skippedNonPdf.push(f.name);
          continue;
        }
        const key = `${f.id}:${f.modifiedTime}`;
        const already = await store.get(key, { type: 'json' }).catch(() => null);
        if (already) { summary.skippedSeen++; continue; }

        const event = makeEvent(EVENTS.DISCLOSURE_UPLOADED, {
          id: key,
          source: {
            fileId: f.id,
            fileName: f.name,
            mimeType: f.mimeType,
            sizeBytes: f.size ? Number(f.size) : null,
            md5: f.md5Checksum || null,
            driveUrl: f.webViewLink || null,
            modifiedTime: f.modifiedTime,
          },
          location: {
            incomingFolderId: inc.id,
            propertyFolderId,
            propertyFolderName: property ? property.name : null,
            agentFolderName: agent ? agent.name : null,
            path: [agent && agent.name, property && property.name, INCOMING_FOLDER_NAME, f.name]
              .filter(Boolean).join(' / '),
          },
        });

        let dispatch = [];
        if (dryRun) {
          summary.emitted.push({
            file: f.name,
            property: property ? property.name : null,
            wouldDispatch: passesBetaGuard(event),
            event,
          });
        } else {
          dispatch = await publish(event);
          await store.setJSON(key, { emittedAt: event.occurredAt, fileName: f.name, propertyFolderId });
          summary.emitted.push({ file: f.name, property: property ? property.name : null, dispatch });
        }
      }
    } catch (err) {
      summary.errors.push({ incomingFolderId: inc.id, error: err.message });
    }
  }

  return summary;
}

module.exports = { scanIncoming, INCOMING_FOLDER_NAME };
