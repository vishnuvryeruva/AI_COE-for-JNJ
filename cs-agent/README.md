# AI4U CS Agent — POC 1

Ingest a forwarded customer email → detect intent → draft a reply → human approves.

**Scope is deliberately narrow.** Pramod, 2026-07-15: *"First, we need to ingest the email, know the intent and draft an email. That is my first POC."* No ERP calls, no document retrieval — that's POC 2. Business rules are the full project.

The point of POC 1 is to retire the risk he named: *"everybody challenged with this — email integration, SMTP not being supported... Everybody's failing there. So if we can crack that nut."*

## What works today

- **Ingest** a forwarded `.eml` (drag-drop), or type an email in manually
- **Recover the original sender** from the forward — the load-bearing part
- **Detect intent** + extract the order number via SAP AI Core
- **Draft a reply** addressed per the rule below
- **Review and approve** with a full audit trail
- Runs as **one Docker image** on BTP Cloud Foundry

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

Open <http://localhost:8080> and click **Load scenario emails**.

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
| `ingestGraphMessage` | 🔲 shape in place, blocked on AAD app registration |
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
| **Sending** | Approve records the decision; delivery is Graph `sendMail`, pending AAD app registration |
| **Graph polling** | Same blocker. See `../Phase1-Email-Forward-Approach.md` §5 |
| **ERP data / documents** | POC 2 |
| **Business rules** | Full project |
| **Auth** | No XSUAA yet — anyone with the URL can act. Fine for a POC, **not** for real customer data |

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
  App.tsx              shell, tiles, queue
  components/
    IngestPanel.tsx    drop .eml / manual entry
    QueueTable.tsx     work queue
    RequestDetail.tsx  three-pane review
```

The two starred files are the POC.
