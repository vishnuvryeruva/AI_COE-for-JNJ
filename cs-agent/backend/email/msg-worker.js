const { parentPort, workerData } = require('node:worker_threads');
const MsgReader = require('@kenjiuno/msgreader').default;
const { simpleParser } = require('mailparser');

const SMTP_ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const address = (...values) => values.find((value) => typeof value === 'string' && SMTP_ADDRESS.test(value))?.toLowerCase();

function decodeHtml(fields) {
  if (fields.bodyHtml) return fields.bodyHtml;
  if (!fields.html?.length) return '';
  const bytes = Buffer.from(fields.html);
  const metaCharset = bytes.subarray(0, 4096).toString('ascii').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  const encoding = metaCharset || (fields.internetCodepage === 65001 ? 'utf-8' :
    fields.internetCodepage ? `windows-${fields.internetCodepage}` : 'utf-8');
  try { return new TextDecoder(encoding).decode(bytes); }
  catch { return bytes.toString('utf8'); }
}

async function normalizeMessage(fields, reader, depth = 0) {
  if (depth > 5) throw new Error('This email has too many nested message attachments. Import the original message instead.');
  if (fields.error || fields.dataType !== 'msg') throw new Error('This .msg file is not a readable email. Save the email again from Outlook.');
  if (fields.messageClass && !/^IPM\.Note(?:\.|$)/i.test(fields.messageClass)) {
    throw new Error('This Outlook item is not an email message. Choose a saved email in .msg or .eml format.');
  }
  if (/SMIME|rpmsg/i.test(fields.messageClass || '')) {
    throw new Error('This Outlook message is encrypted or protected. Use an accessible message from your connected Outlook inbox.');
  }
  if (!fields.subject && !fields.body && !fields.bodyHtml && !fields.html && !fields.headers && !fields.senderEmail && !fields.senderSmtpAddress) {
    throw new Error('This file does not contain readable Outlook email fields. Save the email again from Outlook.');
  }
  const headers = fields.headers ? await simpleParser(`${fields.headers.trim()}\r\n\r\n`) : {};
  const sender = address(headers.from?.value?.[0]?.address, fields.sentRepresentingSmtpAddress, fields.senderSmtpAddress, fields.senderEmail);
  const recipients = (kind) => {
    const values = (fields.recipients || []).filter((recipient) => recipient.recipType === kind)
      .map((recipient) => ({ address: address(recipient.smtpAddress, recipient.email), name: recipient.name || '' }))
      .filter((recipient) => recipient.address);
    return { value: values.length ? values : (headers[kind]?.value || []).filter((recipient) => address(recipient.address)) };
  };
  const html = decodeHtml(fields);
  if (!fields.body && !html && fields.compressedRtf) {
    throw new Error('This .msg contains only a Rich Text body. Save it as HTML or plain text in Outlook, or import it from your connected inbox.');
  }
  const attachments = [];
  if ((fields.attachments || []).length > 200) throw new Error('This email has too many attachments. Import a message with 200 or fewer attachments.');
  for (const attachment of fields.attachments || []) {
    const filename = attachment.fileName || attachment.fileNameShort || attachment.name || 'attachment';
    const item = { filename, contentType: attachment.attachMimeTag || 'application/octet-stream', size: attachment.contentLength || 0 };
    if (attachment.innerMsgContentFields) {
      item.filename = /\.msg$/i.test(filename) ? filename : `${filename}.msg`;
      item.contentType = 'application/vnd.ms-outlook';
      item.embeddedMessage = await normalizeMessage(attachment.innerMsgContentFields, reader, depth + 1);
    } else if (/\.(eml|msg)$/i.test(filename) || /^(message\/rfc822|application\/vnd\.ms-outlook)$/i.test(item.contentType)) {
      item.content = Buffer.from(reader.getAttachment(attachment).content);
    }
    attachments.push(item);
  }
  const sent = fields.clientSubmitTime || headers.date || fields.messageDeliveryTime;
  const date = sent ? new Date(sent) : null;
  return {
    format: 'MSG',
    from: { value: [{ address: sender || null, name: headers.from?.value?.[0]?.name || fields.senderName || '' }] },
    to: recipients('to'), cc: recipients('cc'),
    subject: fields.subject || headers.subject || '',
    text: fields.body || '', html,
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    attachments,
  };
}

(async () => {
  try {
    // Give the parser an exact ArrayBuffer, never a view into a pooled Buffer.
    const reader = new MsgReader(Uint8Array.from(workerData).buffer);
    parentPort.postMessage({ data: await normalizeMessage(reader.getFileData(), reader) });
  } catch (error) {
    const actionable = /^(This |The )/.test(error.message);
    parentPort.postMessage({ error: actionable ? error.message : 'This .msg file is damaged or unsupported. Save the email again from Outlook or import it from your connected inbox.' });
  }
})();
