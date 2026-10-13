# JNJ email response application — upgrade requirements

Updated: 2026-10-06. This records the user's clarified target workflow and the remaining integration decisions. It describes planned behavior, not functionality already implemented.

## Confirmed product requirements

- The application is for internal JNJ teams. The user describes a broader JNJ application, so the existing EDC-specific behavior needs to be revisited during implementation.
- For an incoming email, understand the message and any supported attached documents to determine the request and relevant identifiers.
- Retrieve the relevant facts from backend SAP systems and use those facts to compose an appropriate reply.
- Where available and in scope, retrieve supporting documents from an enterprise document source. The user explicitly considers this feature and its source uncertain.
- An internal reviewer must manually approve the reply before it is sent. Classification confidence, a successful SAP call, or an ATP result never authorizes sending.

Internal-only application access does not establish whether email senders or recipients must also be internal; that policy remains open.

## Intended workflow

1. Receive an email through the agreed ingestion service, retaining its mailbox, message, conversation, sender, recipient, and attachment references.
2. Extract content from supported attachments and interpret it together with the email body. Treat email and document content as request data, not as application instructions or authorization to perform actions.
3. Identify the requested information or documents and validate the identifiers needed for retrieval. Route missing, conflicting, or unreadable information to the reviewer rather than inventing values.
4. Retrieve relevant SAP data and, if the document capability is confirmed, supporting documents. Record the source references and retrieval time.
5. Prepare a reply grounded in the retrieved evidence. Indicate unavailable information to the reviewer; do not invent statuses, dates, quantities, or document contents.
6. Present the original email, attachment findings, retrieved evidence, proposed recipients, reply text, and any outgoing documents or links for review.
7. Allow an authorized reviewer to edit, reject, or explicitly approve the final reply.
8. Send the approved reply through the agreed sending service and record its actual outcome.

The SAP availability/ATP material supplied earlier can support relevant requests within this workflow. Whether the next milestone includes CheckATP alone or both SAP APIs and reliability rules remains undecided. Those documents describe read/simulation capabilities; SAP order updates or reservations are outside that supplied scope.

## Implementation criteria for manual approval

These criteria translate the confirmed approval requirement into enforceable behavior:

- Enforce authorization on the server and derive reviewer identity from the authenticated session.
- Bind approval to a specific version of the subject, body, To/Cc recipients, and outgoing attachments or links.
- Changes to an approved, unsent payload require a new review and approval. A concurrent edit must not result in sending content the reviewer did not see.
- Sending must require a valid approval, including when an external service owns outbound mail.
- Repeated clicks, callbacks, or retries must not create duplicate send intents. An uncertain provider outcome must be reconciled before retrying.
- Keep approval, provider handoff, send acceptance, failure, and unknown outcome distinguishable. Never label an unsent approval as sent; provider acceptance must not be described as confirmed recipient delivery.
- Preserve the approved payload, reviewer and time, source evidence, and outbound service reference/outcome for audit.

## Ownership and decisions still open

| Area | Input needed |
|---|---|
| Email ingestion | Confirm the other JNJ team's ownership and whether it pushes emails, exposes an API, or provides extracted fields. Obtain its contract and a sanitized example, including attachment access, message/mailbox identity, and retry/duplicate behavior. |
| Outbound email | Confirm whether that team also sends approved replies, the sending mailbox, threading behavior, and the acknowledgement/failure contract. |
| Recipients and access | Confirm whether external recipients are allowed, which teams/mailboxes participate in the first rollout, and who may view and approve each request. |
| Attachment reading | Agree initial file types, scanned-document/OCR needs, size limits, and handling of unreadable or password-protected files. Reading inbound attachments is distinct from retrieving outgoing documents. |
| Document source | Clarify whether “DMS on BTP” means SAP Document Management Service, the DMS-100 S/4HANA system referenced in the screenshots, another repository, or an unconfirmed source. Do not assume these names refer to the same system. |
| Outgoing documents | If retrieval is included, agree document types and lookup identifiers, access rules, and whether replies contain files, links, or summaries. |
| SAP integrations | Agree the first request types and their APIs. Obtain deployed endpoints, metadata/OpenAPI, representative requests/responses, authentication configuration, and an integration owner. The supplied ATP paths differ between `/001` and `/0001`. |
| ATP/reliability | Resolve requested delivery versus availability date, mandatory input sources, multi-line requests, and ownership of approved reliability rules. Keep reliability separate from email interpretation confidence. |
| Joule/MCP | The internal application workflow is confirmed; any additional Joule channel and ownership of the MCP service still need to be established. |

## Current implementation gaps

- The app already has on-demand Outlook search and manual import, but no external-team intake contract.
- The agent currently drafts acknowledgements and has no live SAP data or document retrieval.
- The agent does not read attachment contents; the Graph adapter currently omits attachments.
- The review screen has an explicit approval action, but the backend lacks draft-version approval, duplicate-send protection, and general reviewer authorization.
- Offline approval currently sets `SENT` despite returning `sent: false`; this must change before integrating an external sender.
- Request storage and the queue lack per-team/mailbox ownership and SAP evidence/assessment structures.

## Verification scenarios for implementation

- A reply grounded in email text, supported attachment content, and SAP evidence remains unsent until an authorized person approves it.
- Missing SAP data, unavailable documents, and unreadable attachments are visible to the reviewer and do not produce fabricated answers.
- Editing recipients, content, or documents after approval prevents sending until approval is renewed.
- Concurrent editing and approval cannot send an unreviewed version; repeated approval cannot generate duplicate sends.
- An unavailable sending service leaves an accurate pending/failed/unknown outcome instead of a false sent status.
- A user outside the permitted team/mailbox cannot inspect or approve a request.

