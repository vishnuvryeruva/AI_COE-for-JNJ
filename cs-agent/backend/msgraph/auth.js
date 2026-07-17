const crypto = require('crypto');
const msal = require('@azure/msal-node');
const config = require('../config');
const db = require('../db');

/**
 * Microsoft Graph delegated auth (Authorization Code flow).
 *
 * "Delegated" = the app acts on behalf of the signed-in CSR, so it sees THAT
 * user's own mailbox. Whose inbox is shown = whoever logged in. This is the
 * model Pramod described: sign in with the J&J identity, pick an email, send.
 *
 * The same code runs against a dev tenant or against J&J — only the tenantId /
 * clientId / secret / redirectUri differ. Until those are set, isConfigured()
 * is false and the whole Outlook surface stays hidden.
 */

const SCOPES = ['User.Read', 'Mail.Read', 'Mail.Send', 'offline_access'];

function isConfigured() {
  return Boolean(config.azure.clientId && config.azure.clientSecret);
}

// Persist the MSAL token cache to Postgres so refresh tokens survive a restart.
const cachePlugin = {
  beforeCacheAccess: async (cacheContext) => {
    const blob = await db.loadMsalCache();
    if (blob) cacheContext.tokenCache.deserialize(blob);
  },
  afterCacheAccess: async (cacheContext) => {
    if (cacheContext.cacheHasChanged) {
      await db.saveMsalCache(cacheContext.tokenCache.serialize());
    }
  },
};

let cca = null;
function client() {
  if (!cca) {
    cca = new msal.ConfidentialClientApplication({
      auth: {
        clientId: config.azure.clientId,
        clientSecret: config.azure.clientSecret,
        authority: `https://login.microsoftonline.com/${config.azure.tenantId}`,
      },
      cache: { cachePlugin },
    });
  }
  return cca;
}

/** Step 1: URL to send the browser to. `state` is CSRF protection. */
async function getLoginUrl(state) {
  return client().getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: config.azure.redirectUri,
    state,
  });
}

/** Step 2: exchange the returned code for tokens; returns the account. */
async function handleCallback(code) {
  const result = await client().acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: config.azure.redirectUri,
  });
  return result.account; // { homeAccountId, username, name, ... }
}

/** Get a fresh access token for a session's account (auto-refreshes). */
async function getAccessTokenForSession(session) {
  if (!session) return null;
  const accounts = await client().getTokenCache().getAllAccounts();
  const account = accounts.find((a) => a.homeAccountId === session.home_account_id);
  if (!account) return null;

  try {
    const result = await client().acquireTokenSilent({ account, scopes: SCOPES });
    return result.accessToken;
  } catch {
    // Refresh token expired/revoked — the CSR must sign in again.
    return null;
  }
}

function newSessionId() {
  return crypto.randomBytes(24).toString('hex');
}

function newState() {
  return crypto.randomBytes(16).toString('hex');
}

// httpOnly always; Secure only over real https (so http://localhost still works).
function cookieOptions(req) {
  const https = req.secure || req.get('x-forwarded-proto') === 'https';
  return { httpOnly: true, sameSite: 'lax', secure: https, maxAge: 8 * 60 * 60 * 1000 };
}

module.exports = {
  isConfigured, SCOPES,
  getLoginUrl, handleCallback, getAccessTokenForSession,
  newSessionId, newState, cookieOptions,
};
