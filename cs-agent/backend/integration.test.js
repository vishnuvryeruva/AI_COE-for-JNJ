const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

// Run only against an explicitly supplied disposable PostgreSQL database.
test('HTTP upload, company and guest sessions, private queues and session expiry', {
  skip: !process.env.CS_AGENT_TEST_DATABASE_URL,
}, async (t) => {
  process.env.DATABASE_URL = process.env.CS_AGENT_TEST_DATABASE_URL;
  const db = require('./db');
  const config = require('./config');
  const auth = require('./msgraph/auth');
  const graph = require('./msgraph/graph');
  const aiCore = require('./ai-core');
  const { sign, unsign } = require('cookie-signature');
  const { createMsg } = require('./email/fixtures/msg-fixture');
  const originalConfig = {
    authRequired: config.authRequired, guestDemoEnabled: config.guestDemoEnabled, cookieSecret: config.cookieSecret,
  };
  config.cookieSecret = `${randomUUID()}${randomUUID()}`;
  t.mock.method(aiCore, 'isConfigured', () => false);
  t.mock.method(auth, 'isConfigured', () => true);
  t.mock.method(auth, 'getAccessTokenForSession', async () => null);
  // Any accidental live Graph operation is a test failure, never a real action.
  for (const method of ['getMe', 'listInbox', 'searchInbox', 'getMessage', 'sendMail']) {
    t.mock.method(graph, method, async () => { throw new Error(`Unexpected Graph call: ${method}`); });
  }
  const { app } = require('./server');
  config.authRequired = true;
  config.guestDemoEnabled = false;
  await db.init();
  await db.init(); // Schema migration must also work on restart.
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const ownerA = `test-a-${randomUUID()}`;
  const ownerB = `test-b-${randomUUID()}`;
  const sidA = auth.newSessionId();
  const sidB = auth.newSessionId();
  const owners = [ownerA, ownerB];
  const sessions = [sidA, sidB];
  const cookie = (sid) => `sid=${encodeURIComponent(`s:${sign(sid, config.cookieSecret)}`)}`;
  const request = (path, opts = {}, sid) => fetch(`${base}${path}`, {
    ...opts, headers: { ...(sid ? { Cookie: cookie(sid) } : {}), ...opts.headers },
  });
  const jsonRequest = (path, method, body, sid) => request(path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, sid);
  const createGuest = async () => {
    const response = await request('/auth/guest', { method: 'POST' });
    assert.equal(response.status, 200, 'Enabled guest session creation succeeds');
    const setCookie = response.headers.getSetCookie().find((value) => value.startsWith('sid='));
    assert.ok(setCookie, 'Guest receives a session cookie');
    assert.match(setCookie, /HttpOnly/i);
    const signed = decodeURIComponent(setCookie.split(';', 1)[0].slice('sid='.length));
    assert.match(signed, /^s:/);
    const sid = unsign(signed.slice(2), config.cookieSecret);
    assert.ok(sid, 'Guest session identifier is signed');
    sessions.push(sid);
    const session = await db.getSession(sid);
    assert.match(session.home_account_id, /^guest:/);
    owners.push(session.home_account_id);
    return { sid, owner: session.home_account_id };
  };
  const cannotAccess = async (id, sid) => {
    for (const [path, method, body] of [
      [`/requests/${id}`, 'GET'],
      [`/requests/${id}/draft`, 'PATCH', { body: 'Tampered' }],
      [`/requests/${id}/regenerate`, 'POST'],
      [`/requests/${id}/approve`, 'POST'],
      [`/requests/${id}/reject`, 'POST', { reasonCode: 'Tampered' }],
    ]) {
      const response = body ? await jsonRequest(path, method, body, sid) : await request(path, { method }, sid);
      assert.equal(response.status, 404, `${method} ${path} cannot access another account's request`);
    }
  };
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
    assert.equal((await request('/requests', {}, auth.newSessionId())).status, 401, 'Unknown signed session is not authenticated');
    assert.equal((await request('/auth/guest', { method: 'POST' })).status, 403, 'Guest creation fails closed while disabled');

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

    await cannotAccess(saved.id, sidB);
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

    config.guestDemoEnabled = true;
    const publicStatus = await (await request('/auth/status')).json();
    assert.equal(publicStatus.guestEnabled, true);
    const companyStatus = await (await request('/auth/status', {}, sidA)).json();
    assert.equal(companyStatus.signedIn, true);
    assert.equal(companyStatus.guest, false);
    const guestA = await createGuest();
    const guestB = await createGuest();
    assert.notEqual(guestA.owner, guestB.owner, 'Every guest receives a private account namespace');
    const guestStatus = await (await request('/auth/status', {}, guestA.sid)).json();
    assert.equal(guestStatus.guestEnabled, true);
    assert.equal(guestStatus.guest, true);
    assert.equal(guestStatus.signedIn, false, 'A guest is never represented as signed in to Outlook');
    assert.deepEqual(await (await request('/requests', {}, guestA.sid)).json(), []);

    const guestUpload = await upload('outlook.msg', createMsg(), guestA.sid);
    assert.equal(guestUpload.status, 201);
    const guestSaved = (await guestUpload.json()).request;
    assert.notEqual(guestSaved.id, importedMsg.id, 'Guest content dedupe cannot reveal a company request');
    assert.equal(guestSaved.source, 'MSG_UPLOAD');
    const guestDuplicate = await upload('renamed.msg', createMsg(), guestA.sid);
    assert.equal(guestDuplicate.status, 200);
    assert.equal((await guestDuplicate.json()).request.id, guestSaved.id);
    const guestBUpload = await upload('outlook.msg', createMsg(), guestB.sid);
    assert.equal(guestBUpload.status, 201);
    const guestBSaved = (await guestBUpload.json()).request;
    assert.notEqual(guestBSaved.id, guestSaved.id);

    await cannotAccess(saved.id, guestA.sid);
    await cannotAccess(guestSaved.id, sidA);
    await cannotAccess(guestSaved.id, guestB.sid);
    await cannotAccess(guestBSaved.id, guestA.sid);
    const guestBQueue = await (await request('/requests', {}, guestB.sid)).json();
    assert.deepEqual(guestBQueue.map((row) => row.id), [guestBSaved.id]);
    assert.equal((await (await request('/stats', {}, guestB.sid)).json()).TOTAL, 1);
    assert.deepEqual(await db.getAudit(guestSaved.id, guestB.owner), []);

    const guestManual = await jsonRequest('/requests/manual', 'POST', {
      from: 'demo.customer@example.com', subject: 'Demo order status', body: 'Please check order 4500012345.',
    }, guestA.sid);
    assert.equal(guestManual.status, 201);
    const manualRequest = (await guestManual.json()).request;
    const edited = await jsonRequest(`/requests/${manualRequest.id}/draft`, 'PATCH', { body: 'Edited demo reply.' }, guestA.sid);
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).draft.body, 'Edited demo reply.');
    const regenerated = await request(`/requests/${manualRequest.id}/regenerate`, { method: 'POST' }, guestA.sid);
    assert.equal(regenerated.status, 200);
    assert.ok((await regenerated.json()).draft.body);
    const approved = await request(`/requests/${manualRequest.id}/approve`, { method: 'POST' }, guestA.sid);
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json();
    assert.equal(approvedBody.sent, false);
    assert.equal(approvedBody.status, 'APPROVED', 'Guest approval never claims the reply was sent');
    assert.equal((await db.getRequest(manualRequest.id, guestA.owner)).status, 'APPROVED');
    const approvedDetail = await (await request(`/requests/${manualRequest.id}`, {}, guestA.sid)).json();
    assert.ok(approvedDetail.audit.some((event) => event.action === 'DEMO_APPROVED'));
    assert.ok(!approvedDetail.audit.some((event) => event.action === 'SENT'));
    const guestScenarios = await request('/requests/scenarios', { method: 'POST' }, guestA.sid);
    assert.equal(guestScenarios.status, 201);
    assert.ok((await guestScenarios.json()).created > 0);

    for (const [path, method, body] of [
      ['/mailbox/messages', 'GET'],
      ['/mailbox/search', 'POST', { prompt: 'invoice' }],
      ['/mailbox/messages/example-message/ingest', 'POST'],
    ]) {
      const response = body ? await jsonRequest(path, method, body, guestA.sid) : await request(path, { method }, guestA.sid);
      assert.equal(response.status, 403, `${path} is unavailable to guests`);
      assert.equal((await response.json()).code, 'GUEST_OUTLOOK_UNAVAILABLE');
    }
    for (const method of ['getMe', 'listInbox', 'searchInbox', 'getMessage', 'sendMail']) {
      assert.equal(graph[method].mock.callCount(), 0, `Guest operations never call Graph ${method}`);
    }

    // The demo also works before a Microsoft tenant has been configured.
    t.mock.method(auth, 'isConfigured', () => false);
    assert.equal((await request('/requests', {}, guestA.sid)).status, 200);
    const unconfiguredGuest = await createGuest();
    assert.equal((await (await request('/auth/status', {}, unconfiguredGuest.sid)).json()).guest, true);
    assert.equal((await request('/requests')).status, 503, 'Enabling guests does not bypass the unauthenticated gate');
    t.mock.method(auth, 'isConfigured', () => true);

    config.guestDemoEnabled = false;
    assert.equal((await request('/auth/guest', { method: 'POST' })).status, 403);
    assert.ok([401, 403].includes((await request('/requests', {}, guestA.sid)).status), 'Disabling demo immediately denies existing guest sessions');
    config.authRequired = false;
    assert.ok([401, 403].includes((await request('/requests', {}, guestA.sid)).status), 'Disabled guests cannot fall through to an anonymous demo queue');
    config.authRequired = true;
    config.guestDemoEnabled = true;
    await request('/auth/logout', { method: 'POST' }, guestB.sid);
    assert.equal((await request('/requests', {}, guestB.sid)).status, 401, 'Guest logout invalidates its session');

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
    Object.assign(config, originalConfig);
    await new Promise((resolve) => server.close(resolve));
    await db.pool.query('DELETE FROM requests WHERE owner_account_id = ANY($1)', [owners]);
    for (const sid of sessions) await db.deleteSession(sid);
    await db.pool.end();
  }
});
