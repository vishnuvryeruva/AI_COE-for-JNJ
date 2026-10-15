const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool(config.dbConfig);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id                   UUID PRIMARY KEY,
  status               TEXT NOT NULL,
  status_reason        TEXT,
  source               TEXT NOT NULL,
  source_message_id    TEXT,
  owner_account_id     TEXT,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  forwarded_by         TEXT,
  csr_note             TEXT,
  mailing_group        TEXT,

  original_from        TEXT,
  original_from_name   TEXT,
  original_to          TEXT[],
  original_cc          TEXT[],
  original_subject     TEXT,
  original_body        TEXT,
  original_sent_at     TIMESTAMPTZ,
  original_attachments JSONB NOT NULL DEFAULT '[]'::jsonb,

  extraction_method    TEXT,
  extraction_confidence REAL,
  extraction_warnings  TEXT[],

  intent               TEXT,
  intent_label         TEXT,
  analysis_confidence  REAL,
  reasoning            TEXT,
  order_number         TEXT,
  delivery_number      TEXT,
  language             TEXT,
  requester_type       TEXT,

  draft_to             TEXT,
  draft_cc             TEXT[],
  draft_subject        TEXT,
  draft_body           TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Preserve existing demo rows, but keep them out of signed-in users' queues.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS owner_account_id TEXT;
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_source_message_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS requests_owner_message_idx
  ON requests (COALESCE(owner_account_id, ''), source_message_id);
CREATE INDEX IF NOT EXISTS requests_owner_idx ON requests (owner_account_id);
CREATE INDEX IF NOT EXISTS requests_status_idx ON requests (status);
CREATE INDEX IF NOT EXISTS requests_received_idx ON requests (received_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id         BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  details    TEXT
);

CREATE INDEX IF NOT EXISTS audit_request_idx ON audit_events (request_id, ts);

