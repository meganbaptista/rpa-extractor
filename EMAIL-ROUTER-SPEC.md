# Email Router — Spec & Handoff

Replaces the Zapier "Main tagging" routing Zaps with a Netlify-hosted router that
labels incoming transaction email. V1 reduces inbox noise (skip no-action
acknowledgments) and routes known categories to a person; V2 adds a classifier
that assigns "Needs Attention" mail to the specific teammate who owns it.

## 1. Behavior

Both branches run the **skip gate first** — it is never a pure lookup.

**Branch A — message already carries a known category label:**
1. Run the skip gate (Haiku).
2. `skip=true` → mark read, remove from intake, **no** person label.
3. `skip=false` → apply the category's mapped **person** label.

**Branch B — no category label:**
1. Run the skip gate.
2. `skip=true` → mark read, no labels.
3. `skip=false` →
   - **V1:** apply **"Needs Attention"**.
   - **V2:** run the person-classifier. If `CLASSIFIER.mode='live'` and confidence
     ≥ threshold, apply that person's label; else fall back to Needs Attention.
     In `'shadow'` mode the suggestion is only logged; Needs Attention is applied.

Both branches call **one shared skip gate** (`lib/skip-gate.js`) — the owner's
14-rule master, verbatim. The old Zapier lane ran a drifted 9-rule variant
(missing rules 10–14 + newest-vs-thread-history scoping); that drift is a bug
this router fixes. Branch A will therefore **intentionally** differ from the old
Zaps wherever rules 10–14 / quoted-history scoping change the outcome — the
shadow log records `deciding_rule` so each disagreement can be confirmed as the
intended improvement rather than a porting error. Branch B should track the old
master closely (same rules).

## 2. Files

| File | Role |
| --- | --- |
| `lib/gmail.js` | Reusable Gmail service. SA-JWT domain-wide delegation, `gmail.modify` scope, mailbox impersonation. Label lookup/create, list by label, message fetch (headers + body + newest-vs-history split + current-attachment flag), modify, mark-read. |
| `lib/routing-config.js` | **All routing behavior as data.** Labels, skip behavior, Branch A category→person map, Branch B roster, model + mode switches. Edit here, redeploy. |
| `lib/skip-gate.js` | THE canonical 14-rule gate (Haiku, forced-tool output). Returns `{skip, deciding_rule, reason, confidence}`. |
| `lib/person-classifier.js` | V2 assignment. Reads `roster[].handles`, returns `{person, personLabel, confidence, reason}` or unsure. |
| `lib/email-router.js` | Pure decision logic. `route(message, labelNames)` → a DECISION. Touches no Gmail. |
| `lib/shadow-log.js` | Durable per-message audit ledger (Netlify Blobs) + one-line console summary. |
| `email-route-poller.js` | Scheduled producer. Lists intake-label ids, fans new ones to the consumer. Cheap (no body fetch, no AI). |
| `email-route-background.js` | Consumer. Fetch → route → shadow-log → (live only) apply labels. |

## 3. Modes (both default SAFE)

- `ROUTER.mode` — `'shadow'` = decide + log, **mutate nothing** (cutover dry run);
  `'live'` = apply labels / mark read.
- `CLASSIFIER.mode` — `'shadow'` = log the would-be person, still apply Needs
  Attention; `'live'` = apply the person label when confidence ≥ threshold.

Recommended rollout: deploy → run `ROUTER.mode='shadow'` → confirm Branch B
parity + intended Branch A differences in the log → flip `ROUTER.mode='live'` →
let the classifier gather shadow evidence → flip `CLASSIFIER.mode='live'`.

## 4. Environment

| Var | Purpose |
| --- | --- |
| `EMAIL_ROUTER_ENABLED` | Master kill switch. Poller is inert unless `='true'`. |
| `GOOGLE_SA_JSON` | Service-account key (shared with Drive). |
| `GMAIL_IMPERSONATE_SUBJECT` | Mailbox to act as (falls back to `GOOGLE_IMPERSONATE_SUBJECT`). |
| `ANTHROPIC_API_KEY` | Claude calls (gate + classifier). |
| `USAGE_SHEET_ID` | (Optional) token-usage ledger, via existing `lib/usage-log.js`. |
| `SITE_ID` / `NETLIFY_BLOBS_TOKEN` | Blobs (seen store + shadow ledger). |

**Admin prerequisite (one-time):** authorize the SA's client_id for scope
`https://www.googleapis.com/auth/gmail.modify` in Workspace Admin → Security →
API Controls → Domain-wide Delegation. Drive didn't need this; Gmail does,
because the SA acts as the mailbox.

## 5. Go-live checklist

1. Fill `lib/routing-config.js` (intake label, mailbox, category→person map, roster).
2. Create/confirm the Gmail labels the config names (person + Needs Attention
   auto-create; category + intake labels must already exist).
3. Domain-wide delegation for `gmail.modify` (§4).
4. Set env vars; leave `EMAIL_ROUTER_ENABLED` unset for now.
5. Deploy. Set `ROUTER.mode='shadow'`, `EMAIL_ROUTER_ENABLED='true'`.
6. Review the shadow log; confirm behavior.
7. Flip `ROUTER.mode='live'`. Later, flip `CLASSIFIER.mode='live'`.
