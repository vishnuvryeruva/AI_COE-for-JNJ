// Synthetic Outlook MSG fixtures. Contains no customer or corporate email data.
// Only the dependency's CFB writer is used here; tests exercise its real reader.
const { burn } = require('@kenjiuno/msgreader/lib/Burner');

function createMsg(options = {}) {
  const entries = [{ name: 'Root Entry', type: 5, length: 0, children: [] }];
  const folder = (parent, name) => {
    const index = entries.length;
    entries.push({ name, type: 1, length: 0, children: [] });
    entries[parent].children.push(index);
    return index;
  };
  const stream = (parent, name, content) => {
    entries[parent].children.push(entries.length);
    entries.push({ name, type: 2, length: content.length, binaryProvider: () => Uint8Array.from(content) });
  };
  const unicode = (parent, tag, text) => {
    if (text !== undefined) stream(parent, `__substg1.0_${tag}001F`, Buffer.from(`${text}\0`, 'utf16le'));
  };
  const integer = (parent, tag, value) => {
    const content = Buffer.alloc(4);
    content.writeUInt32LE(value);
    stream(parent, `__substg1.0_${tag}0003`, content);
  };
  function message(parent, values) {
    unicode(parent, '001A', values.messageClass || 'IPM.Note');
    unicode(parent, '0037', values.subject ?? 'Order status 4500123456');
    unicode(parent, '0C1A', values.senderName ?? 'Sample Customer');
    unicode(parent, '0C1F', values.senderEmail ?? 'customer@example.com');
    unicode(parent, '5D01', values.senderSmtpAddress);
    unicode(parent, '5D02', values.sentRepresentingSmtpAddress);
    unicode(parent, '1000', values.body ?? 'Please check order 4500123456.');
    unicode(parent, '007D', values.headers);
    if (values.html) stream(parent, '__substg1.0_10130102', Buffer.from(values.html));
    const sent = Buffer.alloc(8);
    sent.writeBigUInt64LE((BigInt(Date.parse('2026-10-14T12:30:00Z')) + 11644473600000n) * 10000n);
    stream(parent, '__substg1.0_00390040', sent);
    for (const [index, recipient] of (values.recipients || [{ address: 'cs.team@example.com', type: 1 }]).entries()) {
      const child = folder(parent, `__recip_version1.0_#${index.toString(16).padStart(8, '0')}`);
      unicode(child, '3001', recipient.name || recipient.address);
      unicode(child, '3003', recipient.address);
      unicode(child, '39FE', recipient.smtpAddress);
      integer(child, '0C15', recipient.type || 1);
    }
    for (const [index, attachment] of (values.attachments || []).entries()) {
      const child = folder(parent, `__attach_version1.0_#${index.toString(16).padStart(8, '0')}`);
      unicode(child, '3707', attachment.name);
      unicode(child, '3001', attachment.name);
      unicode(child, '370E', attachment.mime);
      if (attachment.message) {
        message(folder(child, '__substg1.0_3701000D'), attachment.message);
      } else {
        stream(child, '__substg1.0_37010102', attachment.content || Buffer.from('sample attachment'));
      }
    }
  }
  message(0, options);
  return Buffer.from(burn(entries));
}

module.exports = { createMsg };
