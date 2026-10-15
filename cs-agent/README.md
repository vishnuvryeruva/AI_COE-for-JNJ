# AI4U Email Operations

Ask for customer emails in Outlook → identify requests and order references → prepare reply drafts → review and approve.

Outlook search is the primary workflow. Saved email uploads, manual entry, and sample emails remain under **Import an email manually**. No live ERP calls or SAP document retrieval are implemented.

The [upgrade requirements](docs/upgrade-requirements.md) record the confirmed target: understand emails and attachments, retrieve SAP evidence, draft replies, and require manual approval before sending. Document retrieval and external email-service ownership remain open integration decisions.

The point of POC 1 is to retire the risk he named: *"everybody challenged with this — email integration, SMTP not being supported... Everybody's failing there. So if we can crack that nut."*

## What works today

- **Find emails in Outlook** by describing the request, such as **“Find sales orders from email”**, **“Find invoices this week”**, or **“Find packing lists for order 5003000237”**
- **Inspect matches** with sender, subject, message preview, matching reason, and order references found in the email
- **Prepare drafts** for one or all matches; existing requests are reused and individual failures can be retried
- **Import manually** as a secondary option: upload a saved or forwarded Outlook `.msg` or `.eml`, type an email, or load sample scenarios
- **Recover the original sender** from the forward — the load-bearing part
- **Detect intent** + extract the order number via SAP AI Core
- **Draft a reply** addressed per the rule below
- **Review and approve** — and, when signed in to Outlook, **actually send** the reply via Microsoft Graph
- **Full audit trail**; runs as **one Docker image** on BTP Cloud Foundry

## Outlook search workflow

1. Configure Microsoft Graph using the instructions below, then select **Sign in with J&J account** (or **Connect Outlook** in local demo mode). Microsoft handles J&J credentials and any required MFA.
2. Enter a request in **Describe the emails to find**, or select an example, and choose **Find emails**.
3. Inspect the matching messages and extracted order references. Choose **Prepare draft** or **Prepare all drafts** to classify the emails and add them to the work queue.
4. Open **Review draft**, check the sender and content, and approve the reply when ready.

Search uses deterministic SAP/customer-service terms and reads up to **200 recent Inbox messages**, including full message bodies. Results display the applied query, scan count, and whether the scan was limited. It does not search attachment contents, other folders, shared mailboxes, or SAP itself. Order references are copied from email text and are not validated against SAP. Search runs on request; it is not a background mailbox subscription.

`POST /api/v1/mailbox/search` accepts `{ "prompt": "Find sales orders from email" }` and requires an Outlook session. Supported topics include sales/purchase orders, order status, invoices, packing lists, deliveries, shipment tracking, and proof of delivery. Supported date and sender qualifiers are returned in the interpreted query; unsupported queries return an actionable error. Calendar date filters use UTC.

Neither searching nor preparing drafts sends mail. Reply sending remains an explicit action in the review screen. SAP AI Core classifies messages and drafts acknowledgements when configured; otherwise the existing low-confidence keyword fallback is used.

## Ingestion is pluggable

Every path produces one normalized email object; the rest of the app doesn't know the difference. Adding Outlook was one adapter, not a rewrite — which is the reusable-across-use-cases property Pramod asked for.

| Adapter | How the email arrives | Sender confidence |
|---|---|---|
| `GRAPH_PICK` | A matching email is retrieved directly from the signed-in Outlook inbox | 1.0 — structured Graph headers |
| `MSG_DIRECT` / `EML_DIRECT` | Saved original Outlook email | 1.0 when the SMTP sender is available |
| `MSG_ATTACHMENT` / `RFC822_ATTACHMENT` | Forward as Attachment (Ctrl+Alt+F) | 1.0 when the original SMTP sender is available |
| `BODY_PARSE` | Plain forward | 0–0.9 |
| `MANUAL` | Typed into the form | 1.0 if a valid address |

## The reply addressing rule

Pramod, 2026-07-15: *"you have to recognize who the original sender was of that email, **not the mailing group**. It shouldn't be sending that, but you can keep in **CC** the mailing group."*

| Field | Value |
|---|---|
| **To** | The original sender — the individual who asked |
| **Cc** | The mailing group |
| **Never To** | The mailing group |

Everything downstream depends on getting the original sender right, which is why extraction confidence is a first-class field.

## Two extraction paths

| Method | When | Confidence |
|---|---|---|
| `RFC822_ATTACHMENT` | CSR used **Forward as Attachment** (Ctrl+Alt+F) | **1.0** — structured headers, no guessing |
| `BODY_PARSE` | Plain forward — the original is prose in the body | **0–0.9** — regex over localized Outlook headers |

