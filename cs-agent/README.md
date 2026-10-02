# AI4U Email Operations

Ask for customer emails in Outlook → identify requests and order references → prepare reply drafts → review and approve.

Outlook search is the primary workflow. Saved email uploads, manual entry, and sample emails remain under **Import an email manually**. No live ERP calls or SAP document retrieval are implemented.

The point of POC 1 is to retire the risk he named: *"everybody challenged with this — email integration, SMTP not being supported... Everybody's failing there. So if we can crack that nut."*

## What works today

- **Find emails in Outlook** by describing the request, such as **“Find sales orders from email”**, **“Find invoices this week”**, or **“Find packing lists for order 5003000237”**
- **Inspect matches** with sender, subject, message preview, matching reason, and order references found in the email
- **Prepare drafts** for one or all matches; existing requests are reused and individual failures can be retried
- **Import manually** as a secondary option: upload a forwarded `.eml`, type an email, or load sample scenarios
- **Recover the original sender** from the forward — the load-bearing part
- **Detect intent** + extract the order number via SAP AI Core
- **Draft a reply** addressed per the rule below
- **Review and approve** — and, when signed in to Outlook, **actually send** the reply via Microsoft Graph
- **Full audit trail**; runs as **one Docker image** on BTP Cloud Foundry

## Outlook search workflow

1. Configure Microsoft Graph using the instructions below, then select **Connect Outlook** and sign in.
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
| `RFC822_ATTACHMENT` | Forward as Attachment (Ctrl+Alt+F) | 1.0 |
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

Open <http://localhost:8080>. Connect Outlook to find real emails, or expand **Import an email manually** and choose **Load scenario emails** for sample data.

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
PLAYWRIGHT_PATH=/path/to/playwright CHROME_PATH=/path/to/chrome npm run smoke
```

The browser smoke test starts Vite on port 5174 and intercepts every API call. It checks Outlook setup/sign-in states, search, draft preparation, duplicate handling, partial failures, review navigation, and mobile layout without reading or sending real email. Set `SMOKE_BASE_URL` to use an existing Vite server instead.

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

The Outlook search panel is always visible. Without the `AZURE_*` configuration
(see `.env.example`), it shows **Outlook setup required**. Microsoft sign-in and
live search become available once configured. Same code, two tenants:

### Option A — a dev tenant you own (try it this week, no waiting)

1. Get a free **Microsoft 365 Developer** tenant (`developer.microsoft.com/microsoft-365/dev-program`) — comes with demo mailboxes and users. You're the admin, so you self-consent in minutes.
2. **Entra admin → App registrations → New registration**
   - Redirect URI (Web): `http://localhost:8080/api/v1/auth/callback` (local) or the CF URL for the deployed app
   - **API permissions → Microsoft Graph → Delegated:** `User.Read`, `Mail.Read`, `Mail.Send`, `offline_access` → **Grant admin consent**
   - **Certificates & secrets → New client secret**
3. Put the values in `.env`:
   ```
   AZURE_CLIENT_ID=...
   AZURE_CLIENT_SECRET=...
   AZURE_TENANT_ID=...          # the dev tenant's Directory (tenant) ID
   AZURE_REDIRECT_URI=http://localhost:8080/api/v1/auth/callback
   COOKIE_SECRET=<long random string>
   ```
4. `docker compose up --build` → open the app → **Connect Outlook** → **Find emails** → **Prepare draft** → review → **Approve & send via Outlook**.

Demo with the tenant's synthetic mailboxes. Everything works end to end, including a real send that lands in Sent Items.

### Option B — J&J tenant (the real target)

Same four permissions, granted by J&J IT in the J&J Entra tenant. See
[`JNJ-IT-App-Registration-Request.md`](../JNJ-IT-App-Registration-Request.md) —
send that request, and when IT returns the client ID / tenant ID / secret, set
them via `cf set-env` (redirect URI = the CF app URL) and restart. **No code
changes** between Option A and Option B.

```bash
cf set-env cs-agent AZURE_CLIENT_ID     "<from IT>"
cf set-env cs-agent AZURE_CLIENT_SECRET "<from IT>"
cf set-env cs-agent AZURE_TENANT_ID     "<from IT>"
cf set-env cs-agent AZURE_REDIRECT_URI  "https://cs-agent.cfapps.us10.hana.ondemand.com/api/v1/auth/callback"
cf set-env cs-agent COOKIE_SECRET       "<long random string>"
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
.eml upload   ─┤
Graph poll    ─┼──► InboundEmail ──► agent ──► draft ──► review
Graph webhook ─┘     (normalized)
```

| Adapter | Status |
|---|---|
| `ingestManual` | ✅ working |
| `ingestEml` | ✅ working |
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
| **Sending without Outlook** | If **not** signed in to Outlook, Approve records the decision but doesn't send. Signed in, it sends for real via Graph `sendMail`. |
| **Graph auto-polling** | Outlook messages are found on demand using the search command. Unattended ingestion and Graph subscriptions are not implemented. |
| **ERP data / documents** | POC 2 |
| **Business rules** | Full project |
| **App auth (XSUAA)** | The app itself has no gate — anyone with the URL can use the non-Outlook features. Outlook actions require Microsoft sign-in, but the app shell should still get XSUAA before real customer data. |

### On sending: don't use SMTP

Microsoft removed Basic Auth for SMTP AUTH in Exchange Online, and a BTP app sending as `@jnj.com` from SAP's IP ranges fails SPF/DKIM/DMARC and lands in junk. Graph `sendMail` sidesteps both: the mail leaves J&J's own Exchange tenant from a real mailbox and inherits its reputation. See `../Phase1-Email-Forward-Approach.md` §11.

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
    IngestPanel.tsx    secondary .eml import / manual entry
    QueueTable.tsx     work queue
    RequestDetail.tsx  three-pane review
```

The two starred files are the POC.
