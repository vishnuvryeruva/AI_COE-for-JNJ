const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('./auth');
const { createAuthHandlers, authErrorCode, postLoginPath } = require('./auth-routes');

const TENANT = '11111111-2222-3333-4444-555555555555';
const settings = (overrides = {}) => ({
  authRequired: true,
  cookieSecret: 'a'.repeat(64),
  azure: { clientId: 'client-id', clientSecret: 'secret', tenantId: TENANT, redirectUri: 'https://app.example/api/v1/auth/callback', postLoginUri: '/' },
  ...overrides,
});
function response() {
  return {
    statusCode: 200, cookies: [], cleared: [], headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    redirect(value) { this.location = value; return this; },
    cookie(...value) { this.cookies.push(value); return this; },
    clearCookie(...value) { this.cleared.push(value); return this; },
    set(key, value) { this.headers[key] = value; return this; },
  };
}
function setup({ configured = true, config = settings(), session = null, authOverrides = {}, dbOverrides = {} } = {}) {
  const db = {
    getSession: async () => session,
    createSession: async () => {},
    deleteSession: async () => {},
    ...dbOverrides,
  };
  return createAuthHandlers({
    auth: { ...auth, isConfigured: () => configured, configurationIssues: () => ['AZURE_CLIENT_ID'], ...authOverrides },
    db, config,
  });
}

test('Microsoft sign-in requires an explicit company tenant and strong signing secret', () => {
  assert.deepEqual(auth.configurationIssues(settings()), []);
  for (const tenantId of ['', 'common', 'organizations', 'consumers', 'jnj.com']) {
    const config = settings();
    config.azure.tenantId = tenantId;
    assert.match(auth.configurationIssues(config).join(' '), /AZURE_TENANT_ID/);
  }
  for (const cookieSecret of ['', 'short', 'dev-cookie-secret-change-me']) {
    assert.match(auth.configurationIssues(settings({ cookieSecret, authRequired: false })).join(' '), /COOKIE_SECRET/);
  }
  const config = settings();
  config.azure.redirectUri = 'http://company-app.example/api/v1/auth/callback';
  assert.match(auth.configurationIssues(config).join(' '), /AZURE_REDIRECT_URI/);
  config.azure.redirectUri = 'http://localhost:8080/api/v1/auth/callback';
  assert.deepEqual(auth.configurationIssues(config), []);
});

test('login transactions reject mismatched, missing, tampered, expired and future state', () => {
  const now = Date.now();
  const transaction = auth.newLoginTransaction(now);
  assert.ok(auth.validTransaction(transaction, transaction.state, now));
  assert.equal(transaction.codeVerifier.length, 43);
  assert.notEqual(transaction.state, transaction.nonce);
  for (const [flow, state, time] of [
    [transaction, 'different', now],
    [transaction, [transaction.state], now],
    [false, transaction.state, now],
    [null, transaction.state, now],
    [{ ...transaction, codeVerifier: '' }, transaction.state, now],
    [transaction, transaction.state, now + auth.FLOW_MAX_AGE + 1],
    [transaction, transaction.state, now - 1],
  ]) assert.equal(auth.validTransaction(flow, state, time), false);
});

test('a token response must contain the original nonce and the configured tenant', () => {
  const transaction = auth.newLoginTransaction();
  const result = { account: { homeAccountId: 'account', tenantId: TENANT }, idTokenClaims: { tid: TENANT, nonce: transaction.nonce } };
  assert.equal(auth.validateIdentity(result, transaction, TENANT), result.account);
  assert.throws(() => auth.validateIdentity({ ...result, idTokenClaims: { tid: TENANT, nonce: 'replay' } }, transaction, TENANT), { code: 'AUTH_STATE_INVALID' });
  assert.throws(() => auth.validateIdentity({ ...result, idTokenClaims: { ...result.idTokenClaims, tid: 'other-tenant' } }, transaction, TENANT), { code: 'AUTH_TENANT_MISMATCH' });
  assert.throws(() => auth.validateIdentity({ ...result, account: { ...result.account, tenantId: 'other-tenant' } }, transaction, TENANT), { code: 'AUTH_TENANT_MISMATCH' });
});

