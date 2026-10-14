const { readEmail, emailFileError, MAX_EMAIL_BYTES } = require('./formats');

/**
 * Recovering the original sender from a forwarded email.
 *
 * Pramod's rule (call 2026-07-15): reply To the original sender, CC the mailing
 * group, never To the mailing group. So this module's output decides who the
 * customer-facing reply is addressed to — it is the load-bearing part of POC 1.
 *
 * Two paths:
 *   RFC822_ATTACHMENT - CSR used "Forward as Attachment" (Ctrl+Alt+F). The
 *     original arrives as a real message with intact headers. Confidence 1.0.
 *   BODY_PARSE - plain forward. The original is prose inside the body and we
 *     recover it heuristically. Lower confidence, may fail.
 *
 * When we can't identify the sender we degrade to NEEDS_REVIEW rather than
 * guessing — a wrong To on a customer-facing email is the worst failure here.
 */

// Outlook localizes these to the *forwarder's* client language. EDC is a
// European DC, so non-English forwarders are expected.
const HEADER_LABELS = {
  from: ['From', 'Von', 'De', 'Da', 'Van', 'Od', 'Från', 'Fra', 'Lähettäjä', 'Feladó'],
  sent: ['Sent', 'Gesendet', 'Envoyé', 'Enviado', 'Inviato', 'Verzonden', 'Wysłano', 'Skickat', 'Lähetetty'],
  to: ['To', 'An', 'À', 'Para', 'A', 'Aan', 'Do', 'Till', 'Til', 'Vastaanottaja', 'Címzett'],
  cc: ['Cc', 'CC', 'Kopie', 'Copie', 'Copia', 'DW'],
  subject: ['Subject', 'Betreff', 'Objet', 'Asunto', 'Oggetto', 'Onderwerp', 'Temat', 'Ämne', 'Emne', 'Aihe', 'Tárgy'],
};

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;

function labelPattern(labels) {
  const escaped = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `(?:${escaped.join('|')})`;
}

/** Matches a header line in any supported language, plain text or de-tagged HTML. */
function findHeaderValue(text, labels) {
  const re = new RegExp(`^\\s*${labelPattern(labels)}\\s*:\\s*(.+)$`, 'im');
  const match = text.match(re);
  return match ? match[1].trim() : null;
}

