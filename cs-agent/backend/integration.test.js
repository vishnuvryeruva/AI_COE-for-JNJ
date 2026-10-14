const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

// Run only against an explicitly supplied disposable PostgreSQL database.
test('HTTP upload, login enforcement, private queues and session expiry', {
  skip: !process.env.CS_AGENT_TEST_DATABASE_URL,
}, async (t) => {
  process.env.DATABASE_URL = process.env.CS_AGENT_TEST_DATABASE_URL;
  const db = require('./db');
  const config = require('./config');
  const auth = require('./msgraph/auth');
  const aiCore = require('./ai-core');
  const { app } = require('./server');
  const { sign } = require('cookie-signature');
  const { createMsg } = require('./email/fixtures/msg-fixture');
  t.mock.method(aiCore, 'isConfigured', () => false);
  t.mock.method(auth, 'isConfigured', () => true);
  t.mock.method(auth, 'getAccessTokenForSession', async () => null);
  config.authRequired = true;
  await db.init();
  await db.init(); // Schema migration must also work on restart.
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const ownerA = `test-a-${randomUUID()}`;
  const ownerB = `test-b-${randomUUID()}`;
  const sidA = auth.newSessionId();
  const sidB = auth.newSessionId();
  const cookie = (sid) => `sid=${encodeURIComponent(`s:${sign(sid, config.cookieSecret)}`)}`;
  const request = (path, opts = {}, sid) => fetch(`${base}${path}`, {
    ...opts, headers: { ...(sid ? { Cookie: cookie(sid) } : {}), ...opts.headers },
  });
  await db.createSession(sidA, ownerA, 'a@example.com');
  await db.createSession(sidB, ownerB, 'b@example.com');
  const upload = (name, content, sid) => {
    const body = new FormData();
    body.append('file', new Blob([content]), name);
    return request('/requests/upload', { method: 'POST', body }, sid);
  };
  try {
    for (const [path, method] of [
      ['/requests', 'GET'], ['/stats', 'GET'], ['/requests/upload', 'POST'],
      ['/requests/manual', 'POST'], ['/requests/scenarios', 'POST'],
      ['/mailbox/search', 'POST'], [`/requests/${randomUUID()}/approve`, 'POST'],
    ]) {
      assert.equal((await request(path, { method })).status, 401, `${path} is protected`);
    }
    assert.equal((await request('/health')).status, 200);
    assert.equal((await (await request('/auth/status')).json()).required, true);
    const unsigned = await request('/requests', { headers: { Cookie: `sid=${sidA}` } });
    assert.equal(unsigned.status, 401, 'Unsigned session identifiers cannot authenticate');
    assert.equal((await request('/auth/logout', { method: 'POST', headers: { Origin: 'https://untrusted.example.com' } }, sidA)).status, 403, 'Cross-origin form posts cannot use the signed-in session');

    const malformed = await upload('broken.msg', 'not an Outlook binary file', sidA);
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /msg|Outlook|email/i);
    assert.equal((await request('/health')).status, 200, 'Bad uploads leave API responsive');
    assert.equal((await upload('document.txt', 'not an email', sidA)).status, 400);
    const oversized = await upload('large.eml', Buffer.alloc(32 * 1024 * 1024 + 1), sidA);
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /32 MB/);

    const eml = 'From: Customer <customer@example.com>\r\nTo: service@example.com\r\nSubject: Invoice 4500012345\r\n\r\nPlease send the invoice for order 4500012345.';
    const first = await upload('saved.eml', eml, sidA);
    assert.equal(first.status, 201);
    const { request: saved } = await first.json();
    assert.equal(saved.email.from, 'customer@example.com');
    const duplicate = await upload('renamed.eml', eml, sidA);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).deduped, true);
    const secondUser = await upload('saved.eml', eml, sidB);
    assert.equal(secondUser.status, 201, 'Identical mail imported by another user is private');
    assert.notEqual((await secondUser.json()).request.id, saved.id);

    for (const [path, method, body] of [
      [`/requests/${saved.id}`, 'GET'],
      [`/requests/${saved.id}/draft`, 'PATCH', { body: 'Tampered' }],
      [`/requests/${saved.id}/regenerate`, 'POST'],
      [`/requests/${saved.id}/approve`, 'POST'],
      [`/requests/${saved.id}/reject`, 'POST', { reasonCode: 'Tampered' }],
    ]) {
      assert.equal((await request(path, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) }, sidB)).status, 404);
    }
    assert.equal((await (await request('/stats', {}, sidA)).json()).TOTAL, 1);
    const queueB = await (await request('/requests', {}, sidB)).json();
    assert.equal(queueB.length, 1);
    assert.notEqual(queueB[0].id, saved.id);
    assert.deepEqual(await db.getAudit(saved.id, ownerB), []);
    const detail = await (await request(`/requests/${saved.id}`, {}, sidA)).json();
    assert.ok(detail.audit.length > 0);

    const msgResponse = await upload('outlook.MSG', createMsg(), sidA);
    assert.equal(msgResponse.status, 201);
    const importedMsg = (await msgResponse.json()).request;
    assert.equal(importedMsg.source, 'MSG_UPLOAD');
    assert.equal(importedMsg.email.from, 'customer@example.com');
    assert.equal(importedMsg.extraction.method, 'MSG_DIRECT');

    const expiredToken = await request(`/requests/${saved.id}/approve`, { method: 'POST' }, sidA);
    assert.equal(expiredToken.status, 401);
    assert.notEqual((await db.getRequest(saved.id, ownerA)).status, 'SENT', 'Expired Outlook tokens never fake a successful send');

    // Optional local sign-in must still use the signed-in account's queue.
    config.authRequired = false;
    assert.ok((await (await request('/requests', {}, sidA)).json()).some((row) => row.id === saved.id));
    assert.ok(!(await (await request('/requests')).json()).some((row) => row.id === saved.id));
    config.authRequired = true;
    await db.pool.query("UPDATE web_sessions SET created_at = NOW() - INTERVAL '9 hours' WHERE sid = $1", [sidA]);
    assert.equal((await request('/requests', {}, sidA)).status, 401, 'Session lifetime is enforced server-side');
    await request('/auth/logout', { method: 'POST' }, sidB);
    assert.equal((await request('/requests', {}, sidB)).status, 401, 'Logout invalidates the server session');

    t.mock.method(auth, 'isConfigured', () => false);
    assert.equal((await request('/requests')).status, 503, 'Required sign-in fails closed while unconfigured');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.pool.query('DELETE FROM requests WHERE owner_account_id = ANY($1)', [[ownerA, ownerB]]);
    await db.deleteSession(sidA);
    await db.deleteSession(sidB);
    await db.pool.end();
  }
});