test('login stores a short-lived signed HttpOnly transaction and never exposes its verifier in the redirect', async () => {
  let transaction;
  const handlers = setup({ authOverrides: { getLoginUrl: async (flow) => { transaction = flow; return `https://login.microsoftonline.com/authorize?state=${flow.state}`; } } });
  const res = response();
  await handlers.login({ secure: true }, res);
  assert.equal(res.cookies[0][0], 'oauth_flow');
  assert.equal(res.cookies[0][1], transaction);
  assert.deepEqual(res.cookies[0][2], { httpOnly: true, sameSite: 'lax', secure: true, signed: true, path: '/api/v1/auth', maxAge: auth.FLOW_MAX_AGE });
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok(!res.location.includes(transaction.codeVerifier));
});

test('application gate blocks missing configuration and unsigned sessions before data access', async () => {
  let reads = 0;
  for (const [configured, expected] of [[false, 503], [true, 401]]) {
    const handlers = setup({ configured, dbOverrides: { getSession: async () => { reads++; return { username: 'forged' }; } } });
    const res = response();
    await handlers.requireSignIn({ cookies: { sid: 'a'.repeat(48) } }, res, () => assert.fail('must not reach protected route'));
    assert.equal(res.statusCode, expected);
  }
  assert.equal(reads, 0);
});

test('optional local auth still resolves identity for request ownership and caches it per request', async () => {
  let reads = 0;
  const session = { home_account_id: 'user-1', username: 'csr@example.com' };
  const handlers = setup({ config: settings({ authRequired: false }), dbOverrides: { getSession: async () => { reads++; return session; } } });
  const req = { signedCookies: { sid: 'a'.repeat(48) } };
  let next = false;
  await handlers.requireSignIn(req, response(), () => { next = true; });
  assert.equal(next, true);
  assert.equal(req.authSession, session);
  assert.equal(await handlers.sessionFrom(req), session);
  assert.equal(reads, 1);
});

