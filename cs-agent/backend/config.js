require('dotenv').config();
const { randomBytes } = require('node:crypto');

module.exports = {
  aicoreServiceKey: process.env.AICORE_SERVICE_KEY || '',
  aicoreModel: process.env.AICORE_MODEL || 'gpt-4o-mini',

  isProd: process.env.NODE_ENV === 'production',
  // A demo can run without provisioning secrets, but never with a predictable
  // signing key. Set COOKIE_SECRET to preserve sessions across restarts.
  cookieSecret: process.env.COOKIE_SECRET || randomBytes(32).toString('hex'),
  guestDemoEnabled: process.env.GUEST_DEMO_ENABLED === 'true',
  // Fail closed in deployed environments. Explicitly opt out only for a demo
  // containing no company/customer data.
  authRequired: process.env.AUTH_REQUIRED === undefined
    ? process.env.NODE_ENV === 'production'
    : process.env.AUTH_REQUIRED !== 'false',

  // Microsoft Graph (delegated). Company access requires these settings; an
  // explicitly enabled guest demo works without them and cannot access Graph.
  azure: {
    clientId: process.env.AZURE_CLIENT_ID || '',
    clientSecret: process.env.AZURE_CLIENT_SECRET || '',
    // Use J&J's Directory (tenant) ID, never common/organizations/consumers.
    tenantId: process.env.AZURE_TENANT_ID || '',
    // Must EXACTLY match the redirect URI registered in Azure AD.
    redirectUri: process.env.AZURE_REDIRECT_URI || 'http://localhost:8080/api/v1/auth/callback',
    // Where the browser lands after login completes.
    postLoginUri: process.env.AZURE_POST_LOGIN_URI || '/',
  },

  // Address the CSRs forward to. Also the default CC when we can't identify a
  // mailing group from the forwarded email.
  agentMailbox: process.env.AGENT_MAILBOX || 'cs-agent@medtech-ai.jnj.com',

  // Below this, a draft lands in NEEDS_REVIEW rather than READY.
  // Nothing auto-sends at any confidence — POC 1 is 100% human-approved.
  confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.75'),

  dbConfig: process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
      }
    : {
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
        user: process.env.POSTGRES_USER || 'csagent',
        password: process.env.POSTGRES_PASSWORD || 'database123456',
        database: process.env.POSTGRES_DB || 'csagent',
      },
};
