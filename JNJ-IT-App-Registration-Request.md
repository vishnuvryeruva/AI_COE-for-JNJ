# J&J IT request: Microsoft sign-in and Outlook access for AI4U CS Agent

**Prepared:** October 14, 2026

**Requestor:** Vishnu Yeruva, AI COE

**Business sponsor:** Pramod Naik

**Status:** Ready for IT review; registration/consent and live J&J validation are pending.

## Request

Please register **AI4U CS Agent** as a single-tenant web application in J&J’s Microsoft Entra tenant and approve delegated Microsoft Graph access for an assigned pilot group.

Employees will select **Sign in with J&J account**, authenticate on Microsoft’s sign-in page using the organization’s existing credentials/MFA, and search their own Outlook Inbox from the application. They can import selected emails, prepare a draft, review it, and explicitly approve sending from their own mailbox. The application never collects J&J passwords.

The code includes Outlook search and draft preparation, app-wide sign-in enforcement, private queues for each signed-in user, and `.msg`/`.eml` upload as an alternative. The updated version has not yet been deployed or validated against J&J’s tenant.

## Registration settings

| Setting | Requested value |
|---|---|
| Application name | `AI4U CS Agent` |
| Supported accounts | Accounts in this organizational directory only |
| Platform | Web — confidential backend client |
| Authentication | Authorization code with PKCE, state and nonce validation |
| Enterprise application assignment | Require assignment; assign the approved pilot users/security group |
| Production callback | `https://cs-agent.cfapps.us10.hana.ondemand.com/api/v1/auth/callback` — confirm this against the actual approved deployment route before registering |
| Optional local callback | `http://localhost:8080/api/v1/auth/callback` for Docker, or `http://localhost:5173/api/v1/auth/callback` for Vite development; register only those approved for testing |
| Credential | Client secret held only in backend deployment secrets, with an owner and rotation/expiry date |
| Tenant policies | Apply J&J’s normal Conditional Access, MFA and access policies |

The current implementation uses a client secret. If policy requires certificate authentication or a different credential mechanism, please identify that requirement; additional implementation is needed before using it.

## Permissions and consent

Approve these **delegated Microsoft Graph permissions**:

| Permission | Purpose |
|---|---|
| `User.Read` | Retrieve the signed-in employee’s basic profile/mailbox address |
| `Mail.Read` | Read the signed-in employee’s Inbox messages and bodies for search and import |
| `Mail.Send` | Send only when the employee explicitly selects **Approve & send via Outlook** |

The sign-in flow also requests the OpenID Connect scopes `openid`, `profile` and `offline_access` for identity and token refresh. Please review and grant the required consent under J&J policy. We are not requesting application permissions, `Mail.ReadWrite`, shared-mailbox permissions or unattended mailbox ingestion.

The implementation calls Microsoft Graph `/me` endpoints. Search reads up to 200 recent Inbox messages, on request. It does not search all folders or attachment contents. Graph permission scopes themselves are broader than the UI’s limited search; IT should assess the delegated permissions accordingly.

## Information to return

- Application (client) ID.
- Directory (tenant) ID, as the explicit tenant GUID.
- Confirmation of approved permissions/consent and pilot user/group assignment.
- Exact registered callback URL.
- Client secret delivered through an approved secret-management channel, plus expiry and rotation owner. Do not place secrets in this document, chat, email or source control.

## Deployment configuration

The app administrator will configure these backend settings through approved deployment secret/environment management:

| Setting | Value |
|---|---|
| `AUTH_REQUIRED` | `true` |
| `GUEST_DEMO_ENABLED` | `false` for the company rollout |
| `AZURE_CLIENT_ID` | IT-provided client ID |
| `AZURE_TENANT_ID` | J&J tenant GUID; `common`/`organizations` are not accepted |
| `AZURE_CLIENT_SECRET` | IT-provided secret |
| `AZURE_REDIRECT_URI` | Exact registered Web callback URL |
| `COOKIE_SECRET` | Independently generated random value of at least 32 characters; `openssl rand -hex 32` is suitable |
| `AZURE_POST_LOGIN_URI` | `/` |

Deploy the reviewed image in the correct J&J BTP organization/space and restart after configuration. The intended location recorded in the repository is org `jnj-cb-sbx-ai`, space `jnj-cb-sbx-so-poc`, region us10; verify the active Cloud Foundry target before making changes.

The temporary showcase configuration enables `GUEST_DEMO_ENABLED=true`: users can select **Continue as guest** without Entra setup. Each guest has a separate session/queue and can import sample emails, review drafts and record demo approvals; guests cannot access Outlook or send mail. For the company rollout, set `GUEST_DEMO_ENABLED=false` and `AUTH_REQUIRED=true`. Missing Entra configuration then blocks workspace access. `AUTH_REQUIRED=false` is an older anonymous development mode, not required for the showcase.

## Data handling and pilot boundaries

- PostgreSQL stores imported email content, attachment metadata, draft replies and audit events. Search results are returned to the signed-in user; a request is persisted when a message is imported/prepared.
- Each signed-in account has its own saved queue. The API applies ownership checks to reads, edits, audit access, approvals and deduplication. Legacy anonymous/demo records are retained separately.
- The database stores account identifiers, usernames, browser sessions and the serialized MSAL token cache, including refresh tokens. Signing out deletes the current app session; it does not revoke Microsoft consent or delete the cached account tokens.
- App sessions expire server-side after eight hours. OAuth transactions expire after ten minutes. Session cookies are signed and HttpOnly, and use Secure on HTTPS. Browser mutations are checked for the expected origin.
- Email content used for classification/drafting goes to the configured SAP AI Core service. IT should confirm the configured model provider, processing region and approved data use; this request does not assert that model processing remains within a particular tenant or region.
- The POC currently bundles PostgreSQL with the application. Before company-data use, agree on protected token/database storage, backup, retention/deletion, access logging and deployment persistence. The MSAL cache supports one backend process; multi-instance operation needs distributed coordination or partitioning.
- Begin with synthetic messages in approved pilot mailboxes. Shared mailboxes, background synchronization and SAP document retrieval are separate integration work.

## Acceptance checks after IT setup

1. Open the app signed out: email data is unavailable until sign-in.
2. Sign in as an assigned J&J pilot user and complete the tenant’s required verification. Confirm wrong-tenant and unassigned users cannot access the app.
3. Find a known synthetic message in that user’s Inbox and prepare a draft. Confirm search/import does not send mail.
4. Sign in as a second pilot user in a separate browser. Confirm each sees only their own queue and cannot open the other’s request URL.
5. Upload a synthetic Outlook `.msg` and an `.eml`; confirm sender, subject, body and review workflow. Invalid files should return a readable error.
6. After separate explicit test-send approval, send one reviewed reply to an approved test recipient and check Sent Items. Expired/revoked Outlook access must prompt reconnection without marking the reply sent.
7. Sign out and confirm the application clears visible email data and invalidates the session.

## Microsoft references

- [Authorization code flow and PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Single-tenant application audience](https://learn.microsoft.com/en-us/entra/identity-platform/single-and-multi-tenant-apps)
- [Delegated Microsoft Graph access](https://learn.microsoft.com/en-us/graph/auth-v2-user)
- [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
