/**
 * Demo scenarios as real MIME, so "Load scenario emails" exercises the actual
 * parser rather than a mock. All data is synthetic.
 *
 * These deliberately cover the failure paths too — a demo where everything
 * parses at 100% hides the exact risk this POC exists to prove.
 */

const scenarios = [
  {
    name: 'forward-as-attachment.eml',
    note: 'Best case: Ctrl+Alt+F. Original arrives with intact headers → confidence 1.0.',
    eml: [
      'From: Jane Doe <jane.doe@its.jnj.com>',
      'To: cs-agent@medtech-ai.jnj.com',
      'Subject: FW: Please send Packing List',
      'Date: Thu, 21 May 2026 09:41:00 +0200',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B1"',
      '',
      '--B1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Customer is chasing this one - can you pick it up?',
      '',
      '--B1',
      'Content-Type: message/rfc822',
      'Content-Disposition: attachment; filename="original.eml"',
      '',
      'From: John Smith <john.smith@acmecorp.com>',
      'To: edc.customerservice@its.jnj.com',
      'Subject: Please send Packing List',
      'Date: Thu, 21 May 2026 09:35:00 +0200',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hello,',
      '',
      'Can you please send packing list for order 5003000237.',
      '',
      'Thank you,',
      'John Smith',
      '',
      '--B1--',
      '',
    ].join('\r\n'),
  },

  {
    name: 'plain-forward-english.eml',
    note: 'Plain forward. Sender recovered by body parsing → flagged for review.',
    eml: [
      'From: Jane Doe <jane.doe@its.jnj.com>',
      'To: cs-agent@medtech-ai.jnj.com',
      'Subject: FW: Order quantities',
      'Date: Tue, 19 May 2026 10:03:00 +0200',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '-----Original Message-----',
      'From: Maria Rossi <maria.rossi@medsupply.example>',
      'Sent: Tuesday, May 19, 2026 9:52 AM',
      'To: edc.customerservice@its.jnj.com',
      'Subject: Order quantities',
      '',
      'what items and which quantities are in my sales order 5030000237? Send me the packing list too.',
      '',
      'Regards,',
      'Maria Rossi',
      '',
    ].join('\r\n'),
  },

  {
    name: 'plain-forward-german.eml',
    note: 'German Outlook: Von/Gesendet/An/Betreff. Proves the localized labels work.',
    eml: [
      'From: Stefan Braun <stefan.braun@its.jnj.com>',
      'To: cs-agent@medtech-ai.jnj.com',
      'Subject: WG: Rechnung fuer Auftrag 5003000412',
      'Date: Mon, 18 May 2026 15:10:00 +0200',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '________________________________',
      'Von: Klaus Weber <klaus.weber@medtechpartner.example>',
      'Gesendet: Montag, 18. Mai 2026 14:22',
      'An: edc.customerservice@its.jnj.com',
      'Betreff: Rechnung fuer Auftrag 5003000412',
      '',
      'Guten Tag,',
      '',
      'bitte senden Sie mir die Rechnung fuer den Auftrag 5003000412.',
      '',
      'Mit freundlichen Gruessen',
      'Klaus Weber',
      '',
    ].join('\r\n'),
  },

  {
    name: 'unparseable-forward.eml',
    note: 'CSR pasted the text without headers. No sender → NEEDS_REVIEW, not a crash.',
    eml: [
      'From: Jane Doe <jane.doe@its.jnj.com>',
      'To: cs-agent@medtech-ai.jnj.com',
      'Subject: FW: where is my shipment',
      'Date: Wed, 20 May 2026 11:15:00 +0200',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Can you look at this one please - customer wants to know where delivery 80012345 is.',
      '',
    ].join('\r\n'),
  },
];

module.exports = { scenarios };
