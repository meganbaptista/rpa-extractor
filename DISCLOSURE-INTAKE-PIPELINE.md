# Disclosure Intake Pipeline — Architecture (event-driven)

Status: **design / not built.** Written 2026-07-02.
Supersedes the framing in `INCOMING-SPLITTER-SPEC.md` — the splitter is now just **Consumer #1** of this pipeline, not the whole thing.

## Principle
Do not build a splitter. Build a **reusable Drive layer** that watches for new files and **emits an event**; the splitter is the first thing that *listens*. Every future capability (OCR, CAR form classification, signature verification, compliance-checklist updates, email drafting, transaction-timeline updates) plugs in as another **consumer** of the same event, with **zero changes to the producer**.

```
                                   +--> [Consumer] Splitter            (build now)
                                   +--> [Consumer] OCR                 (later)
[Drive watcher] --publish(event)-->+--> [Consumer] CAR classification  (later)
   (producer)                      +--> [Consumer] Signature verify    (later)
                                   +--> [Consumer] Compliance update    (later)
                                   +--> [Consumer] Email drafting       (later)
                                   +--> [Consumer] Timeline update      (later)
```

## The five layers

### 1. Drive service — `lib/drive.js` (reusable, event-agnostic)
The whole Google integration, one module, used by the producer AND every consumer so nobody re-implements auth or REST calls:
- `getAccessToken()` — RS256-signed JWT from `GOOGLE_SA_JSON`, exchanged for a token (the mechanism proven by `drive-selftest.js`). Zero npm deps (built-in `crypto` + global `fetch`).
- `listChildren(folderId, {mimeType?})`, `findFoldersByName(name)`, `getFileMeta(fileId, fields)`, `download(fileId) -> Buffer`, `uploadMultipart({name, parents, mimeType, bytes}) -> {id}`, `moveFile(fileId,{addParents,removeParents})`, `ensureFolder(name, parentId)`.
- All calls pass `supportsAllDrives=true` so it works in My Drive today and a Shared Drive later with no code change.

### 2. Producer / watcher — `disclosure-watch-poller.js` (Netlify Scheduled Function)
- Schedule in `netlify.toml`: `[functions."disclosure-watch-poller"] schedule = "*/10 * * * *"`.
- Uses `lib/drive.js`: `findFoldersByName('Incoming')` -> for each, `listChildren` -> for each file not seen before, build an event and `publish()` it.
- **Dedupe (not folder moves):** a `@netlify/blobs` store `disclosure-intake-seen`, keyed by `fileId` + `modifiedTime`/`md5`. The producer never moves or deletes files — "processed" is a *consumer* concern (see §5). This is what lets many consumers each read the same original.
- **Cheap on purpose:** the producer does NOT open the PDF. It emits folder/file metadata only; any heavy reading (OCR, reading the address off the forms) belongs to a consumer.

### 3. Event bus — `lib/events.js`
- Event types as constants: `EVENTS.DISCLOSURE_UPLOADED = 'disclosure.uploaded'` (room for `disclosure.split`, `disclosure.classified`, ... as the pipeline grows).
- `makeEvent(type, payload)` builds a stable, **versioned envelope** (schema below).
- `publish(event)` reads the consumer registry (§4), and for every enabled consumer subscribed to `event.type`, fires an HTTP POST to that consumer's background-function URL. **Failure-isolated per consumer** (one bad consumer never blocks the others); returns per-consumer dispatch status for logging. Fan-out is parallel and fire-and-forget (background functions 202 immediately).

**Event envelope (`disclosure.uploaded`, v1):**
```json
{
  "event": "disclosure.uploaded",
  "version": 1,
  "id": "<fileId>:<modifiedTime>",        // dedupe key — consumers must be idempotent on this
  "occurredAt": "<ISO8601>",
  "source":   { "fileId","fileName","mimeType","sizeBytes","md5","driveUrl" },
  "location": { "incomingFolderId","propertyFolderId","propertyFolderName","agentFolderName","path" }
}
```
Consumers get everything they need to act without re-deriving folder structure. They read file bytes via `lib/drive.js` using `source.fileId`.

### 4. Consumer registry — `lib/consumers.js` (editable config, V2-ready as data)
The plug-in surface. Adding a capability = add a row + write its function. No producer change.
```js
module.exports.CONSUMERS = [
  { name: 'splitter',        fn: 'disclosure-split-background',      events: ['disclosure.uploaded'], enabled: true  },
  { name: 'ocr',             fn: 'disclosure-ocr-background',        events: ['disclosure.uploaded'], enabled: false },
  { name: 'classify',        fn: 'disclosure-classify-background',   events: ['disclosure.uploaded'], enabled: false },
  { name: 'signature-verify',fn: 'disclosure-sigverify-background',  events: ['disclosure.split'],    enabled: false },
  { name: 'compliance',      fn: 'disclosure-compliance-background', events: ['disclosure.split'],    enabled: false },
  { name: 'email-draft',     fn: 'disclosure-email-background',      events: ['disclosure.split'],    enabled: false },
  { name: 'timeline',        fn: 'disclosure-timeline-background',   events: ['disclosure.uploaded'], enabled: false },
];
```
- Base function URL from env (`URL`/`DEPLOY_URL` Netlify provides, override `SELF_BASE_URL`).
- **Beta guard lives here too:** a `folderAllowlist` (only emit/act on the test property folder) + `enabled` flags, so we roll out one consumer at a time.
- Later this table can move to a Google Sheet / per-tenant config without touching the bus (keeps configs-as-data, multi-tenant-ready).

### 5. Consumers (each a Netlify BACKGROUND function taking the envelope)
- Every consumer: idempotent on `event.id`, reads bytes via `lib/drive.js`, does its job, and **may emit a downstream event** (consumer-as-producer). That cascade is how the *ordered* parts of the pipeline work without a central orchestrator: e.g. the splitter emits `disclosure.split` carrying the per-form file ids; signature-verify / compliance / email-draft listen for **that**, not the raw upload.
- **Consumer #1 = the splitter** (`disclosure-split-background.js`): on `disclosure.uploaded`, download the combined PDF, Opus identify forms + page ranges + signature status, split with `pdf-lib`, name per `INCOMING-SPLITTER-SPEC.md` §5, upload to `location.propertyFolderId`, then archive the original to `Incoming/_processed/` and emit `disclosure.split`. (Archival-as-a-consumer-action is safe: Drive moves preserve `fileId`, so any later consumer reading by id still resolves it.)

## Build order
1. `lib/drive.js` (extract + generalize the proven smoke-test auth; add the REST helpers).
2. `lib/events.js` + `lib/consumers.js` (bus + registry, splitter the only enabled consumer).
3. `disclosure-watch-poller.js` (producer) + the `netlify.toml` schedule entry.
4. `disclosure-split-background.js` (Consumer #1) — the splitter per `INCOMING-SPLITTER-SPEC.md`, adapted to the event envelope.
5. Beta via the `folderAllowlist` (test property folder) + dry-run, then flip on.

## Engineering decisions (made, not open — flag if you disagree)
- **Transport = in-house HTTP fan-out to background functions.** No Kafka/SNS/Zapier; serverless-native, nothing to run. (Stays "less Zapier.")
- **Dedupe = Netlify Blobs "seen" store**, not folder moves — required for multiple consumers.
- **Ordered steps = event cascades** (consumer emits the next event), not a central orchestrator.
- **Consumer registry = JS config now**, shaped so it can become sheet/per-tenant data later.
