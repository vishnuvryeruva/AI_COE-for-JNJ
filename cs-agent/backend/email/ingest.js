const { v4: uuid } = require('uuid');
const db = require('../db');
const agent = require('../agent');
const config = require('../config');
const { parseForwardedEmail, buildManualEmail, buildEmailFromGraphMessage } = require('./parser');

/**
 * The single funnel every ingestion adapter goes through.
 *
 * Adapters (manual paste, .eml upload, Graph polling, later a webhook) differ
 * only in how they produce the normalized email. Everything downstream is
 * shared, which is what makes the mechanism swappable — and, per Pramod, what
 * makes this piece reusable across other use cases.
 */
async function ingest(email, source, sourceMessageId) {
  if (sourceMessageId) {
    const existing = await db.findBySourceMessageId(sourceMessageId);
    if (existing) return { request: existing, deduped: true };
  }

  const id = uuid();
  let result;

  try {
    result = await agent.process(email);
  } catch (err) {
    // A model failure shouldn't lose the email — park it as FAILED so the CSR
    // can still see it and retry.
    result = {
      analysis: {
        intent: 'OTHER', intentLabel: 'Other / Unclassified', confidence: 0,
        reasoning: `Agent failed: ${err.message}`,
        orderNumber: null, deliveryNumber: null, language: 'en', requesterType: 'UNKNOWN',
      },
      draft: { ...agent.addressReply(email), subject: '', body: '' },
      status: 'FAILED',
      statusReason: err.message,
    };
  }

  const request = await db.insertRequest(id, email, result, source, sourceMessageId);

  await db.addAudit(id, 'system', 'INGESTED', `source=${source}, extraction=${email.extraction.method} (${email.extraction.confidence})`);
  if (result.status !== 'FAILED') {
    await db.addAudit(id, 'agent', 'ANALYZED', `intent=${result.analysis.intent}, confidence=${result.analysis.confidence}`);
    await db.addAudit(id, 'agent', 'DRAFTED', `status=${result.status}${result.statusReason ? ` (${result.statusReason})` : ''}`);
  } else {
    await db.addAudit(id, 'agent', 'FAILED', result.statusReason);
  }

  return { request, deduped: false };
}

/** Adapter: a forwarded .eml / rfc822 file uploaded through the UI. */
async function ingestEml(buffer, filename) {
  const email = await parseForwardedEmail(buffer, { agentMailbox: config.agentMailbox });
  return ingest(email, 'EML_UPLOAD', `upload-${filename}-${buffer.length}`);
}

/** Adapter: the manual paste form. Demo path and test harness. */
async function ingestManual({ from, subject, body, mailingGroup }) {
  const email = buildManualEmail({ from, subject, body, mailingGroup });
  return ingest(email, 'MANUAL', null);
}

/**
 * Adapter: a message the CSR picked from their own Outlook inbox (via Graph).
 * The message is the customer's original, so its From is the sender directly.
 *
 * @param {object} graphMsg - full Graph message (from/to/cc/subject/body)
 * @param {string} selfAddress - the signed-in CSR, excluded from group inference
 */
async function ingestGraphMessage(graphMsg, selfAddress) {
  const email = buildEmailFromGraphMessage(graphMsg, selfAddress);
  return ingest(email, 'GRAPH_PICK', graphMsg.internetMessageId || graphMsg.id);
}

module.exports = { ingest, ingestEml, ingestManual, ingestGraphMessage };
