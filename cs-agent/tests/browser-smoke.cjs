#!/usr/bin/env node
/*
 * Outlook UI smoke tests. Every API call is intercepted; this cannot read an
 * actual mailbox, call SAP, or send an email. Requires Playwright and Chrome:
 * PLAYWRIGHT_PATH=/path/to/playwright CHROME_PATH=/path/to/chrome npm run smoke
 * Set SMOKE_BASE_URL to reuse a Vite server; otherwise starts one on port 5174.
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const project = path.resolve(__dirname, '..');
const baseURL = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5174';
const screenshotDirectory = process.env.SMOKE_SCREENSHOT_DIR || '/tmp';
const messageFixtures = [
  { id: 'mail-new', subject: 'SAP sales order 4500012345', from: 'customer@example.com', fromName: 'Customer services', orderNumbers: ['4500012345'] },
  { id: 'mail-existing', subject: 'Sales order 4500012346 follow-up', from: 'buyer@example.com', fromName: 'Purchasing', orderNumbers: ['4500012346'] },
  { id: 'mail-failure', subject: 'SAP sales order 4500012347 delivery', from: 'orders@example.com', fromName: 'Order management', orderNumbers: ['4500012347'] },
].map((message) => ({
  ...message,
  internetMessageId: `<${message.id}@example.com>`,
  receivedAt: '2026-09-30T12:00:00Z',
  preview: `Please confirm the status of SAP sales order ${message.orderNumbers[0]}.`,
  hasAttachments: true,
  matchReason: 'Sales order reference in subject and message body',
}));

function requestFixture(message) {
  return {
    id: `request-${message.id}`,
    status: 'READY', statusReason: null, source: 'OUTLOOK',
    receivedAt: message.receivedAt, forwardedBy: null, csrNote: null, mailingGroup: null,
    email: {
      from: message.from, fromName: message.fromName, to: ['support@example.com'], cc: [],
      subject: message.subject, body: message.preview, sentAt: message.receivedAt,
      attachments: [{ name: 'order.pdf', mime: 'application/pdf', size: 100 }],
    },
    extraction: { method: 'BODY_PARSE', confidence: 1, warnings: [] },
    analysis: {
      intent: 'ORDER_STATUS', intentLabel: 'Order status', confidence: 0.98,
      reasoning: 'Customer asks about an SAP sales order.', orderNumber: message.orderNumbers[0],
      deliveryNumber: null, language: 'English', requesterType: 'Customer',
    },
    draft: { to: message.from, cc: [], subject: `Re: ${message.subject}`, body: 'We are reviewing your sales order request.' },
    audit: [],
  };
}

async function expectVisible(locator) { await locator.waitFor({ state: 'visible' }); }
async function expectText(locator, expression) {
  await locator.filter({ hasText: expression }).first().waitFor({ state: 'visible' });
}
async function checkNoOverflow(page, name) {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  if (dimensions.document > dimensions.viewport + 1) {
    const overflowing = await page.evaluate(() => Array.from(document.querySelectorAll('body *'))
      .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 8)
      .map((element) => ({ tag: element.tagName, class: element.className, width: Math.round(element.getBoundingClientRect().width) })));
    assert.fail(`${name}: horizontal overflow ${JSON.stringify({ ...dimensions, overflowing })}`);
  }
}

async function startServer() {
  if (process.env.SMOKE_BASE_URL) return null;
  const child = spawn(process.execPath, [path.join(project, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5174', '--strictPort'], {
    cwd: project, env: { ...process.env, VITE_API_URL: '/api/v1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Vite exited: ${output}`);
      try {
        if ((await fetch(baseURL)).ok) return child;
      } catch { /* Vite is starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Vite did not start: ${output}`);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}

async function scenario(browser, auth, run, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const state = { auth: { required: true, guest: false, guestEnabled: false, ...auth }, requests: options.requests || [], apiCalls: [], unexpected: [], errors: [], ingested: [], prompts: [], uploads: [], failThird: true, failUpload: null, authFailure: false, releaseSearch: null, releaseAuth: null, guestStartError: null, expireRequests: false, demoApprovals: 0 };
  page.on('pageerror', (error) => state.errors.push(error.message));
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/api/v1/')) {
      if (url.origin === new URL(baseURL).origin) return route.continue();
      state.unexpected.push(`External network request: ${req.url()}`);
      return route.abort();
    }
    const endpoint = url.pathname.slice('/api/v1'.length);
    const call = `${req.method()} ${endpoint}`;
    state.apiCalls.push(call);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (call === 'GET /health') return json({ status: 'ok', aiCore: 'configured' });
    if (call === 'GET /auth/status') {
      if (options.delayAuth) await new Promise((resolve) => { state.releaseAuth = resolve; });
      if (state.authFailure) return json({ error: 'Unavailable' }, 503);
      return json(state.auth);
    }
    if (call === 'POST /auth/logout') {
      if (state.auth.guest) state.requests = [];
      state.auth.signedIn = false; state.auth.guest = false; state.auth.username = null;
      return json({ ok: true });
    }
    if (call === 'POST /auth/guest') {
      if (state.guestStartError) return json({ error: 'Guest demo is unavailable.', code: state.guestStartError }, state.guestStartError === 'GUEST_DEMO_DISABLED' ? 403 : 503);
      assert.equal(state.auth.guestEnabled, true);
      state.auth.guest = true; state.auth.signedIn = false; state.auth.username = null;
      state.requests = [];
      return json({ ok: true, guest: true });
    }
    if (call === 'GET /requests') {
      if (state.expireRequests) return json({ error: 'Sign in required', code: 'AUTH_SIGN_IN_REQUIRED' }, 401);
      return json(state.requests.filter((item) => !url.searchParams.has('status') || item.status === url.searchParams.get('status')));
    }
    if (call === 'GET /stats') return json(Object.fromEntries(['READY', 'NEEDS_REVIEW', 'FAILED', 'SENT', 'APPROVED', 'REJECTED'].map((status) => [status, state.requests.filter((item) => item.status === status).length]).concat([['TOTAL', state.requests.length]])));
    if (call === 'POST /requests/scenarios' && options.guestWorkflow) {
      assert.equal(state.auth.guest, true);
      const created = messageFixtures.map((message) => ({ ...requestFixture(message), source: 'SCENARIO' }));
      state.requests.push(...created);
      return json({ created: created.length, requests: created });
    }
    if (call === 'POST /requests/manual' && options.guestWorkflow) {
      assert.equal(state.auth.guest, true);
      const payload = req.postDataJSON();
      const created = requestFixture({ ...messageFixtures[0], id: 'guest-manual', from: payload.from, subject: payload.subject, preview: payload.body });
      state.requests.push(created);
      return json({ request: created });
    }
    const draftMatch = endpoint.match(/^\/requests\/([^/]+)\/draft$/);
    if (req.method() === 'PATCH' && draftMatch && options.guestWorkflow) {
      assert.equal(state.auth.guest, true);
      const draft = state.requests.find((item) => item.id === draftMatch[1]);
      Object.assign(draft.draft, req.postDataJSON());
      return json(draft);
    }
    const approveMatch = endpoint.match(/^\/requests\/([^/]+)\/approve$/);
    if (req.method() === 'POST' && approveMatch && options.guestWorkflow) {
      assert.equal(state.auth.guest, true);
      const draft = state.requests.find((item) => item.id === approveMatch[1]);
      draft.status = 'APPROVED';
      draft.statusReason = 'Approved in guest demo. No email was sent.';
      state.demoApprovals += 1;
      return json({ ...draft, sent: false });
    }
    if (call === 'POST /requests/upload' && options.allowUploads) {
      const name = req.postDataBuffer().toString('utf8').match(/filename="([^"]+)"/)?.[1];
      state.uploads.push(name);
      if (state.failUpload === 'gateway') return route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad Gateway</body></html>' });
      if (state.failUpload === 'network') return route.abort('failed');
      const imported = { ...requestFixture(messageFixtures[0]), id: `upload-${state.uploads.length}`, source: 'UPLOAD' };
      state.requests.push(imported);
      return json({ request: imported, deduped: false });
    }
    if (call === 'POST /mailbox/search') {
      const body = req.postDataJSON();
      assert.equal(typeof body.prompt, 'string');
      state.prompts.push(body.prompt);
      if (/expired session/i.test(body.prompt)) {
        // Simulate a persisted auth session whose Microsoft token has expired.
        // /auth/status deliberately remains signed in after the Graph failure.
        return json({ error: 'Your Outlook session expired. Reconnect your mailbox.', code: 'OUTLOOK_AUTH_REQUIRED' }, 401);
      }
      if (/slow search/i.test(body.prompt)) {
        await new Promise((resolve) => { state.releaseSearch = resolve; });
      }
      return json({
        query: { label: 'SAP sales orders', terms: ['sales order'], orderNumber: null, since: null, before: null, sender: null },
        messages: /zero matches/i.test(body.prompt) ? [] : messageFixtures,
        scanned: 25, limited: true, scope: 'inbox',
      });
    }
    const ingestMatch = endpoint.match(/^\/mailbox\/messages\/([^/]+)\/ingest$/);
    if (req.method() === 'POST' && ingestMatch) {
      const message = messageFixtures.find((item) => item.id === ingestMatch[1]);
      assert.ok(message, `Known message: ${ingestMatch[1]}`);
      state.ingested.push(message.id);
      if (message.id === 'mail-failure' && state.failThird) return json({ error: 'Temporary mailbox processing failure' }, 502);
      const draft = requestFixture(message);
      if (!state.requests.some((item) => item.id === draft.id)) state.requests.push(draft);
      return json({ request: draft, deduped: message.id === 'mail-existing' });
    }
    const detailMatch = endpoint.match(/^\/requests\/([^/]+)$/);
    if (req.method() === 'GET' && detailMatch) {
      const draft = state.requests.find((item) => item.id === detailMatch[1]);
      assert.ok(draft, `Known request: ${detailMatch[1]}`);
      return json(draft);
    }
    state.unexpected.push(call);
    return json({ error: `Unexpected API call blocked by browser smoke: ${call}` }, 500);
  });
  try {
    await page.goto(`${baseURL}${options.query || ''}`);
    await run(page, state);
    assert.deepEqual(state.unexpected, [], 'Only expected local resources and intercepted APIs were requested');
    assert.deepEqual(state.errors, [], 'No browser runtime errors');
    if (options.guestWorkflow) {
      assert.ok(!state.apiCalls.some((call) => /mailbox|send/.test(call)), 'Guest demo never accesses live mailbox routes');
    } else {
      assert.ok(!state.apiCalls.some((call) => /approve|send|regenerate|manual/.test(call)), 'These checks never send email or modify drafts');
    }
    if (!options.allowUploads) assert.equal(state.uploads.length, 0);
  } catch (error) {
    await page.screenshot({ path: path.join(screenshotDirectory, 'cs-agent-ui-failure.png'), fullPage: true }).catch(() => {});
    if (state.errors.length || state.unexpected.length) console.error({ pageErrors: state.errors, blockedRequests: state.unexpected });
    throw error;
  } finally {
    if (state.releaseSearch) state.releaseSearch();
    if (state.releaseAuth) state.releaseAuth();
    await context.close();
  }
}

async function main() {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    });

    await scenario(browser, { required: false, configured: false, signedIn: false, username: null }, async (page, state) => {
      await expectVisible(page.getByText('Outlook setup required', { exact: true }));
      assert.equal(await page.getByRole('link', { name: 'Connect Outlook', exact: true }).count(), 0);
      assert.equal(state.prompts.length, 0);
      await checkNoOverflow(page, 'Unconfigured desktop');
      await page.screenshot({ path: path.join(screenshotDirectory, 'cs-agent-ui-setup.png'), fullPage: true });
    });
    console.log('PASS: Outlook setup is visible when unconfigured.');

    await scenario(browser, { configured: true, signedIn: false, username: null }, async (page, state) => {
      const connect = page.getByRole('link', { name: 'Sign in with J&J account', exact: true });
      await expectVisible(connect);
      assert.equal(await connect.getAttribute('href'), '/api/v1/auth/login');
      assert.ok(!state.apiCalls.some((call) => /requests|stats|mailbox/.test(call)), 'Signed-out users never request work queue or mailbox data');
      assert.equal(await page.getByText('Your work queue', { exact: true }).count(), 0);
      assert.equal(await page.locator('input[type="file"]').count(), 0);
      await checkNoOverflow(page, 'Signed-out desktop');
      await page.setViewportSize({ width: 390, height: 844 });
      await checkNoOverflow(page, 'Signed-out mobile');
    });
    console.log('PASS: J&J Microsoft sign-in gates workspace data and uploads.');

    await scenario(browser, { configured: false, signedIn: false, username: null }, async (page, state) => {
      await expectVisible(page.getByRole('heading', { name: 'J&J sign-in setup required', exact: true }));
      assert.equal(await page.getByRole('link', { name: 'Sign in with J&J account', exact: true }).count(), 0);
      assert.ok(!state.apiCalls.some((call) => /requests|stats|mailbox/.test(call)), 'Missing required tenant setup fails closed');
    });
    console.log('PASS: Required but missing J&J configuration keeps workspace locked.');

    await scenario(browser, { configured: true, signedIn: true, username: 'csr@example.com' }, async (page, state) => {
      await expectText(page.getByRole('status'), 'Checking your sign-in');
      assert.ok(!state.apiCalls.some((call) => /requests|stats|mailbox/.test(call)), 'Pending sign-in verification never requests workspace data');
      for (let attempt = 0; !state.releaseAuth && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      state.authFailure = true;
      state.releaseAuth();
      state.releaseAuth = null;
      await expectVisible(page.getByRole('heading', { name: 'Sign-in check unavailable', exact: true }));
      assert.ok(!state.apiCalls.some((call) => /requests|stats|mailbox/.test(call)), 'Failed sign-in verification never requests workspace data');
    }, { delayAuth: true });
    console.log('PASS: Pending and unavailable sign-in checks fail closed.');

    await scenario(browser, { configured: true, signedIn: false, username: null }, async (page) => {
      await expectText(page.getByRole('alert'), /administrator needs to approve/);
      assert.equal(new URL(page.url()).searchParams.has('authError'), false, 'Callback status is removed from the URL');
    }, { query: '/?authError=AUTH_CONSENT_REQUIRED' });
    await scenario(browser, { configured: true, signedIn: false, username: null }, async (page) => {
      await expectText(page.getByRole('alert'), 'Microsoft sign-in could not be completed. Please try again.');
      assert.equal((await page.locator('body').innerText()).includes('secret-token'), false, 'Unknown callback error text is never echoed');
    }, { query: '/?authError=secret-token' });
    await scenario(browser, { configured: true, signedIn: false, username: null }, async (page) => {
      await expectText(page.getByRole('alert'), 'Microsoft sign-in could not be completed. Please try again.');
    }, { query: '/?authError=__proto__' });
    console.log('PASS: Callback errors show safe actionable copy, without reflecting provider details.');

    await scenario(browser, { configured: true, signedIn: true, username: 'csr@example.com' }, async (page, state) => {
      const prompt = page.getByRole('textbox', { name: 'Describe the emails to find' });
      const search = page.getByRole('button', { name: 'Find emails', exact: true });
      await expectVisible(prompt);
      await prompt.fill('Find SAP sales orders from email with zero matches');
      await search.click();
      await expectText(page.locator('body'), /no (matching|emails|results)/i);
      assert.equal(state.ingested.length, 0, 'A search only finds messages');

      const naturalPrompt = 'Find SAP sales orders from email received this week';
      await prompt.fill(naturalPrompt);
      await search.click();
      await expectVisible(page.getByRole('heading', { name: /^Matching emails/ }));
      const first = page.getByRole('article', { name: messageFixtures[0].subject, exact: true });
      const second = page.getByRole('article', { name: messageFixtures[1].subject, exact: true });
      const third = page.getByRole('article', { name: messageFixtures[2].subject, exact: true });
      await expectVisible(first);
      assert.equal(state.prompts.at(-1), naturalPrompt, 'The natural-language command reaches the server unchanged');
      assert.equal(state.ingested.length, 0, 'Displaying matches does not prepare or send without user action');

      await first.getByRole('button', { name: 'Prepare draft', exact: true }).click();
      await expectVisible(first.getByRole('button', { name: 'Review draft', exact: true }));
      assert.deepEqual(state.ingested, ['mail-new']);
      await page.getByRole('button', { name: 'Prepare all drafts', exact: true }).click();
      await expectText(second, 'Already in review');
      await expectText(third.getByRole('alert'), 'Temporary mailbox processing failure');
      assert.deepEqual(state.ingested, ['mail-new', 'mail-existing', 'mail-failure'], 'Batch preparation skips successful requests and continues through a partial failure');
      await expectVisible(first.getByRole('button', { name: 'Review draft', exact: true }));
      await expectVisible(second.getByRole('button', { name: 'Review draft', exact: true }));

      await page.screenshot({ path: path.join(screenshotDirectory, 'cs-agent-ui-partial-failure.png'), fullPage: true });

      state.failThird = false;
      await third.getByRole('button', { name: 'Retry draft', exact: true }).click();
      await expectVisible(third.getByRole('button', { name: 'Review draft', exact: true }));
      assert.equal(state.ingested.filter((id) => id === 'mail-new').length, 1, 'Retry preserves prepared drafts');
      await checkNoOverflow(page, 'Search results desktop');
      await page.screenshot({ path: path.join(screenshotDirectory, 'cs-agent-ui-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await checkNoOverflow(page, 'Search results mobile');
      await page.screenshot({ path: path.join(screenshotDirectory, 'cs-agent-ui-mobile.png'), fullPage: true });
      await first.getByRole('button', { name: 'Review draft', exact: true }).click();
      await expectVisible(page.getByRole('heading', { name: /Draft response/ }));
      await expectVisible(page.getByRole('button', { name: 'Approve & send via Outlook', exact: true }));
      await checkNoOverflow(page, 'Review mobile');
      await page.getByRole('button', { name: /Back to queue/ }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expectVisible(page.getByRole('link', { name: 'Sign in with J&J account', exact: true }));
      assert.equal(await page.getByRole('article').count(), 0, 'Logout removes mailbox results');
      assert.equal(await page.getByText('Your work queue', { exact: true }).count(), 0, 'Logout removes work queue data');
      assert.equal((await page.locator('body').innerText()).includes(messageFixtures[0].subject), false, 'Logout removes customer email content');
    });
    console.log('PASS: Natural-language search, empty/matching results, individual/bulk preparation, deduplication, partial failure and retry, draft review, sign-out, and mobile layout.');

    await scenario(browser, { configured: true, signedIn: true, username: 'csr@example.com' }, async (page, state) => {
      const prompt = page.getByRole('textbox', { name: 'Describe the emails to find' });
      const search = page.getByRole('button', { name: 'Find emails', exact: true });
      await expectVisible(prompt);
      await prompt.fill('Find sales orders from email — slow search');
      await search.click();
      const busy = page.getByRole('button', { name: 'Finding emails…', exact: true });
      await expectVisible(busy);
      assert.equal(await busy.isDisabled(), true);
      assert.equal(await prompt.isDisabled(), true, 'The active search prompt cannot change before its response');
      assert.equal(await page.getByRole('button', { name: 'Invoices', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Sign out', exact: true }).isDisabled(), true);
      await expectText(page.getByRole('status'), 'Searching your Outlook inbox');
      // Wait for the intercepted request itself, not just React's busy state.
      for (let attempt = 0; !state.releaseSearch && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(state.releaseSearch, 'The deferred search reached the server');
      state.releaseSearch();
      state.releaseSearch = null;
      await expectVisible(page.getByRole('article', { name: messageFixtures[0].subject, exact: true }));
      await prompt.fill('Find invoices from email');
      assert.equal(await page.getByRole('article').count(), 0, 'Editing the command clears previous search results');
      assert.equal(state.prompts.length, 1, 'Editing the command alone does not issue another search');
      await prompt.fill('');
      assert.equal(await search.isDisabled(), true, 'An empty command cannot search the inbox');
      await prompt.fill('Find sales orders with an expired session');
      await search.click();
      await expectVisible(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true }));
      await expectVisible(page.getByRole('link', { name: 'Sign in with J&J account', exact: true }));
      await expectText(page.getByRole('alert'), /session has expired/);
      assert.equal(await search.count(), 0, 'An expired token cannot keep searching even if auth status is stale');
      assert.equal(await page.getByText('Your work queue', { exact: true }).count(), 0, 'Session expiry removes the work queue');
      assert.equal((await page.locator('body').innerText()).includes(messageFixtures[0].subject), false, 'Session expiry removes customer email content');
      assert.equal(state.auth.signedIn, true, 'Stale signed-in status cannot reopen a session after a 401');
    }, { requests: [requestFixture(messageFixtures[0])] });
    console.log('PASS: Deferred-search busy controls, prompt-change invalidation, blank command validation, and expired-session reconnection.');

    await scenario(browser, { configured: true, signedIn: true, username: 'csr@example.com' }, async (page, state) => {
      await page.getByText('Import an email manually', { exact: true }).click();
      const input = page.locator('input[type="file"]');
      assert.match(await input.getAttribute('accept'), /\.msg/);
      assert.match(await input.getAttribute('accept'), /\.eml/);
      await input.setInputFiles({ name: 'unsupported.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not an email') });
      await expectText(page.getByRole('alert'), 'Choose a saved Outlook .msg or .eml email');
      assert.equal(state.uploads.length, 0, 'Unsupported extensions never reach the server');
      await page.getByRole('button', { name: 'dismiss', exact: true }).click();

      state.failUpload = 'gateway';
      const savedMsg = { name: 'customer.MSG', mimeType: 'application/vnd.ms-outlook', buffer: Buffer.from('smoke fixture: upload transport only') };
      await input.setInputFiles(savedMsg);
      await expectText(page.getByRole('alert'), /email service is unavailable \(HTTP 502\)/);
      assert.deepEqual(state.uploads, ['customer.MSG'], 'Outlook .msg files are accepted, including uppercase extension');
      assert.equal((await page.locator('body').innerText()).includes('<html>'), false, 'Gateway HTML is not rendered as an error');
      await page.getByRole('button', { name: 'dismiss', exact: true }).click();

      state.failUpload = 'network';
      await input.setInputFiles(savedMsg);
      await expectText(page.getByRole('alert'), 'Could not reach the email service. Check your connection and try again.');
      await page.getByRole('button', { name: 'dismiss', exact: true }).click();
      state.failUpload = null;
      await input.setInputFiles(savedMsg);
      await expectText(page.getByRole('status'), '1 email imported');
      assert.deepEqual(state.uploads, ['customer.MSG', 'customer.MSG', 'customer.MSG'], 'The same selected file can be retried after an upload failure');
      await input.setInputFiles({ name: 'customer.eml', mimeType: 'message/rfc822', buffer: Buffer.from('Subject: Test\r\n\r\nTest email') });
      for (let attempt = 0; state.uploads.length < 4 && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(state.uploads.at(-1), 'customer.eml', 'Existing .eml import remains available');
    }, { allowUploads: true });
    console.log('PASS: .msg/.eml upload, extension validation, helpful HTTP 502 and network errors, and same-file retry.');

    await scenario(browser, { required: false, configured: true, signedIn: true, username: 'csr@example.com' }, async (page) => {
      await page.getByText('Import an email manually', { exact: true }).click();
      await page.getByText('Or enter an email manually', { exact: true }).click();
      await page.getByRole('textbox', { name: 'From', exact: true }).fill('private-customer@example.com');
      await page.getByRole('textbox', { name: 'Body', exact: true }).fill('Customer email content entered before logout.');
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expectVisible(page.getByRole('link', { name: 'Connect Outlook', exact: true }));
      await page.getByText('Import an email manually', { exact: true }).click();
      await page.getByText('Or enter an email manually', { exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: 'From', exact: true }).inputValue(), '');
      assert.equal(await page.getByRole('textbox', { name: 'Body', exact: true }).inputValue(), '', 'Logout clears local customer email input even in optional-auth development mode');
    });
    console.log('PASS: Optional-auth development logout also clears unsaved customer email inputs.');

    await scenario(browser, { configured: false, signedIn: false, guestEnabled: true, username: null }, async (page, state) => {
      await expectVisible(page.getByRole('heading', { name: 'Explore Email Operations', exact: true }));
      const enter = page.getByRole('button', { name: 'Continue as guest', exact: true });
      await expectVisible(enter);
      assert.ok(!state.apiCalls.some((call) => /requests|stats|mailbox/.test(call)), 'Guest session is required before demo data loads');
      await page.screenshot({ path: path.join(screenshotDirectory, 'cs-agent-ui-guest-entry.png'), fullPage: true });
      await enter.click();
      await expectVisible(page.getByRole('button', { name: 'Exit demo', exact: true }));
      await expectVisible(page.getByRole('button', { name: 'Load demo emails', exact: true }));
      await expectText(page.locator('.guest-notice'), 'Guest demo: Outlook is not connected; replies are not sent.');
      assert.equal(await page.getByRole('button', { name: 'Find emails', exact: true }).count(), 0);
      await expectVisible(page.getByRole('button', { name: 'Upload Outlook .msg or .eml emails', exact: true }));
      await page.getByRole('button', { name: 'Load demo emails', exact: true }).click();
      const first = page.getByRole('row').filter({ hasText: messageFixtures[0].subject });
      await expectVisible(first);
      await checkNoOverflow(page, 'Guest demo desktop');
      await page.screenshot({ path: path.join(screenshotDirectory, 'cs-agent-ui-guest-demo.png'), fullPage: true });
      await first.getByRole('button', { name: 'Review →', exact: true }).click();
      await expectVisible(page.getByRole('button', { name: 'Approve demo', exact: true }));
      await expectVisible(page.getByRole('button', { name: 'Exit demo', exact: true }));
      assert.equal(await page.getByRole('button', { name: 'Approve & send via Outlook', exact: true }).count(), 0);
      await page.getByRole('textbox', { name: 'Body', exact: true }).fill('Demo reply reviewed by the presenter.');
      await page.getByRole('button', { name: 'Approve demo', exact: true }).click();
      await expectText(first, 'Approved (demo)');
      assert.equal(state.demoApprovals, 1);
      assert.equal(state.requests[0].draft.body, 'Demo reply reviewed by the presenter.', 'Edited demo draft is saved before approval');
      assert.equal(state.requests[0].status, 'APPROVED', 'Demo approval never becomes SENT');
      await first.getByRole('button', { name: 'Review →', exact: true }).click();
      await expectText(page.locator('.chip').filter({ hasText: 'Approved (demo)' }), 'Approved (demo)');
      assert.equal(await page.getByRole('button', { name: 'Approve demo', exact: true }).count(), 0, 'Approved demos are settled and cannot be approved again');
      await page.getByRole('button', { name: /Back to queue/ }).click();

      const input = page.locator('input[type="file"]');
      await input.setInputFiles({ name: 'guest-order.msg', mimeType: 'application/vnd.ms-outlook', buffer: Buffer.from('smoke fixture: .msg transport only') });
      await expectText(page.getByRole('status'), '1 email imported');
      assert.deepEqual(state.uploads, ['guest-order.msg']);
      await page.getByText('Or enter an email manually', { exact: true }).click();
      await page.getByRole('textbox', { name: 'From', exact: true }).fill('demo@example.com');
      await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Guest manual email');
      await page.getByRole('textbox', { name: 'Body', exact: true }).fill('Please provide a packing list for order 4500012345.');
      await page.getByRole('button', { name: 'Process email', exact: true }).click();
      await expectVisible(page.getByRole('row').filter({ hasText: 'Guest manual email' }));
      await page.setViewportSize({ width: 390, height: 844 });
      await checkNoOverflow(page, 'Guest demo mobile');
      await page.getByRole('row').filter({ hasText: 'Guest manual email' }).getByRole('button', { name: 'Review →', exact: true }).click();
      await expectVisible(page.getByRole('heading', { name: /Draft response/ }));
      await checkNoOverflow(page, 'Guest detail mobile');
      await page.getByRole('button', { name: 'Exit demo', exact: true }).click();
      await expectVisible(page.getByRole('button', { name: 'Continue as guest', exact: true }));
      assert.equal(await page.getByRole('heading', { name: /Draft response/ }).count(), 0, 'Exit demo unmounts the open request');
      assert.equal((await page.locator('body').innerText()).includes('Guest manual email'), false, 'Exit demo clears imported email content');
      await page.getByRole('button', { name: 'Continue as guest', exact: true }).click();
      await expectVisible(page.getByText('Your demo work queue is ready', { exact: true }));
      assert.equal(state.requests.length, 0, 'A new guest session starts with an empty demo queue');
    }, { guestWorkflow: true, allowUploads: true });
    console.log('PASS: Guest demo entry without Entra setup, sample load, draft edit/approval, .msg/manual imports, mobile layout, and exit from detail.');

    await scenario(browser, { configured: false, signedIn: false, guestEnabled: true, username: null }, async (page, state) => {
      await expectVisible(page.getByRole('button', { name: 'Continue as guest', exact: true }));
      state.guestStartError = 'GUEST_DEMO_DISABLED';
      await page.getByRole('button', { name: 'Continue as guest', exact: true }).click();
      await expectText(page.getByRole('alert'), 'Guest demo access is currently disabled.');
      assert.equal(await page.getByRole('button', { name: 'Continue as guest', exact: true }).count(), 0);
      assert.ok(!state.apiCalls.some((call) => /requests|stats|mailbox/.test(call)), 'Rejected guest entry never accesses data');
    });
    await scenario(browser, { configured: false, signedIn: false, guestEnabled: true, username: null }, async (page, state) => {
      await expectVisible(page.getByRole('button', { name: 'Continue as guest', exact: true }));
      state.guestStartError = 'GUEST_DEMO_UNAVAILABLE';
      await page.getByRole('button', { name: 'Continue as guest', exact: true }).click();
      await expectText(page.getByRole('alert'), 'Guest demo setup needs attention.');
    });
    await scenario(browser, { configured: false, signedIn: false, guest: true, guestEnabled: true, username: null }, async (page, state) => {
      await expectVisible(page.getByRole('row').filter({ hasText: messageFixtures[0].subject }));
      state.expireRequests = true;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expectText(page.getByRole('alert'), 'Your guest demo session has expired.');
      await expectVisible(page.getByRole('button', { name: 'Continue as guest', exact: true }));
      assert.equal((await page.locator('body').innerText()).includes(messageFixtures[0].subject), false, 'Expired guest session clears its queue');
      assert.equal(await page.getByRole('button', { name: 'Exit demo', exact: true }).count(), 0);
    }, { requests: [requestFixture(messageFixtures[0])], guestWorkflow: true });
    console.log('PASS: Disabled/unavailable guest entry and expired demo sessions keep data protected.');
    console.log('PASS: No live Outlook/SAP calls or email-send actions; all APIs were intercepted.');
    console.log(`Screenshots: ${path.join(screenshotDirectory, 'cs-agent-ui-desktop.png')}, ${path.join(screenshotDirectory, 'cs-agent-ui-mobile.png')}`);
  } finally {
    if (browser) await browser.close();
    if (server) server.kill('SIGTERM');
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
