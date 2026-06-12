# RPA Extractor — Handoff for Claude Code

## 0. READ FIRST — accuracy caveat
This was written from a long chat session that had repeated confusion about *which file is live*. **Before acting on any specific detail here — line numbers, exact field lists, webhook IDs, whether a given change is already deployed — recon the actual repo files and confirm.** Treat this document as a map, not ground truth. Open the real files, verify, then act. The architecture, conventions, and the nature of the recent changes are reliable; exact line numbers and downstream Zapier specifics are not and must be checked.

## 1. Project
- **Repo:** `meganbaptista/rpa-extractor`, branch `main`. Owner edits via the GitHub web editor; Netlify auto-deploys on commit.
- **Purpose:** extracts ~77 fields (verified this session) from California RPA packets (PDF) with Claude, shows them in a review UI, and POSTs them to Zapier webhooks that feed Process Street.
- **Hosting:** Netlify. `netlify.toml` → `[functions] node_bundler = "esbuild"`, `external_node_modules = ["pdfjs-dist"]`. esbuild bundles relative `require()` of local modules into each function.

## 2. Architecture — the part that caused repeated confusion
- **Frontend = `index.html`** (single-page review UI). Uploads the PDF in chunks to `extract-chunk`, POSTs to `/submit` (`submit.js`), polls `/result` (`result.js`). Parsed result is stored in `extracted.rpa`. `sendToZapier(type)` POSTs `JSON.stringify(extracted[type])` to the Zapier catch-hook; **Zapier humanizes snake_case keys** for display (`buyer_names` → "Buyer Names").
- **`extract-background.js` = the LIVE extraction worker** that `/submit` triggers. This is what produces real extractions for the frontend. **Changes that need to affect production extractions go here.**
- **`extract.js` = the OLD single `/extract` endpoint.** Still deployed, but only for Zapier/external *direct* callers — NOT the frontend path. Editing it alone does NOT change frontend behavior. (Historically a hand-copied duplicate of the worker; that duplication caused real drift bugs this session.)
- **Extraction = two Claude calls:** a **main call** (full packet, all `FIELDS`) + a **targeted call** (a 2-page RPA trim: page 1 + the page-17 "Real Estate Brokers Section") for the date and agent fields. Targeted values merge over main-call values per rules in the merge loop.
- Other functions present: `audit-*` (signature-audit pipeline), `transaction-*`, `handoff-mapper.js`, plus `schemas/` (CAR form reference JSON, e.g. `CAR-RPA-1225.json`, `AD-BUYER-1224.json`). Verify roles before touching.

## 3. Field schema is now SHARED (consolidation done this session)
- The `FIELDS` object (extraction schema) now lives in **`netlify/functions/lib/rpa-fields.js`** (`module.exports = { FIELDS }`).
- **Both** `extract.js` and `extract-background.js` do `const FIELDS = require('./lib/rpa-fields').FIELDS;`.
- **Make all field-schema changes ONCE, in `lib/rpa-fields.js`.** Both paths inherit them. Do not reintroduce an inline `FIELDS` in either function.
- `lib/` is a subfolder *on purpose*: Netlify turns every top-level functions `.js` into an endpoint, but subfolder files are plain importable modules.
- The schema feeds the tool via `properties: FIELDS` + `required: Object.keys(FIELDS)`, so adding a key to `lib/rpa-fields.js` auto-registers it.
- **STILL DUPLICATED (not yet shared):** the targeted-call orchestration — `TARGETED_FIELDS`, `TARGETED_FIELD_NAMES`, `TARGETED_PROMPT`, and the merge loop — exists inline in BOTH `extract.js` and `extract-background.js`. They are currently **identical**. If you change targeted/merge logic, change BOTH files, or finish the job by extracting that orchestration into a shared module too.

