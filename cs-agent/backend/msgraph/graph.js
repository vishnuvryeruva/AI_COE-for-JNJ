/**
 * Thin Microsoft Graph REST helpers. Node 20 has global fetch, so no SDK.
 * Everything here is delegated (/me = the signed-in CSR's own mailbox).
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function graphGet(token, path) {
  const res = await fetch(`${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph GET ${path} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function graphPost(token, path, payload) {
  const res = await fetch(`${GRAPH}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok && res.status !== 202) {
    const body = await res.text();
    throw new Error(`Graph POST ${path} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.status === 202 ? {} : res.json().catch(() => ({}));
}

async function getMe(token) {
  const me = await graphGet(token, '/me?$select=displayName,mail,userPrincipalName');
  return { name: me.displayName, email: me.mail || me.userPrincipalName };
}

/** Inbox listing for the picker — light fields only. */
async function listInbox(token, top = 25) {
  const select = 'id,internetMessageId,subject,from,receivedDateTime,bodyPreview,hasAttachments';
  const data = await graphGet(
    token,
    `/me/mailFolders/inbox/messages?$top=${top}&$select=${select}&$orderby=receivedDateTime desc`
  );
  return (data.value || []).map((m) => ({
    id: m.id,
    internetMessageId: m.internetMessageId,
    subject: m.subject,
    from: m.from?.emailAddress?.address || null,
    fromName: m.from?.emailAddress?.name || null,
    receivedAt: m.receivedDateTime,
    preview: m.bodyPreview,
    hasAttachments: m.hasAttachments,
  }));
}

/** Full message, for ingestion. Structured — no MIME parsing needed. */
async function getMessage(token, id) {
  const select = 'id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,body';
  return graphGet(token, `/me/messages/${id}?$select=${select}`);
}

/**
 * Send a reply. Delegated, so it goes out FROM the signed-in CSR — which is
 * exactly right: the customer gets a reply from a person, not a robot address.
 */
async function sendMail(token, { to, cc = [], subject, body }) {
  const toRecipients = [{ emailAddress: { address: to } }];
  const ccRecipients = cc.map((address) => ({ emailAddress: { address } }));
  await graphPost(token, '/me/sendMail', {
    message: {
      subject,
      body: { contentType: 'Text', content: body },
      toRecipients,
      ccRecipients,
    },
    saveToSentItems: true,
  });
}

module.exports = { getMe, listInbox, getMessage, sendMail };