-- Microsoft Graph delegated auth. One serialized MSAL token cache blob (all
-- accounts) so refresh tokens survive a container restart mid-demo.
CREATE TABLE IF NOT EXISTS msal_cache (
  id    TEXT PRIMARY KEY,
  blob  TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Browser session -> which signed-in Microsoft account it maps to.
CREATE TABLE IF NOT EXISTS web_sessions (
  sid              TEXT PRIMARY KEY,
  home_account_id  TEXT NOT NULL,
  username         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function init() {
  await pool.query(SCHEMA);
}

function rowToRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    statusReason: row.status_reason,
    source: row.source,
    receivedAt: row.received_at,
    forwardedBy: row.forwarded_by,
    csrNote: row.csr_note,
    mailingGroup: row.mailing_group,
    email: {
      from: row.original_from,
      fromName: row.original_from_name,
      to: row.original_to || [],
      cc: row.original_cc || [],
      subject: row.original_subject,
      body: row.original_body,
      sentAt: row.original_sent_at,
      attachments: row.original_attachments || [],
    },
    extraction: {
      method: row.extraction_method,
      confidence: row.extraction_confidence,
      warnings: row.extraction_warnings || [],
    },
    analysis: {
      intent: row.intent,
      intentLabel: row.intent_label,
      confidence: row.analysis_confidence,
      reasoning: row.reasoning,
      orderNumber: row.order_number,
      deliveryNumber: row.delivery_number,
      language: row.language,
      requesterType: row.requester_type,
    },
    draft: {
      to: row.draft_to,
      cc: row.draft_cc || [],
      subject: row.draft_subject,
      body: row.draft_body,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertRequest(id, email, result, source, sourceMessageId, ownerAccountId = null) {
  const { rows } = await pool.query(
    `INSERT INTO requests (
       id, status, status_reason, source, source_message_id,
       forwarded_by, csr_note, mailing_group,
       original_from, original_from_name, original_to, original_cc,
       original_subject, original_body, original_sent_at, original_attachments,
       extraction_method, extraction_confidence, extraction_warnings,
       intent, intent_label, analysis_confidence, reasoning,
       order_number, delivery_number, language, requester_type,
       draft_to, draft_cc, draft_subject, draft_body, owner_account_id
     ) VALUES (
       $1,$2,$3,$4,$5,
       $6,$7,$8,
       $9,$10,$11,$12,
       $13,$14,$15,$16,
       $17,$18,$19,
       $20,$21,$22,$23,
       $24,$25,$26,$27,
       $28,$29,$30,$31,$32
     ) RETURNING *`,
    [
      id, result.status, result.statusReason, source, sourceMessageId,
      email.forwardedBy, email.csrNote, email.mailingGroup,
      email.original.from, email.original.fromName, email.original.to, email.original.cc,
      email.original.subject, email.original.body, email.original.sentAt,
      JSON.stringify(email.original.attachments || []),
      email.extraction.method, email.extraction.confidence, email.extraction.warnings,
      result.analysis.intent, result.analysis.intentLabel, result.analysis.confidence,
      result.analysis.reasoning, result.analysis.orderNumber, result.analysis.deliveryNumber,
      result.analysis.language, result.analysis.requesterType,
      result.draft.to, result.draft.cc, result.draft.subject, result.draft.body, ownerAccountId,
    ]
  );
  return rowToRequest(rows[0]);
}

async function listRequests({ status, intent, limit = 100 } = {}, ownerAccountId = null) {
  const clauses = ['owner_account_id IS NOT DISTINCT FROM $1::text'];
  const params = [ownerAccountId];
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  if (intent) { params.push(intent); clauses.push(`intent = $${params.length}`); }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT * FROM requests
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY received_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows.map(rowToRequest);
}

async function getRequest(id, ownerAccountId = null) {
  const { rows } = await pool.query('SELECT * FROM requests WHERE id = $1 AND owner_account_id IS NOT DISTINCT FROM $2::text', [id, ownerAccountId]);
  return rowToRequest(rows[0]);
}

async function updateDraft(id, { subject, body, to, cc }, ownerAccountId = null) {
  const { rows } = await pool.query(
    `UPDATE requests
     SET draft_subject = COALESCE($2, draft_subject),
         draft_body    = COALESCE($3, draft_body),
         draft_to      = COALESCE($4, draft_to),
         draft_cc      = COALESCE($5, draft_cc),
         updated_at    = NOW()
     WHERE id = $1 AND owner_account_id IS NOT DISTINCT FROM $6::text RETURNING *`,
    [id, subject, body, to, cc, ownerAccountId]
  );
  return rowToRequest(rows[0]);
}

async function setStatus(id, status, reason, ownerAccountId = null) {
  const { rows } = await pool.query(
    `UPDATE requests SET status = $2, status_reason = $3, updated_at = NOW()
     WHERE id = $1 AND owner_account_id IS NOT DISTINCT FROM $4::text RETURNING *`,
    [id, status, reason || null, ownerAccountId]
  );
  return rowToRequest(rows[0]);
}

async function stats(ownerAccountId = null) {
  const { rows } = await pool.query('SELECT status, COUNT(*)::int AS count FROM requests WHERE owner_account_id IS NOT DISTINCT FROM $1::text GROUP BY status', [ownerAccountId]);
  const counts = { READY: 0, NEEDS_REVIEW: 0, FAILED: 0, SENT: 0, REJECTED: 0, APPROVED: 0 };
  for (const row of rows) counts[row.status] = row.count;
  counts.TOTAL = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

async function addAudit(requestId, actor, action, details) {
  await pool.query(
    'INSERT INTO audit_events (request_id, actor, action, details) VALUES ($1,$2,$3,$4)',
    [requestId, actor, action, details || null]
  );
}

async function getAudit(requestId, ownerAccountId = null) {
  const { rows } = await pool.query(
    `SELECT ts, actor, action, details FROM audit_events
     WHERE request_id = $1 AND EXISTS (
       SELECT 1 FROM requests WHERE id = $1 AND owner_account_id IS NOT DISTINCT FROM $2::text
     ) ORDER BY ts`,
    [requestId, ownerAccountId]
  );
  return rows;
}

async function findBySourceMessageId(sourceMessageId, ownerAccountId = null) {
  if (!sourceMessageId) return null;
  const { rows } = await pool.query('SELECT * FROM requests WHERE source_message_id = $1 AND owner_account_id IS NOT DISTINCT FROM $2::text', [sourceMessageId, ownerAccountId]);
  return rowToRequest(rows[0]);
}

// --- Microsoft Graph auth persistence ---

async function loadMsalCache() {
  const { rows } = await pool.query("SELECT blob FROM msal_cache WHERE id = 'msal'");
  return rows[0] ? rows[0].blob : null;
}

async function saveMsalCache(blob) {
  await pool.query(
    `INSERT INTO msal_cache (id, blob, updated_at) VALUES ('msal', $1, NOW())
     ON CONFLICT (id) DO UPDATE SET blob = EXCLUDED.blob, updated_at = NOW()`,
    [blob]
  );
}

async function createSession(sid, homeAccountId, username) {
  await pool.query(
    `INSERT INTO web_sessions (sid, home_account_id, username) VALUES ($1, $2, $3)
     ON CONFLICT (sid) DO UPDATE SET home_account_id = EXCLUDED.home_account_id, username = EXCLUDED.username`,
    [sid, homeAccountId, username]
  );
}

async function getSession(sid) {
  if (!sid) return null;
  const { rows } = await pool.query("SELECT sid, home_account_id, username FROM web_sessions WHERE sid = $1 AND created_at > NOW() - INTERVAL '8 hours'", [sid]);
  return rows[0] || null;
}

async function deleteSession(sid) {
  if (!sid) return;
  await pool.query('DELETE FROM web_sessions WHERE sid = $1', [sid]);
}

module.exports = {
  pool, init, insertRequest, listRequests, getRequest, updateDraft,
  setStatus, stats, addAudit, getAudit, findBySourceMessageId,
  loadMsalCache, saveMsalCache, createSession, getSession, deleteSession,
};
