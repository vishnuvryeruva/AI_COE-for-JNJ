const { v4: uuid } = require('uuid');
const db = require('../db');
const agent = require('../agent');
const config = require('../config');
const { parseForwardedEmail, buildManualEmail } = require('./parser');

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
 * Adapter: Microsoft Graph polling. Not wired yet — blocked on the AAD app
 * registration and mailbox. The shape is here so that landing it is one file,
 * not a refactor.
 *
 * When enabled:
 *   GET /users/{mailbox}/mailFolders/inbox/messages/delta   (persist deltaLink)
 *   GET /users/{mailbox}/messages/{id}/attachments?$expand=microsoft.graph.itemAttachment/item
 *   -> pass the raw MIME to parseForwardedEmail()
 *   -> dedupe on internetMessageId, then move the message to /Processed
 */
async function ingestGraphMessage(rawMime, internetMessageId) {
  const email = await parseForwardedEmail(rawMime, { agentMailbox: config.agentMailbox });
  return ingest(email, 'GRAPH_POLL', internetMessageId);
}

module.exports = { ingest, ingestEml, ingestManual, ingestGraphMessage };