Body parsing handles English, German, French, Spanish, Italian, Dutch, Polish and Nordic header labels, because Outlook localizes them to the *forwarder's* client language and EDC is a European DC.

**When the sender can't be identified, the request goes to `NEEDS_REVIEW` — never a guess, never a crash.** A wrong `To` on a customer-facing email is the worst outcome here, so the CSR fills it in.

This is the case for pushing "Forward as Attachment" to CSRs: one keyboard shortcut turns a fragile multi-language regex problem into structured parsing.

## Run locally

```bash
cp .env.example .env
docker compose up --build
```

Open <http://localhost:8080> and choose **Continue as guest**. No Microsoft setup is needed for the showcase. Choose **Load demo emails** or import a saved `.msg`/`.eml`, open a request, review/edit its draft and select **Approve demo**. The result is **Approved (demo)**; no email is sent.

The POC Compose and Cloud Foundry manifest enable `GUEST_DEMO_ENABLED=true` with `AUTH_REQUIRED=true`. Each guest gets a separate session and private queue, isolated from Microsoft users and other guests. Guest mode does not connect to Outlook. **Exit demo** ends the session; a later guest session starts a new queue. With no configured `COOKIE_SECRET`, a random process-local signing key lets guest demos work immediately; restarting the backend invalidates those cookies.

Set `GUEST_DEMO_ENABLED=false` before the company-data rollout, and finish the Entra setup below. This also denies existing guest sessions. The older `AUTH_REQUIRED=false` anonymous development mode remains available, but is not needed to showcase the app.

