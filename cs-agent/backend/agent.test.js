const { test } = require('node:test');
const assert = require('node:assert/strict');
const aiCore = require('./ai-core');
const agent = require('./agent');

test('fallback separates new sales orders from status requests without inventing SAP details', async (t) => {
  t.mock.method(aiCore, 'isConfigured', () => false);
  const email = { original: { from: 'customer@example.com', subject: 'New purchase order', body: 'Please create sales order SO-120045.' }, extraction: { confidence: 1 } };
  const result = await agent.process(email);
  assert.equal(result.analysis.intent, 'SALES_ORDER_REQUEST');
  assert.equal(result.analysis.orderNumber, 'SO-120045');
  assert.equal(result.status, 'NEEDS_REVIEW');
  assert.equal(result.stub, true);
  assert.match(result.draft.body, /SO-120045/);
  assert.doesNotMatch(result.draft.body, /created|confirmed|shipped|delivered/);
  email.original.subject = 'Order status';
  email.original.body = 'What is the status of order 4500123456?';
  assert.equal((await agent.analyze(email)).intent, 'ORDER_STATUS');
  email.original.body = 'Please send the proof of delivery for order 4500123456.';
  assert.equal((await agent.analyze(email)).intent, 'PROOF_OF_DELIVERY');
});
