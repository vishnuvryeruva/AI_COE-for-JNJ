const crypto = require('crypto');
const msal = require('@azure/msal-node');
const config = require('../config');
const db = require('../db');

// Delegated permissions: only the signed-in user's mailbox is accessed.
// Mail.Send supports the existing explicit review/approve action.
const SCOPES = ['openid', 'profile', 'User.Read', 'Mail.Read', 'Mail.Send', 'offline_access'];
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000;
const FLOW_MAX_AGE = 10 * 60 * 1000;
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasSafeCookieSecret(settings = config) {
  return typeof settings.cookieSecret === 'string' && settings.cookieSecret.length >= 32 &&
    settings.cookieSecret !== 'dev-cookie-secret-change-me';
}
function isGuestSession(session) {
  return typeof session?.home_account_id === 'string' && session.home_account_id.startsWith('guest:');
}

function configurationIssues(settings = config) {
  const issues = [];
  if (!settings.azure.clientId) issues.push('AZURE_CLIENT_ID');
  if (!settings.azure.clientSecret) issues.push('AZURE_CLIENT_SECRET');
  if (!TENANT_ID.test(settings.azure.tenantId)) issues.push('AZURE_TENANT_ID (Directory tenant GUID)');
  if (!hasSafeCookieSecret(settings)) {
    issues.push('COOKIE_SECRET (at least 32 random characters)');
  }
  try {
    const redirect = new URL(settings.azure.redirectUri);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
    if (redirect.username || redirect.password || redirect.hash || redirect.search ||
        (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && loopback))) {
      issues.push('AZURE_REDIRECT_URI (HTTPS, or HTTP localhost for development)');
    }
  } catch {
    issues.push('AZURE_REDIRECT_URI');
  }
  return issues;
}

function isConfigured() { return configurationIssues().length === 0; }

// One process owns the shared persisted MSAL cache. Serialize operations to
// prevent concurrent callback/refresh writes from dropping another account.
// Multi-instance hosting requires distributed locking or a partitioned cache.
const cachePlugin = {
  beforeCacheAccess: async (context) => {
    const blob = await db.loadMsalCache();
    if (blob) context.tokenCache.deserialize(blob);
  },
  afterCacheAccess: async (context) => {
    if (context.cacheHasChanged) await db.saveMsalCache(context.tokenCache.serialize());
  },
};
let cca;
let cacheQueue = Promise.resolve();
function withCache(operation) {
  const result = cacheQueue.then(operation);
  cacheQueue = result.catch(() => {});
  return result;
}
function client() {
  if (!cca) {
    cca = new msal.ConfidentialClientApplication({
      auth: {
        clientId: config.azure.clientId,
        clientSecret: config.azure.clientSecret,
        authority: `https://login.microsoftonline.com/${config.azure.tenantId}`,
      },
      cache: { cachePlugin },
      system: { loggerOptions: { piiLoggingEnabled: false } },
    });
  }
  return cca;
}

function newState() { return crypto.randomBytes(32).toString('base64url'); }
function newSessionId() { return crypto.randomBytes(24).toString('hex'); }
function newLoginTransaction(now = Date.now()) {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  return { state: newState(), nonce: newState(), codeVerifier, createdAt: now };
}
function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validTransaction(transaction, state, now = Date.now()) {
  return Boolean(transaction && typeof transaction === 'object' &&
    typeof transaction.nonce === 'string' && transaction.nonce.length >= 43 &&
    typeof transaction.codeVerifier === 'string' && transaction.codeVerifier.length >= 43 &&
    Number.isFinite(transaction.createdAt) && transaction.createdAt <= now &&
    now - transaction.createdAt <= FLOW_MAX_AGE && equalSecret(transaction.state, state));
}
async function getLoginUrl(transaction) {
  return client().getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: config.azure.redirectUri,
    state: transaction.state,
    nonce: transaction.nonce,
    codeChallenge: crypto.createHash('sha256').update(transaction.codeVerifier).digest('base64url'),
    codeChallengeMethod: 'S256',
    responseMode: 'query',
  });
}
function validateIdentity(result, transaction, tenantId = config.azure.tenantId) {
  if (!result?.account?.homeAccountId || !equalSecret(result.idTokenClaims?.nonce, transaction.nonce)) {
    const error = new Error('Invalid Microsoft sign-in response');
    error.code = 'AUTH_STATE_INVALID';
    throw error;
  }
  if (String(result.idTokenClaims?.tid).toLowerCase() !== tenantId.toLowerCase() ||
      String(result.account.tenantId).toLowerCase() !== tenantId.toLowerCase()) {
    const error = new Error('This account is not in the configured company tenant');
    error.code = 'AUTH_TENANT_MISMATCH';
    throw error;
  }
  return result.account;
}
async function handleCallback(code, transaction) {
  return withCache(async () => {
    const result = await client().acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: config.azure.redirectUri,
      codeVerifier: transaction.codeVerifier,
      state: transaction.state,
    }, { code, state: transaction.state, nonce: transaction.nonce });
    return validateIdentity(result, transaction);
  });
}
async function getAccessTokenForSession(session) {
  if (!session || isGuestSession(session) || !isConfigured()) return null;
  return withCache(async () => {
    const accounts = await client().getTokenCache().getAllAccounts();
    const account = accounts.find((item) => item.homeAccountId === session.home_account_id &&
      item.tenantId?.toLowerCase() === config.azure.tenantId.toLowerCase());
    if (!account) return null;
    try {
      const result = await client().acquireTokenSilent({ account, scopes: SCOPES });
      return result.accessToken;
    } catch (error) {
      // Expired/revoked authorization or Conditional Access requires sign-in.
      if (error instanceof msal.InteractionRequiredAuthError ||
          ['invalid_grant', 'no_tokens_found', 'no_account_in_silent_request'].includes(error.errorCode)) return null;
      throw error;
    }
  });
}
function cookieOptions(req, { flow = false, clear = false, guest = false } = {}) {
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(req.secure || (!guest && config.azure.redirectUri.startsWith('https:'))),
    signed: true,
    path: flow ? '/api/v1/auth' : '/',
  };
  if (!clear) options.maxAge = flow ? FLOW_MAX_AGE : SESSION_MAX_AGE;
  return options;
}

module.exports = {
  isConfigured, configurationIssues, hasSafeCookieSecret, isGuestSession, SCOPES, SESSION_MAX_AGE, FLOW_MAX_AGE,
  getLoginUrl, handleCallback, getAccessTokenForSession,
  newSessionId, newState, newLoginTransaction, validTransaction, validateIdentity, cookieOptions,
};