For real intent detection put `AICORE_SERVICE_KEY` in `.env` — see [Local dev against real AI Core](#local-dev-against-real-ai-core).

### Verified against live AI Core (`so-poc-aicore`, gpt-4o-mini)

All four scenarios, end to end — ingest → parse → classify → draft → approve:

| Scenario | Extraction | Intent | Status |
|---|---|---|---|
| Forward-as-attachment | `RFC822_ATTACHMENT` @ 1.0 | Packing List Request @ 0.9 | **READY** |
| Plain forward (EN) | `BODY_PARSE` @ 0.9 | Packing List Request @ 0.8 | NEEDS_REVIEW |
| Plain forward (**DE**) | `BODY_PARSE` @ 0.9 | Invoice Request @ 0.9, `lang: de` | NEEDS_REVIEW |
| No headers | `BODY_PARSE` @ 0 | Shipment Tracking @ 0.9 | NEEDS_REVIEW — no recipient |

Two things worth knowing from that run:

**Multilingual comes free.** The German email was detected as `de`, "Rechnung" was correctly classified as an Invoice Request, and the draft came back in fluent German. Nobody built that — worth showing, given EDC serves Europe.

**The no-invented-data constraint held.** Every draft says the team is retrieving the details rather than inventing an order status. That's load-bearing: POC 1 has no ERP access, so a model that hallucinated a shipping date would be putting false information in front of a customer.

### Dev mode (hot reload)

```bash
npm install && cd backend && npm install && cd ..
docker compose up -d          # for PostgreSQL
npm run backend               # :3000
npm run dev                   # :5173, proxies /api/v1
```

For local Outlook sign-in through Vite, register and set `AZURE_REDIRECT_URI=http://localhost:5173/api/v1/auth/callback`. Keep `VITE_API_URL` unset so session cookies stay on the same origin. Load the environment variables into the backend process; the Docker setup reads `.env` through Compose.

### Validation

```bash
npm run build
npm test --prefix backend
# Optional HTTP + real PostgreSQL verification, using a disposable test database:
CS_AGENT_TEST_DATABASE_URL=postgresql://user@localhost/test_db node --test backend/integration.test.js
PLAYWRIGHT_PATH=/path/to/playwright CHROME_PATH=/path/to/chrome npm run smoke
```

The browser smoke test starts Vite on port 5174 and intercepts every API call. It checks guest entry/sample review/demo approval, login enforcement, sign-out/session expiry, Outlook search, draft preparation, duplicate handling, upload validation/retries, readable 502 errors, review navigation, and mobile layout without reading or sending real email. Set `SMOKE_BASE_URL` to use an existing Vite server instead.

## Deploy to BTP Cloud Foundry

The J&J sandbox, same place `sales-intelligence` runs:

| | |
|---|---|
| API | `https://api.cf.us10.hana.ondemand.com` |
| Org / space | `jnj-cb-sbx-ai` / `jnj-cb-sbx-so-poc` |
| AI Core instance | `so-poc-aicore` (offering `aicore`, plan `extended`) |
| Model | `gpt-4o-mini` — deployed and confirmed working |

BTP **does not build from a Dockerfile on push** — build locally for `linux/amd64`, push to a registry, deploy with `--docker-image`. The script does all of it, including binding AI Core:

```bash
./scripts/deploy-cf.sh
```

The SDK reads the binding out of `VCAP_SERVICES`, so no key goes in the manifest.

## Enabling Outlook (Microsoft Graph)

With `AUTH_REQUIRED=true`, data APIs require a Microsoft or enabled guest session. Before Entra setup, the showcase entry screen offers **Continue as guest** when `GUEST_DEMO_ENABLED=true`. Disable guest access for a company-only deployment; missing Entra configuration then blocks workspace access. The frontend waits for the authentication check before loading the queue.

`AUTH_REQUIRED` defaults to `true` with `NODE_ENV=production`; set it explicitly for your environment. The same Microsoft sign-in grants delegated Outlook access. A specific tenant GUID and a random `COOKIE_SECRET` of at least 32 characters are required. The backend uses authorization code with PKCE, nonce/state validation, signed HttpOnly cookies, and an eight-hour session lifetime. J&J passwords are entered only on Microsoft’s sign-in page.

Each user has a private imported-email queue, drafts, counts and audit access. Existing unowned/demo rows are preserved and remain accessible only in anonymous demo mode; they are not assigned to a signed-in employee automatically. Upload duplicates are detected by content hash within the user's queue.

### Option A — a dev tenant you own (try it this week, no waiting)

1. Use a development Microsoft 365 tenant with a licensed Exchange Online test mailbox and permission to register/approve apps.
2. **Entra admin → App registrations → New registration**
   - Supported accounts: **Accounts in this organizational directory only**
   - Redirect URI (Web): `http://localhost:8080/api/v1/auth/callback` (local) or the CF URL for the deployed app
   - **API permissions → Microsoft Graph → Delegated:** `User.Read`, `Mail.Read`, `Mail.Send`; sign-in also requests `openid`, `profile`, `offline_access`. Have the tenant administrator approve the requested access.
   - **Certificates & secrets → New client secret**
3. Put the values in `.env`:
   ```
   AZURE_CLIENT_ID=...
   AZURE_CLIENT_SECRET=...
   AZURE_TENANT_ID=...          # the dev tenant's Directory (tenant) ID
   AZURE_REDIRECT_URI=http://localhost:8080/api/v1/auth/callback
   COOKIE_SECRET=<at least 32 random characters>
   AUTH_REQUIRED=true
   GUEST_DEMO_ENABLED=false
   ```
4. `docker compose up --build` → open the app → **Sign in with J&J account** → **Find emails** → **Prepare draft** → review → **Approve & send via Outlook**.

Use synthetic test mailboxes. Validate sign-in, search, draft review and an explicitly approved test send before enabling company users. Live J&J verification requires the actual tenant configuration.

### Option B — J&J tenant (the real target)

Use the same delegated scopes, with the J&J tenant GUID and approval from J&J IT. IT should restrict the enterprise application to approved users/groups. See
[`JNJ-IT-App-Registration-Request.md`](../JNJ-IT-App-Registration-Request.md) —
use that request for the IT intake, and when IT returns the client ID / tenant ID / secret, set
them via `cf set-env` (redirect URI = the CF app URL) and restart. **No code
changes** between Option A and Option B.

```bash
cf set-env cs-agent AZURE_CLIENT_ID     "<from IT>"
cf set-env cs-agent AZURE_CLIENT_SECRET "<from IT>"
cf set-env cs-agent AZURE_TENANT_ID     "<from IT>"
cf set-env cs-agent AZURE_REDIRECT_URI  "https://cs-agent.cfapps.us10.hana.ondemand.com/api/v1/auth/callback"
cf set-env cs-agent COOKIE_SECRET       "<at least 32 random characters>"
cf set-env cs-agent AUTH_REQUIRED        "true"
cf set-env cs-agent GUEST_DEMO_ENABLED   "false"
cf restart cs-agent
```

### Local dev against real AI Core

`.env` needs `AICORE_SERVICE_KEY`. To mint one from the sandbox instance:

```bash
cf create-service-key so-poc-aicore cs-agent-local
cf service-key so-poc-aicore cs-agent-local     # copy the credentials object into .env
```

`.env` is gitignored. Revoke the key when you're done with it:

```bash
cf delete-service-key so-poc-aicore cs-agent-local
```

Without a key the app still runs — intent detection falls back to a keyword stub and the header says "AI Core not bound".

## Architecture

```
Browser → nginx (:PORT from CF)
            ├── /        → React SPA (dist/)
            └── /api/v1  → Express (:3000 internal)
                             ├── PostgreSQL (:5432, bundled in the image)
                             └── SAP AI Core (orchestration SDK)
```

Same single-image pattern as `Sales_Intelligence` — nginx + Node + bundled PostgreSQL.

**Why bundled PostgreSQL:** it removes HANA Cloud from POC 1's critical path. The target architecture says HANA Cloud, and `db.js` is the only file that needs to change when it's provisioned.

## Ingestion is pluggable

Every adapter produces one normalized email object; nothing downstream knows which was used.

```
manual paste  ─┐
.eml/.msg     ─┤
Graph poll    ─┼──► InboundEmail ──► agent ──► draft ──► review
Graph webhook ─┘     (normalized)
```

| Adapter | Status |
|---|---|
| `ingestManual` | ✅ working |
| `ingestUploadedEmail` (`ingestEml` alias) | ✅ `.msg` and `.eml`, direct messages and forwarded attachments |
| `ingestGraphMessage` | ✅ implemented; live use requires Entra app registration and sign-in |
| Graph webhook | Phase 3 |

`backend/email/ingest.js` is the seam. Landing Graph is one adapter, not a refactor — which is also what makes this reusable for the other use cases Pramod mentioned (*"many of our use cases will have that requirement"*).

## Known issue: `requesterType` is unreliable

On the verified run the model returned `FRANCHISE_CS` for **all four** scenarios — including `john.smith@acmecorp.com`, who is plainly an end customer, not a franchise CS person.

This matters more than it looks. Per the business model, requests come either from a franchise's CS group or from an end customer directly, and the future business rules are keyed on exactly that distinction — Pramod, 2026-07-15: *"if this mailing group, if this region is asking, or this particular group of people are asking, then... maybe you don't send invoice."*

**So an LLM guessing from an email address cannot be the source of truth for it.** It needs a lookup against customer master / a mailing-group config table — deterministic and auditable. Which is the same conclusion the requirements doc reaches about the rules generally: they can't live in a prompt.

Harmless in POC 1 (the field is displayed, nothing depends on it). Do not carry it into POC 2 as-is.

## What's deliberately missing

| Gap | Why |
|---|---|
| **Sending without Outlook** | Guests can approve a demo, recorded as `APPROVED` with `sent:false`. Guests cannot call Graph. For Microsoft users an expired/missing Outlook token prompts sign-in and never marks the reply sent. |
| **Graph auto-polling** | Outlook messages are found on demand using the search command. Unattended ingestion and Graph subscriptions are not implemented. |
| **ERP data / documents** | POC 2 |
| **Business rules** | Full project |
| **Production hardening** | Entra sign-in and private queues are implemented. IT must still approve users, data retention and protected token/database storage. The shared MSAL cache is serialized for one backend process; implement distributed locking or partitioned caches before scaling. |

### On sending: don't use SMTP

This app uses Microsoft Graph to read the signed-in user’s Inbox and send approved replies from that user’s Exchange Online mailbox. It does not require SMTP credentials. See [Microsoft’s delegated-access guide](https://learn.microsoft.com/en-us/graph/auth-v2-user).

## Saved Outlook files and troubleshooting

The upload control accepts `.msg` and `.eml` files up to 32 MB. Binary MSG decoding runs in an isolated worker with a five-second timeout and a heap limit. Original sender, body, recipients, date and attachment metadata feed the existing review workflow; nested message attachments use the correct decoder. Exchange directory identifiers without an SMTP address stay unresolved and require review. Attachment contents are not analyzed.

Malformed, unsupported or oversized files return actionable 400/413 responses. Protected/encrypted messages and MSG files containing only compressed Rich Text cannot be decoded by this implementation; the UI explains the limitation. HTML and plain-text MSG bodies are supported. Renaming a file extension does not convert its contents.

A proxy 502 means the upstream API failed or was unavailable; it does not identify the cause by itself. The previous code had no binary MSG decoder. These changes add one and handle parser errors, but a reported deployed 502 still needs correlation with the Cloud Foundry app/container logs. Verify the deployed image contains this version, the backend is healthy, and the container has sufficient memory. Callback query strings are excluded from the application/nginx access logs.


## Layout

```
backend/
  server.js            REST API
  agent.js             intent + draft (AI Core), status decision, reply addressing
  ai-core.js           orchestration SDK wrapper — adapted from Sales_Intelligence
  db.js                schema + queries (swap for HANA later)
  scenarios.js         demo emails as real MIME
  email/
    parser.js          ★ forwarded-email → original sender
    ingest.js          ★ the adapter seam
src/
  App.tsx              Outlook-first shell, tiles, queue
  components/
    MailboxPanel.tsx   Outlook connection, natural-language search, draft preparation
    IngestPanel.tsx    .msg/.eml import / manual entry
    QueueTable.tsx     work queue
    RequestDetail.tsx  three-pane review
```

The two starred files are the POC.
