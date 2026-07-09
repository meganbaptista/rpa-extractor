# Incoming Disclosure Splitter — Build Spec (V1)

> **This is now Consumer #1 of the event pipeline.** Read `DISCLOSURE-INTAKE-PIPELINE.md` first — the file watching, the `disclosure.uploaded` event, and the Drive service live there. This doc covers only what the splitter does once it receives the event: identify forms, audit signatures, split, name, file. It is triggered by the event envelope (`source.fileId`, `location.propertyFolderId`), NOT by watching Drive itself.

Status: **spec / not built.** Written 2026-07-02, decisions confirmed same day (✅).
Follows the repo pattern (Netlify function + Google service account). Read "REUSE" (§3) first — most of the engine already exists.

## 1. What it does
When the listing side gets its disclosures back **signed by the buyer**, the combined PDF is dropped into that property's **`Incoming`** folder in the Drive escrow folder. The system then:
1. Reads the PDF, identifies each real CAR form + its page range.
2. **Audits signatures** on each form (who has signed / initialed vs who is required).
3. Splits the combined PDF into **one file per form**.
4. Names each `<CODE> - <Full Name> - <STATUS>.pdf` and files it into the property **root** folder.
5. Moves the original from `Incoming/` to `Incoming/_processed/`.

✅ One `Incoming` subfolder per property. ✅ Split files land in the property ROOT folder.
✅ **Signature audit is part of V1** — the filename STATUS suffix (§5) requires it, so "split + rename" necessarily includes the audit.

## 2. Flow — no Zapier trigger (service-account poller)
Megan's constraint: one `Incoming` folder per escrow means a per-deal watch Zap won't scale. Solution: the same Google service account used to WRITE files (§4) also WATCHES Drive.
```
Netlify SCHEDULED function (~every 10 min): disclosure-split-poller
  - Drive API: list all folders named "Incoming" the SA can see
  - for each: list child files NOT in _processed/
  - for each such file: invoke disclosure-split-background (the heavy worker)
Netlify BACKGROUND function: disclosure-split-background
  - load PDF -> identify forms + ranges + signature status -> split -> name -> upload to property root
  - move original to Incoming/_processed/
  - (optional) POST a summary to a Zapier catch hook for a Process Street comment
```
One-time setup: share the parent Escrow folder with the service account email. New escrow folders created under it inherit access — **zero per-opening setup**. The `_processed/` move is the idempotency guard (a file still directly in `Incoming/` = unprocessed; no timestamp bookkeeping).

## 3. REUSE — ~70% already exists (confirm against live code before building)
- **`disclosure-intake-check-background.js`**: loads a PDF (url/base64); Opus 4.8 identifies the **real CAR forms physically present** in a combined PDF; reads the **property address** off the forms. Already imports `pdf-lib` (`PDFDocument`) + `pdf-parse`/`CanvasFactory` rasterization. The form-recognition prompt is the starting point for §4 step 2.
- **`audit-background.js`**: the signature-audit engine — who signed / initialed, and the **per-form required-signer set** (not every form needs all four parties). Reframe it for "listing side received the buyer's signed acknowledgment." Drives the STATUS suffix.
- **`pdf-lib` `PDFDocument.copyPages`**: the split primitive.
- **"Current Form Versions" sheet** (`FORM_VERSIONS_CSV_URL`): source of the canonical `<Full Name>` per code (keep the form list as editable data, not hard-coded).

## 4. New functions
### `disclosure-split-background.js` (worker)
1. Load the PDF (Drive download via SA, or url/base64). Reuse intake loader + `MAX_DOC_BYTES`.
2. **Opus call — identify forms, page ranges, and signature status.** Per form return:
   `{ code, name, startPage, endPage, required_signers:[..], present_signers:[..], missing_signers:[..] }`
   (page ranges 1-indexed inclusive, contiguous — flag non-contiguous rather than guessing). Plus `unrecognized_pages:[..]`.
3. **Split** each form with `pdf-lib` (`copyPages` the range -> new doc -> `save()`).
4. **Name** per §5.
5. **Upload directly to Drive** (Option B) into the property root folder via the service account (`googleapis`, `GOOGLE_SA_JSON` secret). ✅ No Zapier in the file path.
6. `unrecognized_pages` -> one `Unsorted - review.pdf` in the property root, flagged in the summary. Never silently dropped.
7. Move the source PDF to `Incoming/_processed/`.
8. (Optional) POST a summary to a Zapier catch hook -> Process Street comment.

### `disclosure-split-poller.js` (scheduled)
Netlify Scheduled Function (cron ~*/10 min). Lists `Incoming` folders, finds unprocessed files, invokes the worker per file. Light — no Opus call here.

## 5. Naming convention ✅
`<CODE> - <Full Name> - <STATUS>.pdf`
- `<Full Name>` from the Form Versions sheet. Example base: `TDS - Transfer Disclosure Statement`.
- **STATUS:**
  - `FX` — fully executed: every **required** signer has signed AND initialed everywhere on that form.
  - Otherwise `Need` + the missing required signers joined by `+`, in fixed order **B, S, BA, LA** ✅:
    - `B` = Buyer, `S` = Seller, `BA` = Buyer's Agent, `LA` = Listing/Seller's Agent.
  - Examples:
    - `TDS - Transfer Disclosure Statement - FX.pdf`
    - `TDS - Transfer Disclosure Statement - NeedB.pdf`
    - `SPQ - Seller Property Questionnaire - NeedB+S.pdf`
    - `AD - Agency Disclosure - NeedS+LA.pdf`
    - all four: `... - NeedB+S+BA+LA.pdf`
- Missing-signer set is judged against each form's **required** signers only (per-form, from §3 audit).
- **Collision rule ✅:** if the same form is split twice, KEEP BOTH — append ` (2)`, ` (3)`, ... never overwrite (e.g. `TDS - Transfer Disclosure Statement - FX (2).pdf`).

## 6. Edge cases
- **Non-CAR docs that ride along in the package.** Three are recognized by name even though they have no CAR code (they file as `<Name> - <STATUS>.pdf`, since the empty `code` drops out of the label):
  - `EQ Booklet Receipt` — the booklet acknowledgment page (not the booklet itself).
  - `MLS` — the MLS listing detail sheet ("Customer/Agent/Client Full", Listing ID, `Printed:` stamp).
  - `Property Profile` — the title/data-vendor report (CoreLogic "Property Details"; APN/CLIP, Owner Information, Assessment & Tax, Mortgage History).

  MLS and Property Profile carry no CAR signature lines — their only marks are DocuSign initial tags in a top corner of page 1, and both run several pages (follow the doc's own `Page 1/4` counter to its last page). Because who initials them varies by package (seller, buyers, or both), they get a **presence test, not a signature audit** ✅: **any initial at all -> `FX`**, no initial anywhere -> `NeedB`. That rule is enforced in `statusSuffix()` (see `MARK_ONLY_DOCS`), not left to the model's `required_signers` — a model that over-lists required parties can't drag an initialed doc to `Need`.
- Cover emails / junk pages -> `unrecognized_pages` -> `Unsorted - review.pdf`, flagged.
- Received form revision older than the Form Versions sheet -> note in the summary (reuse intake version-check).
- Non-contiguous form pages -> flag, do not guess.
- Address on forms != expected deal -> flag, still split.
- Re-drop of the same file -> the `_processed/` move prevents reprocessing.

## 7. Priority
Unblocked 2026-07-02 (CAR forms rebuild done -> form recognition trustworthy). Candidate for the next active build. Memory: `incoming-disclosure-splitter`, `project-portfolio`.