test('status reports required sign-in and configuration without reporting secret values', async () => {
  const res = response();
  await setup({ configured: false }).status({}, res);
  assert.deepEqual(res.body, { configured: false, required: true, signedIn: false, guestEnabled: false, guest: false, username: null, configurationIssues: ['AZURE_CLIENT_ID'] });
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('callback rejects state before any token exchange and always clears the temporary cookie', async () => {
  const handlers = setup({ authOverrides: { handleCallback: async () => assert.fail('must not redeem invalid state') } });
  const res = response();
  await handlers.callback({ secure: true, signedCookies: { oauth_flow: auth.newLoginTransaction() }, query: { code: 'secret-code', state: 'wrong' } }, res);
  assert.equal(res.location, '/?authError=AUTH_STATE_INVALID');
  assert.equal(res.cleared[0][0], 'oauth_flow');
  assert.equal(res.cleared[0][1].path, '/api/v1/auth');
  assert.equal(res.cleared[0][1].maxAge, undefined);
});

test('successful callback rotates session, passes PKCE transaction and sets signed session cookie', async () => {
  const transaction = auth.newLoginTransaction();
  const deleted = [], created = [];
  const sid = 'b'.repeat(48);
  const handlers = setup({
    authOverrides: {
      newSessionId: () => sid,
      handleCallback: async (code, flow) => {
        assert.equal(code, 'authorization-code');
        assert.equal(flow, transaction);
        return { homeAccountId: 'user-1', username: 'csr@example.com' };
      },
    },
    dbOverrides: { deleteSession: async (id) => deleted.push(id), createSession: async (...args) => created.push(args) },
  });
  const res = response();
  await handlers.callback({ secure: true, signedCookies: { oauth_flow: transaction, sid: 'a'.repeat(48) }, query: { code: 'authorization-code', state: transaction.state } }, res);
  assert.deepEqual(deleted, ['a'.repeat(48)]);
  assert.deepEqual(created, [[sid, 'user-1', 'csr@example.com']]);
  assert.equal(res.location, '/');
  assert.equal(res.cookies[0][0], 'sid');
  assert.equal(res.cookies[0][2].signed, true);
  assert.equal(res.cookies[0][2].maxAge, auth.SESSION_MAX_AGE);
  assert.equal(res.cookies[0][2].path, '/');
});

test('Microsoft denial and consent errors return safe actionable codes without raw tenant details', async () => {
  for (const [error, expected] of [
    [{ error: 'access_denied' }, 'AUTH_ACCESS_DENIED'],
    [{ error: 'access_denied', error_description: 'AADSTS65001 private-user@company' }, 'AUTH_CONSENT_REQUIRED'],
    [{ errorCode: 'invalid_client' }, 'AUTH_CONFIGURATION_ERROR'],
    [{ error: 'server_error' }, 'AUTH_UNAVAILABLE'],
    [{ error: '<script>private user</script>' }, 'AUTH_FAILED'],
  ]) {
    assert.equal(authErrorCode(error), expected);
    const transaction = auth.newLoginTransaction();
    const res = response();
    await setup().callback({ signedCookies: { oauth_flow: transaction }, query: { ...error, error: error.error || error.errorCode, state: transaction.state } }, res);
    assert.equal(res.location, `/?authError=${expected}`);
  }
});

test('logout revokes only the current signed session and removes cookies using their original paths', async () => {
  const revoked = [];
  const res = response();
  await setup({ dbOverrides: { deleteSession: async (sid) => revoked.push(sid) } }).logout({ signedCookies: { sid: 'a'.repeat(48) } }, res);
  assert.deepEqual(revoked, ['a'.repeat(48)]);
  assert.deepEqual(res.cleared.map(([name, options]) => [name, options.path, options.maxAge]), [['sid', '/', undefined], ['oauth_flow', '/api/v1/auth', undefined]]);
  assert.deepEqual(res.body, { ok: true });
});

test('post-login redirect stays inside the app even when given an external URL', () => {
  for (const postLoginUri of ['https://attacker.example/', '//attacker.example/', '/\\attacker.example/']) {
    const config = settings();
    config.azure.postLoginUri = postLoginUri;
    assert.equal(postLoginPath(config, 'AUTH_FAILED'), '/?authError=AUTH_FAILED');
  }
});

test('browser mutations reject cross-origin and sibling-domain CSRF before approving or signing out', () => {
  const handlers = setup();
  for (const headers of [
    { origin: 'https://untrusted.example', 'sec-fetch-site': 'cross-site' },
    { origin: 'https://sibling.example', 'sec-fetch-site': 'same-site' },
    { origin: 'null' },
    { origin: 'https://untrusted.example' },
  ]) {
    const res = response();
    handlers.requireSameOrigin({ method: 'POST', get: (name) => headers[name] }, res, () => assert.fail('untrusted browser mutation accepted'));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'REQUEST_ORIGIN_DENIED');
  }
  for (const headers of [{ origin: 'https://app.example', 'sec-fetch-site': 'same-origin' }, {}]) {
    let allowed = false;
    handlers.requireSameOrigin({ method: 'POST', get: (name) => headers[name] }, response(), () => { allowed = true; });
    assert.ok(allowed);
  }
  let callbackAllowed = false;
  handlers.requireSameOrigin({ method: 'GET', get: () => 'cross-site' }, response(), () => { callbackAllowed = true; });
  assert.ok(callbackAllowed, 'Microsoft OAuth callback must allow cross-site top-level navigation');
});

test('guest sessions work without Microsoft credentials and have isolated random owners', async () => {
  const created = [];
  const revoked = [];
  const handlers = setup({
    configured: false,
    config: settings({ guestDemoEnabled: true }),
    dbOverrides: {
      createSession: async (...args) => created.push(args),
      deleteSession: async (sid) => revoked.push(sid),
    },
  });
  const first = response();
  const req = { secure: true, signedCookies: { sid: 'a'.repeat(48) } };
  await handlers.guest(req, first);
  await handlers.guest({ secure: true }, response());
  assert.deepEqual(first.body, { ok: true, guest: true });
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.deepEqual(revoked, ['a'.repeat(48)]);
  assert.equal(first.cookies[0][0], 'sid');
  assert.equal(first.cookies[0][2].signed, true);
  assert.equal(first.cookies[0][2].httpOnly, true);
  assert.equal(first.cookies[0][2].secure, true);
  assert.equal(first.cookies[0][2].maxAge, auth.SESSION_MAX_AGE);
  for (const [sid, owner, name] of created) {
    assert.match(sid, /^[a-f0-9]{48}$/);
    assert.match(owner, /^guest:[a-f0-9]{48}$/);
    assert.equal(name, 'Guest demo');
    assert.notEqual(owner, `guest:${sid}`, 'public owner must not reveal the session credential');
  }
  assert.notEqual(created[0][0], created[1][0]);
  assert.notEqual(created[0][1], created[1][1]);
  assert.equal(req.authSession.home_account_id, created[0][1]);
  let allowed = false;
  await handlers.requireSignIn(req, response(), () => { allowed = true; });
  assert.ok(allowed, 'required login permits an explicitly enabled guest before Entra setup');
  const status = response();
  await handlers.status(req, status);
  assert.equal(status.body.guest, true);
  assert.equal(status.body.guestEnabled, true);
  assert.equal(status.body.signedIn, false);
  assert.equal(status.body.configured, false);
  assert.equal(status.body.username, 'Guest demo');
});

test('guest creation is disabled by default and never accepts a predictable short signing key', async () => {
  for (const [config, expected, code] of [
    [settings(), 403, 'GUEST_DEMO_DISABLED'],
    [settings({ guestDemoEnabled: true, cookieSecret: 'dev-cookie-secret-change-me' }), 503, 'GUEST_DEMO_UNAVAILABLE'],
  ]) {
    const handlers = setup({ configured: false, config, dbOverrides: { createSession: async () => assert.fail('guest must not be created') } });
    const res = response();
    await handlers.guest({}, res);
    assert.equal(res.statusCode, expected);
    assert.equal(res.body.code, code);
    const status = response();
    await handlers.status({}, status);
    assert.equal(status.body.guestEnabled, false);
  }
});

test('disabling guest mode denies existing guest sessions even when anonymous local access is enabled', async () => {
  const session = { sid: 'a'.repeat(48), home_account_id: `guest:${'b'.repeat(48)}`, username: 'Guest demo' };
  for (const authRequired of [true, false]) {
    const handlers = setup({ configured: false, config: settings({ authRequired, guestDemoEnabled: false }), session });
    const req = { signedCookies: { sid: session.sid } };
    const res = response();
    await handlers.requireSignIn(req, res, () => assert.fail('disabled guest must not reach the queue'));
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'AUTH_SIGN_IN_REQUIRED');
    const status = response();
    await handlers.status(req, status);
    assert.equal(status.body.guest, false);
    assert.equal(status.body.signedIn, false);
    assert.equal(status.body.username, null);
  }
});

