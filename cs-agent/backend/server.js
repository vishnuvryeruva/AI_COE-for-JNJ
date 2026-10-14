const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const cookieParser = require('cookie-parser');

const db = require('./db');
const aiCore = require('./ai-core');
const config = require('./config');
const ingest = require('./email/ingest');
const agent = require('./agent');
const { scenarios } = require('./scenarios');
const graphAuth = require('./msgraph/auth');
const graph = require('./msgraph/graph');
const { createSearchHandler } = require('./msgraph/mailbox');
const { createAuthHandlers } = require('./msgraph/auth-routes');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024 } });

app.set('trust proxy', 1); // behind nginx on CF — needed for req.secure / secure cookies
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser(config.cookieSecret));
app.use(morgan('tiny', { skip: (req) => req.path === '/api/v1/auth/callback' }));

const api = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Resolve the signed-in Microsoft account (if any) for this request.
const authHandlers = createAuthHandlers({ auth: graphAuth, db, config });
const sessionFrom = authHandlers.sessionFrom;
const ownerFor = (req) => req.authSession?.home_account_id || null;
const actorFor = (req) => req.authSession?.username || 'csr';
async function graphTokenFor(req) {
  const session = await sessionFrom(req);
  if (!session) return null;
  return graphAuth.getAccessTokenForSession(session);
}

api.get('/health', (_req, res) => {
  res.json({ status: 'ok', aiCore: aiCore.isConfigured() ? 'configured' : 'stub' });
});

// --- Microsoft Graph delegated auth ---

api.use(authHandlers.requireSameOrigin);
api.get('/auth/status', wrap(authHandlers.status));
api.get('/auth/login', wrap(authHandlers.login));
api.get('/auth/callback', wrap(authHandlers.callback));
api.post('/auth/logout', wrap(authHandlers.logout));

// Protect every data endpoint, including uploads, queue, audit and approval.
api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
api.use(wrap(authHandlers.requireSignIn));

// --- Mailbox (the signed-in CSR's own inbox) ---

api.post('/mailbox/search', createSearchHandler({
  isConfigured: graphAuth.isConfigured,
  tokenFor: graphTokenFor,
  searchInbox: graph.searchInbox,
}));

api.get('/mailbox/messages', wrap(async (req, res) => {
  const token = await graphTokenFor(req);
  if (!token) return res.status(401).json({ error: 'Not signed in to Outlook' });
  res.json(await graph.listInbox(token));
}));

api.post('/mailbox/messages/:id/ingest', wrap(async (req, res) => {
  const token = await graphTokenFor(req);
  if (!token) return res.status(401).json({ error: 'Not signed in to Outlook' });
  const me = await graph.getMe(token);
  const message = await graph.getMessage(token, req.params.id);
  const { request, deduped } = await ingest.ingestGraphMessage(message, me.email, ownerFor(req));
  res.status(deduped ? 200 : 201).json({ request, deduped });
}));

api.get('/stats', wrap(async (req, res) => {
  res.json(await db.stats(ownerFor(req)));
}));

api.get('/intents', (_req, res) => {
  res.json(Object.entries(agent.INTENTS).map(([value, label]) => ({ value, label })));
});

api.get('/requests', wrap(async (req, res) => {
  const { status, intent } = req.query;
  res.json(await db.listRequests({ status, intent }, ownerFor(req)));
}));

api.get('/requests/:id', wrap(async (req, res) => {
  const request = await db.getRequest(req.params.id, ownerFor(req));
  if (!request) return res.status(404).json({ error: 'Not found' });
  request.audit = await db.getAudit(req.params.id, ownerFor(req));
  res.json(request);
}));

// --- Ingestion adapters ---

api.post('/requests/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { request, deduped } = await ingest.ingestUploadedEmail(req.file.buffer, req.file.originalname, ownerFor(req));
  res.status(deduped ? 200 : 201).json({ request, deduped });
}));

api.post('/requests/manual', wrap(async (req, res) => {
  const { from, subject, body, mailingGroup } = req.body || {};
  if (!from || !body) return res.status(400).json({ error: 'from and body are required' });
  const { request } = await ingest.ingestManual({ from, subject, body, mailingGroup }, ownerFor(req));
  res.status(201).json({ request });
}));

api.post('/requests/scenarios', wrap(async (req, res) => {
  const created = [];
  for (const scenario of scenarios) {
    const { request } = await ingest.ingestEml(Buffer.from(scenario.eml, 'utf8'), scenario.name, ownerFor(req));
    created.push(request);
  }
  res.status(201).json({ created: created.length, requests: created });
}));

// --- Review actions ---

