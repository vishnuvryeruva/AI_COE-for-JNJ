const AUTH_ERRORS = new Set([
  'AUTH_NOT_CONFIGURED', 'AUTH_STATE_INVALID', 'AUTH_ACCESS_DENIED', 'AUTH_CONSENT_REQUIRED',
  'AUTH_TENANT_MISMATCH', 'AUTH_CONFIGURATION_ERROR', 'AUTH_UNAVAILABLE', 'AUTH_FAILED',
]);

// Only a known code is sent back to the browser. Microsoft error descriptions
// can contain tenant/user details and must not be reflected into HTML or URLs.
function authErrorCode(error) {
  if (AUTH_ERRORS.has(error?.code)) return error.code;
  const code = error?.errorCode || error?.error;
  const description = String(error?.errorMessage || error?.error_description || '');
  if (code === 'consent_required' || /AADSTS(65001|90094|90093)/.test(description)) return 'AUTH_CONSENT_REQUIRED';
  if (code === 'access_denied') return 'AUTH_ACCESS_DENIED';
  if (['invalid_client', 'unauthorized_client', 'invalid_scope'].includes(code) || /AADSTS(50011|7000215|7000222|700016)/.test(description)) {
    return 'AUTH_CONFIGURATION_ERROR';
  }
  if (['temporarily_unavailable', 'server_error'].includes(code)) return 'AUTH_UNAVAILABLE';
  return 'AUTH_FAILED';
}
function postLoginPath(config, code) {
  const candidate = config.azure.postLoginUri;
  const path = typeof candidate === 'string' && candidate.startsWith('/') && !candidate.startsWith('//') && !candidate.includes('\\')
    ? candidate : '/';
  const url = new URL(path, 'https://app.invalid');
  url.searchParams.delete('authError');
  if (code) url.searchParams.set('authError', code);
  return `${url.pathname}${url.search}${url.hash}`;
}
function createAuthHandlers({ auth, db, config }) {
  const guestEnabled = () => Boolean(config.guestDemoEnabled && auth.hasSafeCookieSecret(config));
  function requireSameOrigin(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || (!config.authRequired && !auth.isConfigured() && !config.guestDemoEnabled)) return next();
    // SameSite cookies also accompany requests from sibling corporate domains.
    // Reject browser mutations from those origins before an approve/send action.
    // Missing browser headers remains valid for server-to-server/test clients;
    // such callers still need an unforgeable signed session cookie.
    const site = req.get('sec-fetch-site');
    const origin = req.get('origin');
    const expectedOrigins = new Set();
    // The reverse proxy must preserve the browser's Host (including port),
    // and Express trusts only that proxy's protocol indication.
    if (req.get('host') && ['http', 'https'].includes(req.protocol)) {
      try { expectedOrigins.add(new URL(`${req.protocol}://${req.get('host')}`).origin); } catch { /* invalid host fails closed */ }
    }
    if (auth.isConfigured()) {
      try { expectedOrigins.add(new URL(config.azure.redirectUri).origin); } catch { /* incomplete setup fails closed */ }
    }
    if ((site && site !== 'same-origin') || (origin && !expectedOrigins.has(origin))) {
      return res.status(403).json({ code: 'REQUEST_ORIGIN_DENIED', error: 'Open this application directly, refresh the page, and try the action again.' });
    }
    return next();
  }
  async function sessionFrom(req) {
    if (Object.prototype.hasOwnProperty.call(req, 'authSession')) return req.authSession;
    const sid = req.signedCookies?.sid;
    req.authSession = typeof sid === 'string' && /^[0-9a-f]{48}$/.test(sid) ? await db.getSession(sid) : null;
    return req.authSession;
  }
  async function status(req, res) {
    res.set('Cache-Control', 'no-store');
    const configured = auth.isConfigured();
    const session = await sessionFrom(req);
    const guest = guestEnabled() && auth.isGuestSession(session);
    const signedIn = configured && Boolean(session) && !auth.isGuestSession(session);
    res.json({
      configured,
      required: config.authRequired,
      signedIn,
      guestEnabled: guestEnabled(),
      guest,
      username: signedIn || guest ? session.username : null,
      configurationIssues: configured ? [] : auth.configurationIssues(),
    });
  }
  async function guest(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!config.guestDemoEnabled) return res.status(403).json({
      code: 'GUEST_DEMO_DISABLED', error: 'Guest demo access is not enabled for this workspace.',
    });
    if (!guestEnabled()) return res.status(503).json({
      code: 'GUEST_DEMO_UNAVAILABLE', error: 'Guest demo setup needs attention. Ask your administrator to configure a strong session signing key.',
    });
    const sid = auth.newSessionId();
    const owner = `guest:${auth.newSessionId()}`;
    const oldSid = req.signedCookies?.sid;
    await db.createSession(sid, owner, 'Guest demo');
    if (typeof oldSid === 'string') await db.deleteSession(oldSid);
    req.authSession = { sid, home_account_id: owner, username: 'Guest demo' };
    res.cookie('sid', sid, auth.cookieOptions(req, { guest: true }));
    res.clearCookie('oauth_flow', auth.cookieOptions(req, { flow: true, clear: true }));
    return res.json({ ok: true, guest: true });
  }
  async function login(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!auth.isConfigured()) return res.redirect(postLoginPath(config, 'AUTH_NOT_CONFIGURED'));
    try {
      const transaction = auth.newLoginTransaction();
      const url = await auth.getLoginUrl(transaction);
      res.cookie('oauth_flow', transaction, auth.cookieOptions(req, { flow: true }));
      return res.redirect(url);
    } catch (error) {
      return res.redirect(postLoginPath(config, authErrorCode(error)));
    }
  }
  async function callback(req, res) {
    res.set('Cache-Control', 'no-store');
    res.clearCookie('oauth_flow', auth.cookieOptions(req, { flow: true, clear: true }));
    if (!auth.isConfigured()) return res.redirect(postLoginPath(config, 'AUTH_NOT_CONFIGURED'));
    const transaction = req.signedCookies?.oauth_flow;
    if (!auth.validTransaction(transaction, req.query.state)) {
      return res.redirect(postLoginPath(config, 'AUTH_STATE_INVALID'));
    }
    if (req.query.error) return res.redirect(postLoginPath(config, authErrorCode(req.query)));
    if (typeof req.query.code !== 'string' || !req.query.code) return res.redirect(postLoginPath(config, 'AUTH_FAILED'));
    try {
      const account = await auth.handleCallback(req.query.code, transaction);
      // Rotate an existing session so switching accounts cannot preserve access.
      const oldSid = req.signedCookies?.sid;
      if (typeof oldSid === 'string') await db.deleteSession(oldSid);
      const sid = auth.newSessionId();
      await db.createSession(sid, account.homeAccountId, account.username);
      res.cookie('sid', sid, auth.cookieOptions(req));
      return res.redirect(postLoginPath(config));
    } catch (error) {
      return res.redirect(postLoginPath(config, authErrorCode(error)));
    }
  }
  async function logout(req, res) {
    const sid = req.signedCookies?.sid;
    if (typeof sid === 'string') await db.deleteSession(sid);
    req.authSession = null;
    res.clearCookie('sid', auth.cookieOptions(req, { clear: true, guest: true }));
    res.clearCookie('oauth_flow', auth.cookieOptions(req, { flow: true, clear: true }));
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true });
  }
  async function requireSignIn(req, res, next) {
    const session = await sessionFrom(req);
    if (!session && typeof req.signedCookies?.sid === 'string') return res.status(401).json({
      code: 'AUTH_SIGN_IN_REQUIRED', error: 'Your session has expired. Start a new guest demo or sign in again to continue.',
    });
    if (auth.isGuestSession(session)) {
      if (guestEnabled()) return next();
      return res.status(401).json({
        code: 'AUTH_SIGN_IN_REQUIRED', error: 'This guest demo session is no longer available. Sign in to continue.',
      });
    }
    // Resolve identity even in local demo mode so authenticated requests retain
    // their per-user ownership and never mix with anonymous demo requests.
    if (!config.authRequired) {
      return next();
    }
    if (!auth.isConfigured()) return res.status(503).json({
      code: 'AUTH_NOT_CONFIGURED', error: 'Company sign-in is not configured. Ask your administrator to finish Microsoft Entra setup.',
    });
    if (!session) return res.status(401).json({
      code: 'AUTH_SIGN_IN_REQUIRED', error: 'Sign in with your company Microsoft account to access this application.',
    });
    return next();
  }
  return { status, login, guest, callback, logout, requireSignIn, requireSameOrigin, sessionFrom };
}
module.exports = { createAuthHandlers, authErrorCode, postLoginPath };
