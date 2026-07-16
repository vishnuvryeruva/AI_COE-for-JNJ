const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');

const db = require('./db');
const aiCore = require('./ai-core');
const config = require('./config');
const ingest = require('./email/ingest');
const agent = require('./agent');
const { scenarios } = require('./scenarios');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('tiny'));

const api = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

api.get('/health', (_req, res) => {
  res.json({ status: 'ok', aiCore: aiCore.isConfigured() ? 'configured' : 'stub' });
});

api.get('/stats', wrap(async (_req, res) => {
  res.json(await db.stats());
}));

api.get('/intents', (_req, res) => {
  res.json(Object.entries(agent.INTENTS).map(([value, label]) => ({ value, label })));
});

api.get('/requests', wrap(async (req, res) => {
  const { status, intent } = req.query;
  res.json(await db.listRequests({ status, intent }));
}));

api.get('/requests/:id', wrap(async (req, res) => {
  const request = await db.getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  request.audit = await db.getAudit(req.params.id);
  res.json(request);
}));

// --- Ingestion adapters ---

api.post('/requests/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { request, deduped } = await ingest.ingestEml(req.file.buffer, req.file.originalname);
  res.status(deduped ? 200 : 201).json({ request, deduped });
}));

api.post('/requests/manual', wrap(async (req, res) => {
  const { from, subject, body, mailingGroup } = req.body || {};
  if (!from || !body) return res.status(400).json({ error: 'from and body are required' });
  const { request } = await ingest.ingestManual({ from, subject, body, mailingGroup });
  res.status(201).json({ request });
}));

api.post('/requests/scenarios', wrap(async (_req, res) => {
  const created = [];
  for (const scenario of scenarios) {
    const { request } = await ingest.ingestEml(Buffer.from(scenario.eml, 'utf8'), scenario.name);
    created.push(request);
  }
  res.status(201).json({ created: created.length, requests: created });
}));

// --- Review actions ---

api.patch('/requests/:id/draft', wrap(async (req, res) => {
  const { subject, body, to, cc } = req.body || {};
  const request = await db.updateDraft(req.params.id, { subject, body, to, cc });
  if (!request) return res.status(404).json({ error: 'Not found' });
  await db.addAudit(req.params.id, req.body.actor || 'csr', 'DRAFT_EDITED', null);
  res.json(request);
}));

api.post('/requests/:id/regenerate', wrap(async (req, res) => {
  const existing = await db.getRequest(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const email = {
    original: existing.email,
    mailingGroup: existing.mailingGroup,
    extraction: existing.extraction,
  };
  const drafted = await agent.draft(email, existing.analysis);
  const request = await db.updateDraft(req.params.id, { subject: drafted.subject, body: drafted.body });
  await db.addAudit(req.params.id, req.body?.actor || 'csr', 'REGENERATED', null);
  res.json(request);
}));

api.post('/requests/:id/approve', wrap(async (req, res) => {
  const existing = await db.getRequest(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!existing.draft.to) {
    return res.status(400).json({ error: 'Cannot send: no recipient. Set the original sender first.' });
  }

  // POC 1 stops here. Sending is Microsoft Graph sendMail, which is blocked on
  // the AAD app registration — see Phase1-Email-Forward-Approach.md §11.
  const request = await db.setStatus(req.params.id, 'SENT', 'Approved (send stubbed in POC 1)');
  await db.addAudit(
    req.params.id,
    req.body?.actor || 'csr',
    'APPROVED',
    `to=${existing.draft.to}, cc=${(existing.draft.cc || []).join(',') || 'none'} — send stubbed`
  );
  res.json(request);
}));

api.post('/requests/:id/reject', wrap(async (req, res) => {
  const { reasonCode, comment } = req.body || {};
  const request = await db.setStatus(req.params.id, 'REJECTED', reasonCode || 'Rejected by reviewer');
  if (!request) return res.status(404).json({ error: 'Not found' });
  await db.addAudit(req.params.id, req.body?.actor || 'csr', 'REJECTED', comment || reasonCode || null);
  res.json(request);
}));

app.use('/api/v1', api);

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] CS Agent API on :${PORT}`);
      console.log(`[server] AI Core: ${aiCore.isConfigured() ? 'configured' : 'NOT configured — using keyword stub'}`);
      console.log(`[server] Agent mailbox: ${config.agentMailbox}`);
    });
  })
  .catch((err) => {
    console.error('[server] Failed to initialize database:', err);
    process.exit(1);
  });