api.patch('/requests/:id/draft', wrap(async (req, res) => {
  const { subject, body, to, cc } = req.body || {};
  const request = await db.updateDraft(req.params.id, { subject, body, to, cc }, ownerFor(req));
  if (!request) return res.status(404).json({ error: 'Not found' });
  await db.addAudit(req.params.id, actorFor(req), 'DRAFT_EDITED', null);
  res.json(request);
}));

api.post('/requests/:id/regenerate', wrap(async (req, res) => {
  const existing = await db.getRequest(req.params.id, ownerFor(req));
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const email = {
    original: existing.email,
    mailingGroup: existing.mailingGroup,
    extraction: existing.extraction,
  };
  const drafted = await agent.draft(email, existing.analysis);
  const request = await db.updateDraft(req.params.id, { subject: drafted.subject, body: drafted.body }, ownerFor(req));
  await db.addAudit(req.params.id, actorFor(req), 'REGENERATED', null);
  res.json(request);
}));

api.post('/requests/:id/approve', wrap(async (req, res) => {
  const existing = await db.getRequest(req.params.id, ownerFor(req));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!existing.draft.to) {
    return res.status(400).json({ error: 'Cannot send: no recipient. Set the original sender first.' });
  }

  const token = await graphTokenFor(req);
  const actor = actorFor(req);
  const recipients = `to=${existing.draft.to}, cc=${(existing.draft.cc || []).join(',') || 'none'}`;

  if (token) {
    // Signed in to Outlook — actually send, delegated (from the CSR).
    await graph.sendMail(token, {
      to: existing.draft.to,
      cc: existing.draft.cc || [],
      subject: existing.draft.subject,
      body: existing.draft.body,
    });
    const request = await db.setStatus(req.params.id, 'SENT', 'Sent via Outlook', ownerFor(req));
    await db.addAudit(req.params.id, actor, 'SENT', `${recipients} — sent via Microsoft Graph`);
    return res.json({ ...request, sent: true });
  }

  if (graphAuth.isConfigured() || config.authRequired) {
    return res.status(401).json({ code: 'OUTLOOK_SIGN_IN_REQUIRED', error: 'Reconnect Outlook before sending. This reply has not been sent.' });
  }

  // Not signed in — record the approval but don't send. Demo/offline path.
  const request = await db.setStatus(req.params.id, 'SENT', 'Approved (send stubbed — not signed in to Outlook)', ownerFor(req));
  await db.addAudit(req.params.id, actor, 'APPROVED', `${recipients} — send stubbed`);
  res.json({ ...request, sent: false });
}));

api.post('/requests/:id/reject', wrap(async (req, res) => {
  const { reasonCode, comment } = req.body || {};
  const request = await db.setStatus(req.params.id, 'REJECTED', reasonCode || 'Rejected by reviewer', ownerFor(req));
  if (!request) return res.status(404).json({ error: 'Not found' });
  await db.addAudit(req.params.id, actorFor(req), 'REJECTED', comment || reasonCode || null);
  res.json(request);
}));

app.use('/api/v1', api);

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      code: err.code,
      error: err.code === 'LIMIT_FILE_SIZE' ? 'Email files must be 32 MB or smaller.' : 'Upload one .eml or .msg email file at a time.',
    });
  }
  if (err instanceof graph.GraphError) {
    const status = [401, 403, 429].includes(err.status) ? err.status : 502;
    const error = status === 401 ? 'Your Outlook connection expired. Sign in again.'
      : status === 403 ? 'Outlook denied access. Ask J&J IT to check the app permissions.'
      : status === 429 ? 'Outlook is limiting requests. Wait a moment and try again.'
      : 'Outlook could not complete the request. Please try again.';
    return res.status(status).json({ code: 'OUTLOOK_REQUEST_FAILED', error });
  }
  const status = Number(err.statusCode || err.status);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ code: err.code || 'INVALID_REQUEST', error: err.message });
  }
  // Do not leak email content, OAuth tokens or database details to clients/logs.
  console.error('[error]', err.code || err.name || 'Internal error');
  res.status(500).json({ error: 'The request could not be completed. Please try again.' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);

if (require.main === module) {
  db.init()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`[server] CS Agent API on :${PORT}`);
        console.log(`[server] AI Core: ${aiCore.isConfigured() ? 'configured' : 'NOT configured — using keyword stub'}`);
        console.log(`[server] Outlook/Graph: ${graphAuth.isConfigured() ? 'configured' : 'NOT configured — Outlook setup required'}`);
        console.log(`[server] Sign-in required: ${config.authRequired}`);
      });
    })
    .catch((err) => {
      console.error('[server] Failed to initialize database:', err.code || err.name);
      process.exit(1);
    });
}

module.exports = { app };