function parseAddressLine(line) {
  if (!line) return null;
  const address = (line.match(EMAIL_RE) || [])[0];
  if (!address) {
    // Outlook may resolve against the GAL and leave only a display name.
    return { address: null, name: line.replace(/[<>"]/g, '').trim() || null };
  }
  const name = line
    .replace(address, '')
    .replace(/[<>"]/g, '')
    .replace(/mailto:/gi, '')
    .trim()
    .replace(/[;,]$/, '');
  return { address: address.toLowerCase(), name: name || null };
}

function parseAddressList(line) {
  if (!line) return [];
  return (line.match(new RegExp(EMAIL_RE.source, 'g')) || []).map((a) => a.toLowerCase());
}

function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Locates the forwarded block. Separator style varies by Outlook version and
 * language, so we try the explicit markers first and fall back to "wherever the
 * From: header block appears".
 *
 * Returns two offsets because the separator itself belongs to neither side:
 * anything before it is the CSR's own note, anything after it is the original.
 *
 * @returns {{noteEnd: number, blockStart: number}|null}
 */
function findForwardBoundary(text) {
  const markers = [
    /^-{2,}\s*(?:Original Message|Ursprüngliche Nachricht|Message d'origine|Mensaje original|Messaggio originale|Oorspronkelijk bericht)\s*-{2,}\s*$/im,
    /^_{5,}\s*$/m,
    /^-{5,}\s*$/m,
    /^\s*(?:Begin forwarded message|Anfang der weitergeleiteten Nachricht|Début du message transféré)\s*:?\s*$/im,
  ];

  for (const marker of markers) {
    const match = text.match(marker);
    if (match && typeof match.index === 'number') {
      return { noteEnd: match.index, blockStart: match.index + match[0].length };
    }
  }

  const fromHeader = new RegExp(`^\\s*${labelPattern(HEADER_LABELS.from)}\\s*:\\s*.+$`, 'im');
  const match = text.match(fromHeader);
  if (match && typeof match.index === 'number') {
    return { noteEnd: match.index, blockStart: match.index };
  }
  return null;
}

function normalizeParsedAddress(addressObject) {
  const first = addressObject?.value?.[0];
  if (!first) return { address: null, name: null };
  return {
    address: first.address ? first.address.toLowerCase() : null,
    name: first.name || null,
  };
}

function addressListFrom(addressObject) {
  return (addressObject?.value || [])
    .map((v) => v.address)
    .filter(Boolean)
    .map((a) => a.toLowerCase());
}

/**
 * Picks the mailing group to CC. Heuristic: the forwarded original was usually
 * addressed to a group alias rather than a person, so prefer a recipient that
 * looks like a distribution list and isn't our own agent mailbox.
 */
function inferMailingGroup(recipients, agentMailbox) {
  const candidates = recipients.filter((a) => a && a !== agentMailbox.toLowerCase());
  if (candidates.length === 0) return null;

  const groupish = candidates.find((a) =>
    /(^|[._-])(cs|service|support|customerservice|customer-service|edc|team|group|dl|info|help|desk|inbox)([._-]|@)/i.test(a)
  );
  return groupish || candidates[0];
}

function extractRfc822Attachment(attachments = []) {
  return attachments.find(
    (a) =>
      a.embeddedMessage || a.contentType === 'message/rfc822' ||
      /\.(eml|msg)$/i.test(a.filename || '') ||
      a.contentType === 'application/vnd.ms-outlook'
  );
}

function describeAttachments(attachments = []) {
  return attachments
    .filter((a) => !extractRfc822Attachment([a]))
    .map((a) => ({
      name: a.filename || 'attachment',
      mime: a.contentType || 'application/octet-stream',
      size: a.size || (a.content ? a.content.length : 0),
    }));
}

/**
 * @param {Buffer|string} raw - the forwarded email (.eml / .msg)
 * @param {object} [options]
 * @param {string} [options.agentMailbox] - excluded when inferring the mailing group
 */
async function parseForwardedEmail(raw, { agentMailbox = '', filename = '', allowDirect = false } = {}) {
  const outer = await readEmail(raw, { filename });

  const forwarder = normalizeParsedAddress(outer.from);
  const outerRecipients = [...addressListFrom(outer.to), ...addressListFrom(outer.cc)];

  // --- Preferred path: forwarded as attachment ---
  const rfc822 = extractRfc822Attachment(outer.attachments);
  if (rfc822 && (rfc822.content || rfc822.embeddedMessage)) {
    const inner = rfc822.embeddedMessage || await readEmail(rfc822.content, { filename: rfc822.filename || '' });
    const sender = normalizeParsedAddress(inner.from);
    const innerRecipients = [...addressListFrom(inner.to), ...addressListFrom(inner.cc)];

    return {
      forwardedBy: forwarder.address,
      csrNote: (outer.text || '').trim() || null,
      mailingGroup: inferMailingGroup(innerRecipients, agentMailbox),
      original: {
        from: sender.address,
        fromName: sender.name,
        to: addressListFrom(inner.to),
        cc: addressListFrom(inner.cc),
        subject: inner.subject || null,
        body: (inner.text || htmlToText(inner.html) || '').trim(),
        sentAt: inner.date ? inner.date.toISOString() : null,
        attachments: describeAttachments(inner.attachments),
      },
      extraction: {
        method: inner.format === 'MSG' ? 'MSG_ATTACHMENT' : 'RFC822_ATTACHMENT',
        confidence: sender.address ? 1.0 : 0,
        warnings: sender.address ? [] : ['Original sender had no resolvable email address'],
      },
    };
  }

  // --- Fallback path: parse the forwarded block out of the body ---
  const bodyText = (outer.text || htmlToText(outer.html) || '').replace(/\r/g, '');
  // Ordinary replies can quote older From:/To: blocks. Their current From
  // remains authoritative unless the subject identifies an actual forward.
  const isForward = /^\s*(FW|FWD|WG|TR|RV):/i.test(outer.subject || '');
  const boundary = allowDirect && !isForward ? null : findForwardBoundary(bodyText);
  const warnings = [];

  if (!boundary) {
    // Saving/dragging a message from Outlook produces the original email, not
    // necessarily a forward. A forward subject still requires sender recovery.
    if (allowDirect && !isForward) {
      return {
        forwardedBy: null,
        csrNote: null,
        mailingGroup: inferMailingGroup(outerRecipients, agentMailbox),
        original: {
          from: forwarder.address,
          fromName: forwarder.name,
          to: addressListFrom(outer.to),
          cc: addressListFrom(outer.cc),
          subject: outer.subject || null,
          body: bodyText.trim(),
          sentAt: outer.date ? outer.date.toISOString() : null,
          attachments: describeAttachments(outer.attachments),
        },
        extraction: {
          method: `${outer.format}_DIRECT`,
          confidence: forwarder.address ? 1.0 : 0,
          warnings: forwarder.address ? [] : ['Message had no resolvable sender email address. Review the sender before replying.'],
        },
      };
    }
    return {
      forwardedBy: forwarder.address,
      csrNote: null,
      mailingGroup: inferMailingGroup(outerRecipients, agentMailbox),
      original: {
        from: null,
        fromName: null,
        to: [],
        cc: [],
        subject: outer.subject ? outer.subject.replace(/^\s*(FW|FWD|WG|TR|RV):\s*/i, '') : null,
        body: bodyText.trim(),
        sentAt: outer.date ? outer.date.toISOString() : null,
        attachments: describeAttachments(outer.attachments),
      },
      extraction: {
        method: 'BODY_PARSE',
        confidence: 0,
        warnings: [
          'No forwarded-message block found. Could not identify the original sender.',
          'Ask the CSR to use "Forward as Attachment" (Ctrl+Alt+F).',
        ],
      },
    };
  }

  const csrNote = bodyText.slice(0, boundary.noteEnd).trim() || null;
  const forwardedBlock = bodyText.slice(boundary.blockStart);

  const fromLine = findHeaderValue(forwardedBlock, HEADER_LABELS.from);
  const toLine = findHeaderValue(forwardedBlock, HEADER_LABELS.to);
  const ccLine = findHeaderValue(forwardedBlock, HEADER_LABELS.cc);
  const subjectLine = findHeaderValue(forwardedBlock, HEADER_LABELS.subject);
  const sentLine = findHeaderValue(forwardedBlock, HEADER_LABELS.sent);

  const sender = parseAddressLine(fromLine);
  const toList = parseAddressList(toLine);
  const ccList = parseAddressList(ccLine);

  // Body is whatever follows the last recognized header line.
  let originalBody = forwardedBlock;
  const lastHeaderLine = [subjectLine, toLine, ccLine, sentLine, fromLine]
    .filter(Boolean)
    .map((value) => forwardedBlock.indexOf(value))
    .filter((i) => i !== -1)
    .sort((a, b) => b - a)[0];
  if (lastHeaderLine !== undefined) {
    const newline = forwardedBlock.indexOf('\n', lastHeaderLine);
    if (newline !== -1) originalBody = forwardedBlock.slice(newline + 1);
  }

  let confidence = 0.9;
  if (!sender?.address) {
    confidence = 0;
    warnings.push('Could not resolve an email address for the original sender.');
    if (sender?.name) warnings.push(`Only a display name was present: "${sender.name}".`);
  }
  if (!subjectLine) {
    confidence = Math.min(confidence, 0.7);
    warnings.push('Could not find the original subject line.');
  }
  if (/^\s*(FW|FWD|WG|TR|RV):/i.test(subjectLine || '')) {
    confidence = Math.min(confidence, 0.6);
    warnings.push('Nested forward detected — the original sender may be deeper in the chain.');
  }
  if (confidence > 0 && confidence < 1) {
    warnings.push('Recovered by parsing the message body. "Forward as Attachment" would make this exact.');
  }

  return {
    forwardedBy: forwarder.address,
    csrNote,
    mailingGroup: inferMailingGroup([...toList, ...ccList, ...outerRecipients], agentMailbox),
    original: {
      from: sender?.address || null,
      fromName: sender?.name || null,
      to: toList,
      cc: ccList,
      subject: subjectLine || (outer.subject || '').replace(/^\s*(FW|FWD|WG|TR|RV):\s*/i, '') || null,
      body: originalBody.trim(),
      sentAt: outer.date ? outer.date.toISOString() : null,
      attachments: describeAttachments(outer.attachments),
    },
    extraction: { method: 'BODY_PARSE', confidence, warnings },
  };
}

/** A saved original email or forwarded email uploaded through the UI. */
async function parseUploadedEmail(raw, options = {}) {
  return parseForwardedEmail(raw, { ...options, allowDirect: true });
}

/**
 * A message picked from the CSR's own Outlook inbox (via Graph).
 *
 * Unlike a forward, this is the customer's ORIGINAL email — its From header IS
 * the customer, so there's nothing to recover and confidence is 1.0. The
 * mailing group is inferred from To/Cc, excluding the signed-in CSR themselves.
 *
 * @param {object} graphMsg - Graph message with from/toRecipients/ccRecipients/body
 * @param {string} selfAddress - the signed-in CSR's address, excluded from group inference
 */
function buildEmailFromGraphMessage(graphMsg, selfAddress = '') {
  const from = graphMsg.from?.emailAddress || {};
  const toList = (graphMsg.toRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean).map((a) => a.toLowerCase());
  const ccList = (graphMsg.ccRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean).map((a) => a.toLowerCase());

  const bodyContent = graphMsg.body?.content || '';
  const body = graphMsg.body?.contentType === 'html' ? htmlToText(bodyContent) : bodyContent;

  const self = (selfAddress || '').toLowerCase();
  const group = inferMailingGroup([...toList, ...ccList].filter((a) => a !== self), self);

  return {
    forwardedBy: null,
    csrNote: null,
    mailingGroup: group,
    original: {
      from: from.address ? from.address.toLowerCase() : null,
      fromName: from.name || null,
      to: toList,
      cc: ccList,
      subject: graphMsg.subject || null,
      body: (body || '').trim(),
      sentAt: graphMsg.receivedDateTime || null,
      attachments: [],
    },
    extraction: {
      method: 'GRAPH_DIRECT',
      confidence: from.address ? 1.0 : 0,
      warnings: from.address ? [] : ['Message had no sender address'],
    },
  };
}

/** Manual paste path — the CSR types the fields, so treat them as given. */
function buildManualEmail({ from, subject, body, mailingGroup }) {
  const sender = parseAddressLine(from);
  return {
    forwardedBy: null,
    csrNote: null,
    mailingGroup: mailingGroup || null,
    original: {
      from: sender?.address || null,
      fromName: sender?.name || null,
      to: [],
      cc: [],
      subject: subject || null,
      body: body || '',
      sentAt: new Date().toISOString(),
      attachments: [],
    },
    extraction: {
      method: 'MANUAL',
      confidence: sender?.address ? 1.0 : 0,
      warnings: sender?.address ? [] : ['No valid email address supplied.'],
    },
  };
}

module.exports = {
  parseForwardedEmail,
  parseUploadedEmail,
  emailFileError,
  MAX_EMAIL_BYTES,
  buildManualEmail,
  buildEmailFromGraphMessage,
  // exported for tests
  findHeaderValue,
  parseAddressLine,
  findForwardBoundary,
  inferMailingGroup,
  htmlToText,
  HEADER_LABELS,
};
