const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseUploadedEmail, parseForwardedEmail, MAX_EMAIL_BYTES } = require('./parser');
const { createMsg } = require('./fixtures/msg-fixture');

const eml = (body, subject = 'Order status') => Buffer.from([
  'From: Sample Customer <customer@example.com>',
  'To: cs.team@example.com',
  `Subject: ${subject}`,
  'Date: Wed, 14 Oct 2026 12:30:00 +0000',
  'Content-Type: text/plain; charset=utf-8', '', body,
].join('\r\n'));

test('saved Unicode MSG preserves sender, SMTP recipients, body, date and attachment metadata', async () => {
  const email = await parseUploadedEmail(createMsg({
    senderName: 'Zoë Müller', senderEmail: '/O=EXCHANGE/CN=RECIPIENTS/CN=customer',
    senderSmtpAddress: 'Customer@Example.com',
    body: 'Please check the order — Grüße.',
    recipients: [{ address: '/O=EXCHANGE/CN=RECIPIENTS/CN=cs', smtpAddress: 'CS.Team@Example.com' }, { address: 'manager@example.com', type: 2 }],
    attachments: [{ name: 'order.pdf', mime: 'application/pdf', content: Buffer.from('%PDF-synthetic') }],
  }), { filename: 'order.MSG' });
  assert.equal(email.original.from, 'customer@example.com');
  assert.equal(email.original.fromName, 'Zoë Müller');
  assert.equal(email.original.body, 'Please check the order — Grüße.');
  assert.equal(email.original.sentAt, '2026-10-14T12:30:00.000Z');
  assert.deepEqual(email.original.to, ['cs.team@example.com']);
  assert.deepEqual(email.original.cc, ['manager@example.com']);
  assert.deepEqual(email.original.attachments, [{ name: 'order.pdf', mime: 'application/pdf', size: 14 }]);
  assert.equal(email.mailingGroup, 'cs.team@example.com');
  assert.equal(email.extraction.method, 'MSG_DIRECT');
  assert.equal(email.extraction.confidence, 1);
});

test('HTML-only MSG body is recovered and Exchange-only sender remains unresolved', async () => {
  const email = await parseUploadedEmail(createMsg({
    senderEmail: '/O=EXCHANGE/CN=RECIPIENTS/CN=unknown',
    body: '', html: '<html><body><p>Order <b>4500123456</b></p><p>Résumé requested</p></body></html>',
  }), { filename: 'html.msg' });
  assert.equal(email.original.from, null);
  assert.equal(email.extraction.confidence, 0);
  assert.match(email.original.body, /Order 4500123456\nRésumé requested/);
});

test('transport From header preserves the represented sender', async () => {
  const email = await parseUploadedEmail(createMsg({
    senderEmail: 'delegate@example.com',
    headers: 'From: Shared Customer <shared@example.com>\r\nTo: cs.team@example.com',
  }), { filename: 'shared.msg' });
  assert.equal(email.original.from, 'shared@example.com');
  assert.equal(email.original.fromName, 'Shared Customer');
});

test('native embedded MSG attachment recovers original customer and their attachment', async () => {
  const email = await parseUploadedEmail(createMsg({
    senderEmail: 'csr@example.com', subject: 'FW: Order status', body: 'Please handle this.',
    attachments: [{ name: 'Original email', message: {
      attachments: [{ name: 'order.txt', mime: 'text/plain', content: Buffer.from('order') }],
    } }],
  }), { filename: 'forward.msg' });
  assert.equal(email.forwardedBy, 'csr@example.com');
  assert.equal(email.csrNote, 'Please handle this.');
  assert.equal(email.original.from, 'customer@example.com');
  assert.equal(email.original.attachments[0].name, 'order.txt');
  assert.equal(email.extraction.method, 'MSG_ATTACHMENT');
});

test('EML with attached binary MSG uses binary parser instead of MIME parser', async () => {
  const raw = Buffer.from([
    'From: csr@example.com', 'Subject: FW: Order status',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="sample-boundary"', '',
    '--sample-boundary', 'Content-Type: text/plain', '', 'Please handle.',
    '--sample-boundary', 'Content-Type: application/vnd.ms-outlook',
    'Content-Disposition: attachment; filename="original.msg"', 'Content-Transfer-Encoding: base64', '',
    createMsg().toString('base64'), '--sample-boundary--', '',
  ].join('\r\n'));
  const email = await parseUploadedEmail(raw, { filename: 'forward.eml' });
  assert.equal(email.original.from, 'customer@example.com');
  assert.equal(email.extraction.method, 'MSG_ATTACHMENT');
});

