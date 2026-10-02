const aiCore = require('./ai-core');
const config = require('./config');
const { extractOrderNumbers } = require('./msgraph/mailbox-query');

/**
 * POC 1 scope (Pramod, 2026-07-15): "ingest the email, know the intent and
 * draft an email." No ERP calls, no document retrieval — that is POC 2. So the
 * draft here acknowledges the request and states what will follow; it must not
 * invent order data it has no source for.
 */

const INTENTS = {
  SALES_ORDER_REQUEST: 'Sales Order Request',
  ORDER_STATUS: 'Order Status Inquiry',
  PACKING_LIST_REQUEST: 'Packing List Request',
  INVOICE_REQUEST: 'Invoice Request',
  SHIPMENT_TRACKING: 'Shipment Tracking',
  PROOF_OF_DELIVERY: 'Proof of Delivery',
  DOCUMENT_REQUEST_OTHER: 'Other Document Request',
  OTHER: 'Other / Unclassified',
};

const CLASSIFY_SYSTEM = `You are a classifier for the customer service desk of a European Distribution Center (EDC) that ships medical devices on behalf of manufacturing franchises.

Requests arrive either from a franchise's customer service group acting for their customer, or from an end customer directly.

Classify the email and extract identifiers. Respond with JSON only, no prose:

{
  "intent": one of [${Object.keys(INTENTS).join(', ')}],
  "confidence": number 0..1,
  "reasoning": "one or two sentences on why, citing what the email actually says",
  "orderNumber": "the sales order number, or null",
  "deliveryNumber": "the delivery/shipment number, or null",
  "language": "ISO 639-1 code of the email's language",
  "requesterType": "FRANCHISE_CS" | "END_CUSTOMER" | "UNKNOWN"
}

Rules:
- Only report an orderNumber that literally appears in the email. Never invent or complete one.
- If several intents apply, pick the primary one and say so in reasoning.
- confidence reflects how clear the intent is, not how confident you feel in general. An ambiguous email should score below 0.7.`;

const DRAFT_SYSTEM = `You draft replies for the customer service desk of a European Distribution Center (EDC) shipping medical devices.

CRITICAL CONSTRAINT: you have NO access to order data, shipment status, or documents. You must not state, guess, or imply any order status, date, quantity, tracking number, or document content. Doing so would put false information in front of a customer.

Write a brief, professional acknowledgement that:
- Confirms what was asked, referencing the order number only if one was given in the email
- States that the team is retrieving the details/documents and will follow up
- Matches the language of the incoming email
- Uses no placeholders like [X] or TBD — a human reviews and sends this as-is

Respond with JSON only, no prose:
{ "subject": "...", "body": "..." }

Keep the body under 120 words. Sign off as "EDC Customer Service".`;

