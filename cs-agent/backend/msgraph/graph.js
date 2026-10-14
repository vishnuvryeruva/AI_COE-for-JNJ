/**
 * Thin Microsoft Graph REST helpers. Node 20 has global fetch, so no SDK.
 * Everything here is delegated (/me = the signed-in CSR's own mailbox).
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const { htmlToText } = require('../email/parser');
const { parseMailboxQuery, matchMailboxMessage } = require('./mailbox-query');

class GraphError extends Error {
  constructor(status) {
    super(`Microsoft Graph request failed (${status}).`);
    this.name = 'GraphError';
    this.status = status;
  }
}

function graphUrl(path) {
  const url = new URL(path.startsWith('/') ? `${GRAPH}${path}` : path);
  if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/') || url.username || url.password) {
    throw new Error('Microsoft Graph returned an invalid pagination URL.');
  }
  return url.href;
}

async function graphGet(token, path, headers = {}) {
  const res = await fetch(graphUrl(path), {
    headers: { Authorization: `Bearer ${token}`, ...headers },
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!res.ok) {
    // Do not return Graph response bodies, which can contain mailbox details.
    throw new GraphError(res.status);
  }
  return res.json();
}

async function graphPost(token, path, payload) {
  const res = await fetch(graphUrl(path), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!res.ok && res.status !== 202) {
    throw new GraphError(res.status);
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
  return (data.value || []).map(inboxMessage);
}

function inboxMessage(m) {
  return {
    id: m.id,
    internetMessageId: m.internetMessageId,
    subject: m.subject,
    from: m.from?.emailAddress?.address || null,
    fromName: m.from?.emailAddress?.name || null,
    receivedAt: m.receivedDateTime,
    preview: m.bodyPreview,
    hasAttachments: m.hasAttachments,
  };
}

/**
 * Search a bounded set of the signed-in user's Inbox with full message bodies.
 * Dates constrain Graph pagination; sender/category/reference filters are local.
 * See https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
 */
async function searchInbox(token, prompt, { now = new Date() } = {}) {
  const parsed = parseMailboxQuery(prompt, now);
  const maxMessages = 200;
  const maxPages = 10;
  const params = new URLSearchParams({
    '$top': '50',
    '$select': 'id,internetMessageId,subject,from,receivedDateTime,bodyPreview,body,hasAttachments',
    '$orderby': 'receivedDateTime desc',
  });
  const dateFilters = [];
  if (parsed.query.since) dateFilters.push(`receivedDateTime ge ${parsed.query.since}`);
  if (parsed.query.before) dateFilters.push(`receivedDateTime lt ${parsed.query.before}`);
  if (dateFilters.length) params.set('$filter', dateFilters.join(' and '));
  let next = `/me/mailFolders/inbox/messages?${params}`;
  let scanned = 0;
  let pages = 0;
  let limited = false;
  const messages = [];
  const seen = new Set();
  const visited = new Set();
  while (next && scanned < maxMessages && pages < maxPages) {
    const url = graphUrl(next);
    if (visited.has(url)) throw new Error('Microsoft Graph returned a repeated pagination URL.');
    visited.add(url);
    const page = await graphGet(token, next, { Prefer: 'outlook.body-content-type="text"' });
    if (!Array.isArray(page.value)) throw new Error('Microsoft Graph returned an invalid message list.');
    pages++;
    const remaining = maxMessages - scanned;
    for (const message of page.value.slice(0, remaining)) {
      scanned++;
      if (!message.id || seen.has(message.id)) continue;
      seen.add(message.id);
      const content = message.body?.content || '';
      const body = message.body?.contentType?.toLowerCase() === 'html' ? htmlToText(content) : content;
      const text = `${message.subject || ''}\n${body}`;
      const match = matchMailboxMessage(message, parsed, text);
      if (match) messages.push({ ...inboxMessage(message), preview: message.bodyPreview || body.slice(0, 240), ...match });
    }
    next = page['@odata.nextLink'] || null;
    if (page.value.length > remaining) limited = true;
  }
  limited ||= Boolean(next);
  return {
    query: parsed.query,
    messages,
    scanned,
    limited,
    scope: `Signed-in Outlook Inbox: newest ${maxMessages} messages${dateFilters.length ? ' within the requested dates (UTC)' : ''}. Keyword matching in subjects and message bodies; attachment contents are not searched.`,
  };
}

/** Full message, for ingestion. Structured — no MIME parsing needed. */
async function getMessage(token, id) {
  const select = 'id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,body';
  return graphGet(token, `/me/messages/${encodeURIComponent(id)}?$select=${select}`);
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

module.exports = { getMe, listInbox, searchInbox, getMessage, sendMail, GraphError };
