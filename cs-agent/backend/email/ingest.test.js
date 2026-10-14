const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const agent = require('../agent');
const { ingestUploadedEmail } = require('./ingest');

test('upload deduplication uses content and remains scoped to the signed-in owner', async (t) => {
  const saved = new Map();
  const lookups = [];
  t.mock.method(db, 'findBySourceMessageId', async (messageId, owner) => {
    lookups.push({ messageId, owner });
    return saved.get(`${owner}:${messageId}`) || null;
  });
  t.mock.method(db, 'insertRequest', async (id, email, result, source, sourceMessageId, owner) => {
    const request = { id, email, source, sourceMessageId, owner };
    saved.set(`${owner}:${sourceMessageId}`, request);
    return request;
  });
  t.mock.method(db, 'addAudit', async () => {});
  t.mock.method(agent, 'process', async () => ({ analysis: { intent: 'OTHER', confidence: 1 }, status: 'NEEDS_REVIEW' }));
  const first = Buffer.from('From: customer@example.com\r\nSubject: Order 1\r\n\r\nPlease check.');
  const different = Buffer.from(first.toString().replace('Order 1', 'Order 2'));
  const a = await ingestUploadedEmail(first, 'same-name.eml', 'owner-a');
  const b = await ingestUploadedEmail(different, 'same-name.eml', 'owner-a');
  const duplicate = await ingestUploadedEmail(first, 'renamed.eml', 'owner-a');
  const otherOwner = await ingestUploadedEmail(first, 'same-name.eml', 'owner-b');
  assert.notEqual(a.request.id, b.request.id);
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.request.id, a.request.id);
  assert.equal(otherOwner.deduped, false);
  assert.notEqual(otherOwner.request.id, a.request.id);
  assert.deepEqual(lookups.map((lookup) => lookup.owner), ['owner-a', 'owner-a', 'owner-a', 'owner-b']);
  assert.match(a.request.sourceMessageId, /^upload-[a-f0-9]{64}$/);
});
