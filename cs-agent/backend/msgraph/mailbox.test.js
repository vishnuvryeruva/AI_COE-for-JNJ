const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMailboxQuery, InvalidMailboxQuery, extractOrderNumbers } = require('./mailbox-query');
const { searchInbox, getMessage, GraphError } = require('./graph');
const { createSearchHandler } = require('./mailbox');

const NOW = new Date('2026-09-30T15:00:00.000Z');
const message = (id, overrides = {}) => ({
  id,
  subject: 'Customer message',
  body: { contentType: 'text', content: 'Please create sales order 4500123456.' },
  bodyPreview: 'Customer message preview',
  from: { emailAddress: { name: 'Customer', address: 'customer@example.com' } },
  receivedDateTime: '2026-09-30T12:00:00Z',
  hasAttachments: false,
  ...overrides,
});
const graphPage = (value, next) => ({ ok: true, json: async () => ({ value, ...(next && { '@odata.nextLink': next }) }) });

test('parses natural requests and preserves sender, order and date constraints', () => {
  assert.equal(parseMailboxQuery('Can you find sales orders from email?').query.label, 'Sales orders');
  assert.equal(parseMailboxQuery('find invoices from Outlook').query.label, 'Invoices');
  assert.equal(parseMailboxQuery('find SAP sales orders').query.label, 'Sales orders');
  const { query } = parseMailboxQuery('Find invoices for order 4500123456 from Customer@example.com in the last 7 days', NOW);
  assert.equal(query.label, 'Invoices');
  assert.equal(query.orderNumber, '4500123456');
  assert.equal(query.sender, 'customer@example.com');
  assert.equal(query.since, '2026-09-23T15:00:00.000Z');
  assert.equal(query.before, null);
  assert.deepEqual(extractOrderNumbers('SO-4500123456 and sales order SO-120045; PO: 887766'), ['4500123456', 'SO-120045', '887766']);
  assert.equal(parseMailboxQuery('find invoices for sales order SO-4500123456').query.orderNumber, 'SO-4500123456');
  assert.equal(parseMailboxQuery('find orders 45').query.orderNumber, '45');
});

test('calendar and explicit dates use UTC and retain exclusive end bounds', () => {
  const cases = [
    ['today', '2026-09-30T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    ['yesterday', '2026-09-29T00:00:00.000Z', '2026-09-30T00:00:00.000Z'],
    ['this week', '2026-09-28T00:00:00.000Z', '2026-10-05T00:00:00.000Z'],
    ['last week', '2026-09-21T00:00:00.000Z', '2026-09-28T00:00:00.000Z'],
    ['last month', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    ['since 2026-09-01 before 2026-09-05', '2026-09-01T00:00:00.000Z', '2026-09-05T00:00:00.000Z'],
    ['on 2026-09-12', '2026-09-12T00:00:00.000Z', '2026-09-13T00:00:00.000Z'],
  ];
  for (const [phrase, since, before] of cases) {
    const { query } = parseMailboxQuery(`find invoices ${phrase}`, NOW);
    assert.equal(query.since, since, phrase);
    assert.equal(query.before, before, phrase);
  }
});

test('unsupported and ambiguous requests fail explicitly instead of broadening search', () => {
  for (const prompt of [null, {}, '', 'x'.repeat(501), 'find things', 'find invoices since Monday',
    'find invoices in 2025', 'find invoices on 09/02/2026', 'find invoices last year', 'find invoices from Jane',
    'find invoices since 2026-02-30', 'find invoices since 2026-10-01 before 2026-09-01',
    'find invoices today yesterday', 'find sales orders with attachments', 'find unread sales orders',
    'find overdue sales orders', 'find order 4500123456 or order 4500123457']) {
    assert.throws(() => parseMailboxQuery(prompt, NOW), InvalidMailboxQuery, String(prompt));
  }
});

test('search uses full bodies, paginates opaque nextLink, removes HTML, and deduplicates', async (t) => {
  const next = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=opaque%2Bvalue';
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return graphPage([
      message('a', { body: { contentType: 'html', content: `<p>${'Context '.repeat(60)}</p><p>Sales <b>order</b> 4500123456</p>` } }),
      message('irrelevant', { body: { contentType: 'text', content: 'Team lunch tomorrow.' } }),
    ], next);
    return graphPage([message('a'), message('b', { body: { contentType: 'text', content: 'Purchase order 4500123457 attached.' } })]);
  });
  const result = await searchInbox('test-token', 'find sales orders from email', { now: NOW });
  assert.deepEqual(result.messages.map((m) => m.id), ['a', 'b']);
  assert.equal(result.scanned, 4);
  assert.equal(result.limited, false);
  assert.equal(calls[1].url, next);
  const firstUrl = new URL(calls[0].url);
  assert.ok(firstUrl.searchParams.get('$select').split(',').includes('body'));
  assert.equal(firstUrl.pathname, '/v1.0/me/mailFolders/inbox/messages');
  assert.equal(calls[0].options.headers.Prefer, 'outlook.body-content-type="text"');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(result.messages[0].orderNumbers, ['4500123456']);
  assert.match(result.messages[0].matchReason, /Keyword match/);
  assert.match(result.scope, /attachment contents are not searched/);
  assert.equal(result.messages[0].body, undefined, 'full private body is not returned to the results list');
});