## 4. What changed this session
### a) Buyer entity modeling + buyer/seller swap fix
Root cause: the schema modeled entity *sellers* but not entity *buyers*, so an entity buyer (e.g. a trust) got routed into the seller fields and swapped the parties.
- `buyer_names` gained an **ENTITY BUYERS** rule: an entity can be the buyer (sourced from RPA paragraph 1A "THIS IS AN OFFER FROM" + paragraph 32B "ENTITY BUYERS"); never assume entities are sellers; never use the property profile (that's the seller/owner of record).
- Added `buyer_entity_name`, `buyer_type` (Individual / Trust / LLC / Estate / Power of Attorney — from the contract, never the profile), `buyer_signer_1..4` (trustees/members from para 32B).
- Added `buyer_1..4` split-out fields mirroring `seller_1..4`. **KEY RULE:** an entity buyer fills exactly ONE slot with the full name intact — never comma-split an entity name (trust names contain commas, e.g. "…dated February 18, 1993"); individuals split one person per slot.
- `index.html`: added `buyer_entity_name` + `buyer_type` to `RPA_FIELD_LABELS` and the `'Parties'` array of `RPA_SECTIONS` (display only). Buyer signers and `buyer_1..4` intentionally not shown (mirrors the seller side).

### b) Seller-agent dual-agency fix (ported into the live worker this session)
Root cause: on dual-agency deals (same brokerage both sides, different agents), the buyer's agent was copied into the seller-agent fields. The page-17 brokers section has near-identical halves — **A = Buyer's Brokerage, B = Seller's Brokerage**. Fix (now in BOTH functions, identical):
- Main `FIELDS.seller_agent_name`: priority = (1) MLS Listing Agent, (2) RPA page-17 subsection B. Do **not** use RPA page-1 paragraph-2 (its dual-agency checkboxes muddy which agent is which).
- `TARGETED_FIELDS` gained `seller_agent_*` with **subsection-B-only** descriptions.
- `TARGETED_FIELD_NAMES` gained the `seller_agent_*` trigger entries.
- `TARGETED_PROMPT` rewritten **bidirectional**: A → `buyer_agent_*`, B → `seller_agent_*`, strict separation, "if B's contact lines are blank, return empty — don't borrow from A."
- Merge loop: `hasMls` guard — the targeted (subsection-B) seller value wins **only when there is no MLS**; with an MLS present, keep the MLS-sourced seller agent.

## 5. Downstream (Zapier → Process Street) — owner's side, VERIFY before relying
- Frontend posts `extracted.rpa` to the RPA Zapier catch-hook (get the exact hook URL/IDs from the owner; don't trust any pasted from this doc).
- A Formatter **"Split Text"** step ("Buyer Names (separate)") splits `buyer_names` on comma and **shatters entity names**. Now that `buyer_1..4` exist, the plan is to **retire that Split Text step and map `buyer_1..4` directly**.
- The new buyer fields (`buyer_entity_name`, `buyer_type`, `buyer_signer_1..4`, `buyer_1..4`) must be added as merge fields in Zapier/PS to flow downstream.

## 6. Open / next
- Confirm the consolidation deploy is healthy: a fresh frontend extraction returns normally and **Copy JSON** shows `buyer_1`, `buyer_2`, `buyer_type` populated.
- Retire the Zapier "Split Text" step; map `buyer_1..4`.
- Add the new buyer fields to the Zapier → Process Street mapping.
- (Optional) finish consolidation by sharing the targeted-call orchestration (`TARGETED_*` + merge) so it can't drift either.

## 7. Working conventions (owner's preferences)
- Deliver **complete replacement files** with exact destination paths. Surgical/patch edits only when there's a specific safety reason and current file contents are unknown — in that case, ask for the current file first.
- **State the planned change and wait for confirmation before writing code.**
- **Recon the real repo files before integrating.** Do not act on reconstructed/remembered details without checking them against the actual files.
- Run `node --check` on every changed JS file, and a `require()`/load test for shared modules, before delivering.
- No Airtable. Keep data shapes V2-ready (multi-tenant aware, configurations as editable data).
- The schema lives in ONE place now (`lib/rpa-fields.js`). Keep it that way — never re-inline `FIELDS`.