test('expired guest sessions do not silently become anonymous demo access', async () => {
  const handlers = setup({ configured: false, config: settings({ authRequired: false, guestDemoEnabled: true }), session: null });
  const res = response();
  await handlers.requireSignIn({ signedCookies: { sid: 'a'.repeat(48) } }, res, () => assert.fail('expired guest must not access anonymous queue'));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'AUTH_SIGN_IN_REQUIRED');
});

test('guest sessions can never obtain a Microsoft Graph access token', async () => {
  const session = { home_account_id: `guest:${'a'.repeat(48)}` };
  assert.equal(auth.isGuestSession(session), true);
  assert.equal(auth.isGuestSession({ home_account_id: 'microsoft-account.tenant' }), false);
  assert.equal(await auth.getAccessTokenForSession(session), null);
});

test('guest browser actions use the actual app origin without requiring an Azure redirect', () => {
  const handlers = setup({ configured: false, config: settings({ guestDemoEnabled: true }) });
  for (const [protocol, host, origin, allowed] of [
    ['http', 'localhost:5173', 'http://localhost:5173', true],
    ['http', 'localhost:8080', 'http://localhost:8080', true],
    ['https', 'demo.example', 'https://demo.example', true],
    ['https', 'demo.example', 'https://sibling.example', false],
    ['https', 'demo.example', 'http://localhost:8080', false],
  ]) {
    const headers = { host, origin, 'sec-fetch-site': 'same-origin' };
    let next = false;
    const res = response();
    handlers.requireSameOrigin({ method: 'POST', protocol, get: (name) => headers[name] }, res, () => { next = true; });
    assert.equal(next, allowed, `${origin} to ${protocol}://${host}`);
    if (!allowed) assert.equal(res.statusCode, 403);
  }
});