function reply(email) {
  const subject = email.original.subject || '(no subject)';
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Deterministic fallback so ingestion still works when AI Core isn't bound. */
function stubAnalysis(email) {
  const text = `${email.original.subject || ''} ${email.original.body || ''}`;
  const orderNumber = extractOrderNumbers(text)[0] || (text.match(/\b\d{10}\b/) || [])[0] || null;

  let intent = 'OTHER';
  if (/packing\s*list/i.test(text)) intent = 'PACKING_LIST_REQUEST';
  else if (/invoice/i.test(text)) intent = 'INVOICE_REQUEST';
  else if (/proof\s+of\s+delivery|\bPOD\b/i.test(text)) intent = 'PROOF_OF_DELIVERY';
  else if (/track|shipment|where is/i.test(text)) intent = 'SHIPMENT_TRACKING';
  else if (/\b(?:new|place|placing|submit|submitting|create)\s+(?:(?:a|the)\s+)?(?:(?:sales|purchase)\s+)?order\b|\bpurchase\s+order\s+(?:attached|enclosed)\b/i.test(text)) intent = 'SALES_ORDER_REQUEST';
  else if (/status|order/i.test(text)) intent = 'ORDER_STATUS';

  return {
    intent,
    intentLabel: INTENTS[intent],
    confidence: 0.4,
    reasoning: 'AI Core is not configured — this is a keyword-matched placeholder, not a model result.',
    orderNumber,
    deliveryNumber: null,
    language: 'en',
    requesterType: 'UNKNOWN',
    stub: true,
  };
}

function stubDraft(email, analysis) {
  const ref = analysis.orderNumber ? ` regarding order ${analysis.orderNumber}` : '';
  return {
    subject: reply(email),
    body: `Thank you for your message${ref}.\n\nWe are retrieving the details and will come back to you shortly.\n\nKind regards,\nEDC Customer Service`,
    stub: true,
  };
}

async function analyze(email) {
  if (!aiCore.isConfigured()) return stubAnalysis(email);

  const result = await aiCore.generateJson({
    systemInstruction: CLASSIFY_SYSTEM,
    userPrompt: [
      `From: ${email.original.fromName || ''} <${email.original.from || 'unknown'}>`,
      `Subject: ${email.original.subject || '(none)'}`,
      '',
      email.original.body || '(empty body)',
    ].join('\n'),
  });

  const intent = INTENTS[result.intent] ? result.intent : 'OTHER';
  return {
    intent,
    intentLabel: INTENTS[intent],
    confidence: typeof result.confidence === 'number' ? result.confidence : 0,
    reasoning: result.reasoning || null,
    orderNumber: result.orderNumber || null,
    deliveryNumber: result.deliveryNumber || null,
    language: result.language || 'en',
    requesterType: result.requesterType || 'UNKNOWN',
    stub: false,
  };
}

async function draft(email, analysis) {
  if (!aiCore.isConfigured()) return stubDraft(email, analysis);

  const result = await aiCore.generateJson({
    systemInstruction: DRAFT_SYSTEM,
    userPrompt: [
      `Detected intent: ${analysis.intentLabel}`,
      `Order number found in email: ${analysis.orderNumber || 'none'}`,
      `Language: ${analysis.language}`,
      '',
      'Original email:',
      `From: ${email.original.fromName || ''} <${email.original.from || 'unknown'}>`,
      `Subject: ${email.original.subject || '(none)'}`,
      '',
      email.original.body || '(empty body)',
    ].join('\n'),
  });

  return {
    subject: result.subject || reply(email),
    body: result.body || '',
    stub: false,
  };
}

/**
 * Decides the queue state. Two independent things can go wrong, and they are
 * worth distinguishing in the UI: we couldn't work out WHO to reply to
 * (extraction), or we couldn't work out WHAT they wanted (analysis).
 */
function decideStatus(extraction, analysis) {
  if (!extraction.confidence) {
    return { status: 'NEEDS_REVIEW', reason: 'Original sender could not be identified' };
  }
  if (analysis.confidence < config.confidenceThreshold) {
    return { status: 'NEEDS_REVIEW', reason: 'Intent confidence below threshold' };
  }
  if (extraction.confidence < 1) {
    return { status: 'NEEDS_REVIEW', reason: 'Sender recovered by body parsing — confirm before sending' };
  }
  return { status: 'READY', reason: null };
}

/**
 * Reply addressing, per Pramod (2026-07-15): To the original sender, CC the
 * mailing group, never To the mailing group.
 */
function addressReply(email) {
  return {
    to: email.original.from,
    cc: email.mailingGroup ? [email.mailingGroup] : [],
  };
}

async function process(email) {
  const analysis = await analyze(email);
  const drafted = await draft(email, analysis);
  const { to, cc } = addressReply(email);
  const { status, reason } = decideStatus(email.extraction, analysis);

  return {
    analysis,
    draft: { to, cc, subject: drafted.subject, body: drafted.body },
    status,
    statusReason: reason,
    stub: analysis.stub || drafted.stub,
  };
}

module.exports = { process, analyze, draft, decideStatus, addressReply, INTENTS };
