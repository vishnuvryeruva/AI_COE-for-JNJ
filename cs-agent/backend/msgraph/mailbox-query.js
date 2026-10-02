/** Deliberately bounded English search commands, independent of AI Core. */
class InvalidMailboxQuery extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidMailboxQuery';
  }
}

const EXAMPLES = 'Try "Find sales orders from email", "Find invoices for order 4500123456", or "Find packing lists from customer@example.com in the last 7 days".';
const DAY = 24 * 60 * 60 * 1000;
const GROUPS = [
  { id: 'invoice', label: 'Invoices', prompt: /\binvoices?\b/i, terms: ['invoice', 'billing'], patterns: [/\binvoices?\b/i, /\bbilling\b/i] },
  { id: 'packing', label: 'Packing lists', prompt: /\bpacking\s*(?:lists?|slips?)\b/i, terms: ['packing list', 'packing slip'], patterns: [/\bpacking\s*lists?\b/i, /\bpacking\s*slips?\b/i] },
  { id: 'proof', label: 'Proof of delivery', prompt: /\bproof\s+of\s+delivery\b|\bpod\b/i, terms: ['proof of delivery', 'POD'], patterns: [/\bproof\s+of\s+delivery\b/i, /\bPOD\b/] },
  { id: 'delivery', label: 'Deliveries', prompt: /\bdeliver(?:y|ies)\b/i, terms: ['delivery', 'dispatch'], patterns: [/\bdeliver(?:y|ies)\b/i, /\bdispatch(?:ed)?\b/i] },
  { id: 'tracking', label: 'Shipment tracking', prompt: /\b(?:tracking|shipments?|shipping)\b/i, terms: ['tracking', 'shipment', 'shipping'], patterns: [/\btrack(?:ing)?\b/i, /\bshipments?\b/i, /\bshipping\b/i] },
  { id: 'status', label: 'Order status', prompt: /\border\s+status\b/i, terms: ['order status', 'order update'], patterns: [/\border\s+status\b/i, /\bstatus\s+(?:of\s+|for\s+)?(?:my\s+|the\s+)?order\b/i, /\border\s+update\b/i] },
  { id: 'orders', label: 'Sales orders', prompt: /\b(?:orders?|so|po)\b/i, terms: ['sales order', 'purchase order', 'order', 'SO / PO reference'], patterns: [/\bsales\s*orders?\b/i, /\bpurchase\s*orders?\b/i, /\borders?\b/i, /\b(?:SO|PO)[\s#:-]*\d{3,}\b/i] },
  { id: 'sap', label: 'SAP-related email', prompt: /\bsap\b/i, terms: ['SAP'], patterns: [/\bSAP\b/i] },
];

function extractOrderNumbers(text) {
  const references = [];
  const pattern = /\b(?:(?:sales|purchase|customer)\s+)?(?:orders?|so|po)\s*(?:number\s*|no\.?\s*|[#:]\s*|-\s*)?([a-z]{0,6}[-/]?\d[a-z0-9/-]{0,29})\b/gi;
  for (const match of text.matchAll(pattern)) references.push(match[1]);
  return [...new Set(references.map((ref) => ref.toUpperCase()))];
}

function isoDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new InvalidMailboxQuery('Use a valid date in YYYY-MM-DD format, for example "invoices since 2026-09-01".');
  }
  return date.toISOString();
}

function parseMailboxQuery(prompt, now = new Date()) {
  if (typeof prompt !== 'string' || prompt.trim().length < 3 || prompt.trim().length > 500) {
    throw new InvalidMailboxQuery(`Enter a search request between 3 and 500 characters. ${EXAMPLES}`);
  }
  let remaining = prompt.trim();
  let since = null;
  let before = null;
  let sender = null;
  const startToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let relativeDateUsed = false;
  const setDates = (start, end) => {
    if (relativeDateUsed || since || before) throw new InvalidMailboxQuery('Use one date range: today, yesterday, this week, last 7 days, or since/before YYYY-MM-DD.');
    relativeDateUsed = true;
    since = new Date(start).toISOString();
    before = end == null ? null : new Date(end).toISOString();
  };
  remaining = remaining.replace(/\b(?:in\s+the\s+|in\s+)?(?:last|past)\s+(\d+)\s+days?\b/gi, (_all, days) => {
    const count = Number(days);
    if (count < 1 || count > 365) throw new InvalidMailboxQuery('Choose a date range between 1 and 365 days.');
    setDates(now.getTime() - count * DAY, null);
    return ' ';
  });
  remaining = remaining.replace(/\b(today|yesterday|this\s+week|last\s+week|this\s+month|last\s+month)\b/gi, (all) => {
    const period = all.toLowerCase().replace(/\s+/g, ' ');
    const monday = startToday - ((now.getUTCDay() + 6) % 7) * DAY;
    if (period === 'today') setDates(startToday, startToday + DAY);
    if (period === 'yesterday') setDates(startToday - DAY, startToday);
    if (period === 'this week') setDates(monday, monday + 7 * DAY);
    if (period === 'last week') setDates(monday - 7 * DAY, monday);
    if (period === 'this month') setDates(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    if (period === 'last month') setDates(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1), Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return ' ';
  });
  remaining = remaining.replace(/\b(since|after|before|on)\s+(\d{4}-\d{2}-\d{2})\b/gi, (_all, qualifier, date) => {
    qualifier = qualifier.toLowerCase();
    if (relativeDateUsed) throw new InvalidMailboxQuery('Use one date range: a relative period or since/before YYYY-MM-DD.');
    const value = isoDate(date);
    if (qualifier === 'on') {
      if (since || before) throw new InvalidMailboxQuery('Use a single "on YYYY-MM-DD" date, or a since/before range.');
      since = value;
      before = new Date(Date.parse(value) + DAY).toISOString();
      relativeDateUsed = true;
    } else if (qualifier === 'before') {
      if (before) throw new InvalidMailboxQuery('Use only one before date.');
      before = value;
    } else {
      if (since) throw new InvalidMailboxQuery('Use only one since or after date.');
      since = qualifier === 'after' ? new Date(Date.parse(value) + DAY).toISOString() : value;
    }
    return ' ';
  });
  if (since && before && Date.parse(since) >= Date.parse(before)) {
    throw new InvalidMailboxQuery('The start date must be earlier than the before date.');
  }
  remaining = remaining.replace(/\bfrom\s+([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\b/gi, (_all, address) => {
    if (sender) throw new InvalidMailboxQuery('Search one sender at a time using "from customer@example.com".');
    sender = address.toLowerCase();
    return ' ';
  });

  // Never silently drop a requested time/sender/status restriction.
  if (/\b(?:since|before|after|between|during|until|yesterday|today|last|past|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|unread|read|unprocessed|processed|except|excluding|exclude|without|not|attachments?)\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:in|on)\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i.test(remaining)) {
    throw new InvalidMailboxQuery('That filter is not supported. Use today, yesterday, this week, last 7 days, or since/before YYYY-MM-DD. Searches cover email subjects and bodies, not attachments or read/processing status.');
  }
  const from = remaining.match(/\bfrom\s+(.+)/i);
  if (from && !/^(?:(?:my|the|our)\s+)?(?:(?:outlook|sap)\s+)?(?:e-?mails?|mailbox|inbox|outlook)\b/i.test(from[1])) {
    throw new InvalidMailboxQuery('Specify the sender as an email address, for example "find invoices from customer@example.com".');
  }

  let orderNumbers = extractOrderNumbers(remaining);
  // SAP order references often appear by themselves in a search request.
  orderNumbers = [...new Set([...orderNumbers, ...(remaining.match(/(?<![a-z0-9/-])\d{10}(?![a-z0-9/-])/gi) || [])])];
  if (orderNumbers.length > 1) throw new InvalidMailboxQuery('Search one order reference at a time.');
  const orderNumber = orderNumbers[0] || null;
  let groups = GROUPS.filter((group) => group.prompt.test(remaining));
  if (groups.some((group) => group.id === 'proof')) groups = groups.filter((group) => group.id !== 'delivery');
  if (groups.length > 1) groups = groups.filter((group) => group.id !== 'sap');
  if (groups.length > 1 && !/\b(?:sales|purchase|customer)\s+orders\b/i.test(remaining)) {
    groups = groups.filter((group) => group.id !== 'orders');
  }
  if (orderNumber) groups = groups.filter((group) => group.id !== 'orders');
  if (!groups.length && !orderNumber) throw new InvalidMailboxQuery(EXAMPLES);
  if (/\b(?:cancelled|canceled|overdue|urgent|pending|open|closed|completed|failed|approved|rejected)\b/i.test(remaining)) {
    throw new InvalidMailboxQuery('Order status filters are not available without SAP data. Search for an order number or an email category such as sales orders, invoices, or deliveries.');
  }
  return {
    query: {
      label: groups.length ? groups.map((group) => group.label).join(' / ') : 'Order reference',
      terms: groups.flatMap((group) => group.terms),
      orderNumber, since, before, sender,
    },
    patterns: groups.flatMap((group) => group.patterns),
  };
}

function matchMailboxMessage(message, parsed, text) {
  const { query, patterns } = parsed;
  const received = Date.parse(message.receivedDateTime);
  if ((query.since || query.before) && Number.isNaN(received)) return null;
  if (query.since && received < Date.parse(query.since)) return null;
  if (query.before && received >= Date.parse(query.before)) return null;
  if (query.sender && message.from?.emailAddress?.address?.toLowerCase() !== query.sender) return null;
  if (query.orderNumber) {
    const escaped = query.orderNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text)) return null;
  }
  const hits = [...new Set(patterns.map((pattern) => text.match(pattern)?.[0]).filter(Boolean))];
  // An explicit reference alone is sufficient; categories narrow combined requests.
  if (patterns.length && !hits.length) return null;
  const details = hits.slice(0, 3).map((hit) => `“${hit}”`);
  if (query.orderNumber) details.push(`order reference ${query.orderNumber}`);
  return {
    matchReason: `Keyword match in subject/body: ${details.join(', ')}.`,
    orderNumbers: [...new Set([...extractOrderNumbers(text), ...(query.orderNumber ? [query.orderNumber] : [])])],
  };
}

module.exports = { parseMailboxQuery, matchMailboxMessage, extractOrderNumbers, InvalidMailboxQuery };
