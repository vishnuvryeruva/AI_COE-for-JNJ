# Request to J&J IT — Azure AD App Registration for AI4U CS Agent

**Requested by:** Vishnu Yeruva (GTSUS, AI COE)
**Sponsor:** Pramod Naik
**Date:** 2026-07-17
**Purpose:** Allow the AI4U Customer Service Agent (a BTP app) to let a signed-in CSR read their own Outlook inbox and send replies from it, via Microsoft Graph.

---

## What this is

A proof-of-concept app on SAP BTP that helps EDC customer service reps answer customer emails: it reads an email the CSR selects, drafts a reply with AI, and — after the CSR reviews and approves — sends the reply. It is already running and working; the only missing piece is permission to connect to Outlook.

We are **not** asking for tenant-wide mailbox access. This uses **delegated** permissions only: the app can act **solely as the individual CSR who has signed in**, on **their own mailbox**, and only while they are signed in. It cannot read anyone else's mail and has no standing/background access.

---

## Exactly what we need registered

| Setting | Value |
|---|---|
| **Directory** | Azure AD (Microsoft Entra ID), J&J tenant |
| **Application type** | Web app (confidential client — has a backend) |
| **Sign-in audience** | Accounts in this organizational directory only (single tenant) |
| **Redirect URI (production)** | `https://cs-agent.cfapps.us10.hana.ondemand.com/api/v1/auth/callback` |
| **Redirect URI (dev/local, optional)** | `http://localhost:8080/api/v1/auth/callback` |
| **Client secret** | One secret (or a certificate — we can provide a CSR if preferred) |
| **Token type** | Standard OAuth2 authorization-code flow |

### Microsoft Graph permissions — **Delegated** (not Application)

| Permission | Why |
|---|---|
| `User.Read` | Identify the signed-in CSR (name, email) |
| `Mail.Read` | Show the CSR their own inbox so they can pick an email to process |
| `Mail.Send` | Send the approved reply as the CSR |
| `offline_access` | Refresh the session so the CSR isn't re-prompted constantly |

**Admin consent** will be required (J&J blocks user self-consent) — please grant it for the four delegated scopes above.

### What we will receive back from IT

- **Application (client) ID**
- **Directory (tenant) ID**
- **Client secret value** (or confirmation a provided certificate was uploaded)

We plug these into the app as environment variables. No mailbox credentials, no passwords, nothing that identifies a user is stored by the app.

---

## Why delegated (and why this is low-risk)

- The app never has its own mailbox rights. Every read/send happens **on behalf of the signed-in CSR**, scoped to that one person's mailbox, and stops the moment they sign out.
- This is the same permission model as any "Sign in with Microsoft, then show me my mail" application.
- Contrast with **Application** permissions (e.g. `Mail.Read` as an application), which would grant tenant-wide mailbox access — **we are explicitly not requesting that.**
- The CSR stays in control: nothing sends without them clicking **Approve**.

---

## Data handling (for the security review)

- The app stores incoming email content and the AI-generated draft in its own database (SAP HANA/PostgreSQL on BTP) to show the work queue and an audit trail.
- AI processing uses **SAP AI Core** (already provisioned in the J&J BTP sandbox, `so-poc-aicore`) — email content is sent there for classification and drafting. No third-party AI outside the J&J BTP tenant is used.
- This is a POC on non-production data initially. We're happy to complete whatever DPIA / security intake is standard.

---

## Contacts

- **Requestor:** Vishnu Yeruva — <vishnuvardhan.reddy98@yahoo.com> (update to J&J address)
- **Sponsor:** Pramod Naik
- **App URL:** https://cs-agent.cfapps.us10.hana.ondemand.com
- **BTP location:** org `jnj-cb-sbx-ai`, space `jnj-cb-sbx-so-poc` (us10)

---

## Appendix — how to register it (if IT wants the click-path)

1. **Entra admin center → App registrations → New registration**
   - Name: `AI4U CS Agent`
   - Supported account types: *Accounts in this organizational directory only*
   - Redirect URI: *Web* → `https://cs-agent.cfapps.us10.hana.ondemand.com/api/v1/auth/callback`
2. **Certificates & secrets → New client secret** (note the value; it's shown once)
3. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**
   - Add `User.Read`, `Mail.Read`, `Mail.Send`, `offline_access`
   - **Grant admin consent**
4. Send us: Application (client) ID, Directory (tenant) ID, client secret value.

> If you'd rather scope even tighter, we can also work against a single dedicated shared mailbox with an `ApplicationAccessPolicy` — happy to discuss which model J&J prefers. The delegated model above needs no dedicated mailbox and is the smallest ask.