test('date, sender, category and exact order filters all apply', async (t) => {
  let requestedUrl;
  t.mock.method(global, 'fetch', async (url) => {
    requestedUrl = url;
    return graphPage([
      message('right', { body: { contentType: 'text', content: 'Invoice for order 4500123456' } }),
      message('wrong-sender', { subject: 'Invoice', from: { emailAddress: { address: 'someone@example.com' } } }),
      message('old', { subject: 'Invoice', receivedDateTime: '2026-09-28T12:00:00Z' }),
      message('future', { subject: 'Invoice', receivedDateTime: '2026-10-01T00:00:00Z' }),
      message('wrong-ref', { body: { contentType: 'text', content: 'Invoice for order 45001234567' } }),
      message('wrong-category'),
    ]);
  });
  const result = await searchInbox('token', 'find invoices for order 4500123456 from customer@example.com today', { now: NOW });
  assert.deepEqual(result.messages.map((m) => m.id), ['right']);
  assert.equal(new URL(requestedUrl).searchParams.get('$filter'), 'receivedDateTime ge 2026-09-30T00:00:00.000Z and receivedDateTime lt 2026-10-01T00:00:00.000Z');
});

test('an explicit order reference matches email even without an order keyword', async (t) => {
  t.mock.method(global, 'fetch', async () => graphPage([
    message('right', { subject: 'Follow-up 4500123456', body: { contentType: 'text', content: 'Please confirm receipt.' } }),
    message('wrong', { subject: 'Follow-up 45001234567', body: { contentType: 'text', content: 'Please confirm receipt.' } }),
  ]));
  const result = await searchInbox('token', 'find email for order 4500123456');
  assert.deepEqual(result.messages.map((m) => m.id), ['right']);
});

test('caps the scan at 200 messages and reports that more messages exist', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    const page = calls++;
    return graphPage(Array.from({ length: 50 }, (_, i) => message(`${page}-${i}`)), `https://graph.microsoft.com/v1.0/me/messages?$skiptoken=${calls}`);
  });
  const result = await searchInbox('token', 'find sales orders');
  assert.equal(calls, 4);
  assert.equal(result.scanned, 200);
  assert.equal(result.messages.length, 200);
  assert.equal(result.limited, true);
});

test('never forwards credentials to an untrusted nextLink', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    return graphPage([message('a')], 'https://attacker.example/v1.0/me/messages');
  });
  await assert.rejects(searchInbox('secret-token', 'find sales orders'), /invalid pagination URL/);
  assert.equal(calls, 1);
});

test('message identifiers are encoded as one Graph path segment', async (t) => {
  let requestedUrl;
  t.mock.method(global, 'fetch', async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ id: 'a/b+?=#' }) };
  });
  await getMessage('token', 'a/b+?=#');
  assert.equal(new URL(requestedUrl).pathname, '/v1.0/me/messages/a%2Fb%2B%3F%3D%23');
});

function fakeResponse() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('search route requires configuration and an authenticated session before mailbox access', async () => {
  for (const [configured, token, status, code] of [
    [false, null, 503, 'OUTLOOK_NOT_CONFIGURED'],
    [true, null, 401, 'OUTLOOK_SIGN_IN_REQUIRED'],
  ]) {
    let calls = 0;
    const handler = createSearchHandler({ isConfigured: () => configured, tokenFor: async () => token, searchInbox: async () => { calls++; } });
    const res = fakeResponse();
    await handler({ body: { prompt: 'find sales orders' } }, res);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.code, code);
    assert.equal(calls, 0);
  }
});

test('search route rejects invalid input before invoking Graph and returns results unchanged', async () => {
  let calls = 0;
  const result = { messages: [message('a')], scanned: 1, limited: false };
  const handler = createSearchHandler({ isConfigured: () => true, tokenFor: async () => 'token', searchInbox: async () => { calls++; return result; } });
  const invalid = fakeResponse();
  await handler({ body: { prompt: 'find sales orders since January' } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.code, 'INVALID_MAILBOX_QUERY');
  assert.equal(calls, 0);
  const success = fakeResponse();
  await handler({ body: { prompt: 'find sales orders' } }, success);
  assert.equal(success.statusCode, 200);
  assert.deepEqual(success.body, result);
  assert.equal(calls, 1);
});

test('Graph/auth failures yield actionable safe status responses', async () => {
  for (const [error, status, code] of [
    [new GraphError(401), 401, 'OUTLOOK_SIGN_IN_REQUIRED'],
    [new GraphError(403), 403, 'MAILBOX_ACCESS_DENIED'],
    [new GraphError(429), 429, 'MAILBOX_UNAVAILABLE'],
    [new GraphError(500), 502, 'MAILBOX_UNAVAILABLE'],
    [new Error('private mailbox details'), 502, 'MAILBOX_UNAVAILABLE'],
  ]) {
    const handler = createSearchHandler({ isConfigured: () => true, tokenFor: async () => 'token', searchInbox: async () => { throw error; } });
    const res = fakeResponse();
    await handler({ body: { prompt: 'find sales orders' } }, res);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.code, code);
    assert.doesNotMatch(res.body.error, /private mailbox/);
  }
});