test('MSG with attached RFC822 email preserves original sender', async () => {
  const raw = createMsg({
    senderEmail: 'csr@example.com', subject: 'FW: Order status',
    attachments: [{ name: 'original.eml', mime: 'message/rfc822', content: eml('Original request') }],
  });
  const email = await parseUploadedEmail(raw, { filename: 'forward.msg' });
  assert.equal(email.original.from, 'customer@example.com');
  assert.equal(email.original.body, 'Original request');
  assert.equal(email.extraction.method, 'RFC822_ATTACHMENT');
});

test('plain forwarded MSG recovers customer while an incomplete forward requires review', async () => {
  const email = await parseUploadedEmail(createMsg({ senderEmail: 'csr@example.com', subject: 'FW: Order', body: [
    'Please handle.', '-----Original Message-----', 'From: Customer <customer@example.com>',
    'To: cs.team@example.com', 'Subject: Order status', '', 'Please check my order.',
  ].join('\n') }), { filename: 'forward.msg' });
  assert.equal(email.original.from, 'customer@example.com');
  assert.equal(email.original.body, 'Please check my order.');
  assert.equal(email.extraction.method, 'BODY_PARSE');
  const incomplete = await parseUploadedEmail(createMsg({ senderEmail: 'csr@example.com', subject: 'FW: Order' }), { filename: 'forward.msg' });
  assert.equal(incomplete.original.from, null);
  assert.equal(incomplete.extraction.confidence, 0);
});

test('direct EML import and legacy forwarded-only behavior are both preserved', async () => {
  const raw = eml('Please check my order.');
  const direct = await parseUploadedEmail(raw, { filename: 'order.eml' });
  assert.equal(direct.original.from, 'customer@example.com');
  assert.equal(direct.extraction.method, 'EML_DIRECT');
  assert.equal((await parseForwardedEmail(raw)).original.from, null);
});

test('a saved reply uses its current sender instead of a quoted message sender', async () => {
  const email = await parseUploadedEmail(createMsg({ subject: 'RE: Order status', body:
    'Any update?\nFrom: CSR <csr@example.com>\nTo: customer@example.com\nSubject: Order status\nWe will check.',
  }), { filename: 'reply.msg' });
  assert.equal(email.original.from, 'customer@example.com');
  assert.equal(email.extraction.method, 'MSG_DIRECT');
  assert.match(email.original.body, /^Any update\?/);
});

test('invalid, empty, mislabeled, unsupported and oversized uploads produce actionable client errors', async () => {
  for (const [raw, filename] of [[Buffer.alloc(0), 'empty.msg'], [Buffer.from('not email'), 'bad.eml'],
    [eml('Test'), 'fake.msg'], [eml('Test'), 'mail.pdf'], [Buffer.from('d0cf11e0a1b11ae1', 'hex'), 'broken.msg']]) {
    await assert.rejects(parseUploadedEmail(raw, { filename }), (error) => error.status === 400 && error.message.length > 20);
  }
  await assert.rejects(parseUploadedEmail(Buffer.alloc(MAX_EMAIL_BYTES + 1), { filename: 'large.msg' }), { status: 413 });
  await assert.rejects(parseUploadedEmail(createMsg({ messageClass: 'IPM.Appointment' }), { filename: 'appointment.msg' }), /not an email message/);
});

test('cyclic binary directory is terminated without hanging the server', { timeout: 8000 }, async () => {
  const raw = createMsg();
  const directoryOffset = (raw.readUInt32LE(48) + 1) * 512;
  const firstChild = raw.readUInt32LE(directoryOffset + 76);
  raw.writeUInt32LE(firstChild, directoryOffset + firstChild * 128 + 72);
  await assert.rejects(parseUploadedEmail(raw, { filename: 'cyclic.msg' }), (error) => error.status === 400);
});
