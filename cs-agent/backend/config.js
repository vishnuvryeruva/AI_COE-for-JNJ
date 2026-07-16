require('dotenv').config();

module.exports = {
  aicoreServiceKey: process.env.AICORE_SERVICE_KEY || '',
  aicoreModel: process.env.AICORE_MODEL || 'gpt-4o-mini',

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
