// Web server: Twilio talks to /twilio/*, your phone page talks to /api/*.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const twilio = require('twilio');
const { load } = require('./config');
const { createStore } = require('./store');
const { createEngine } = require('./engine');

function makeTwilioClient(config) {
  const { accountSid, authToken, from } = config.twilio;
  if (!accountSid || !authToken || !from) return null;
  return twilio(accountSid, authToken);
}

function createApp({ config, engine, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/', (req, res) => res.redirect('/admin'));
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

  // ---------- Twilio ----------
  const tw = express.Router();
  tw.use(express.urlencoded({ extended: false }));
  tw.use((req, res, next) => {
    if (!config.validateTwilioSignature || config.dryRun) return next();
    const signature = req.get('X-Twilio-Signature') || '';
    const url = config.publicUrl + req.originalUrl;
    if (config.twilio.authToken && twilio.validateRequest(config.twilio.authToken, signature, url, req.body || {})) return next();
    log.warn(`[twilio] Rejected a request with a bad signature (${req.originalUrl}). Check PUBLIC_URL matches your real address.`);
    res.status(403).send('Forbidden');
  });
  tw.post('/gather', async (req, res) => {
    try {
      const xml = await engine.handleGather(String(req.query.cid || ''), req.body || {});
      res.type('text/xml').send(xml);
    } catch (e) {
      log.error(`[twilio] gather failed: ${e.stack || e.message}`);
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    }
  });
  tw.post('/status', (req, res) => {
    try {
      engine.handleStatus(String(req.query.cid || ''), (req.body && req.body.CallStatus) || 'completed');
    } catch (e) {
      log.error(`[twilio] status failed: ${e.stack || e.message}`);
    }
    res.sendStatus(204);
  });
  app.use('/twilio', tw);

  // ---------- your phone page ----------
  const api = express.Router();
  api.use(express.json({ limit: '50kb' }));
  api.use((req, res, next) => {
    if (!config.adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN is not set on the server yet' });
    const got = Buffer.from(String(req.get('x-admin-token') || ''));
    const want = Buffer.from(config.adminToken);
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return next();
    res.status(401).json({ error: 'Wrong password' });
  });
  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, req.body || {});
      res.json(out === undefined ? { ok: true } : out);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  };
  api.get('/state', wrap(() => engine.snapshot()));
  api.post('/drivers', wrap((req, b) => engine.addDriver(b)));
  api.put('/drivers/:id', wrap((req, b) => engine.updateDriver(req.params.id, b)));
  api.delete('/drivers/:id', wrap((req) => engine.removeDriver(req.params.id)));
  api.put('/overrides', wrap((req, b) => engine.setOverride(b.date, b.driverId, b)));
  api.delete('/overrides', wrap((req) => engine.clearOverride(String(req.query.date || ''), String(req.query.driverId || ''))));
  api.post('/pause', wrap((req, b) => engine.setPaused(!!b.paused)));
  api.post('/call-now', wrap(async (req, b) => {
    await engine.callNow(b.driverId, b.kind);
  }));
  api.post('/test-call', wrap(async (req, b) => {
    await engine.testCall(b.driverId, b.kind);
  }));
  api.post('/test-owner', wrap(() => engine.testOwnerCall()));
  app.use('/api', api);

  return app;
}

function start() {
  const config = load();
  const store = createStore(path.resolve(config.dataDir, 'db.json'));
  const client = config.dryRun ? null : makeTwilioClient(config);
  const engine = createEngine({ config, store, client });
  const app = createApp({ config, engine });

  app.listen(config.port, () => {
    console.log(`Driver call system running on port ${config.port}${config.dryRun ? ' (DRY RUN: no real calls)' : ''}`);
    console.log(`Phone page: ${config.publicUrl || `http://localhost:${config.port}`}/admin`);
    const missing = [];
    if (!config.adminToken) missing.push('ADMIN_TOKEN (password for the phone page)');
    if (!config.dryRun && !client) missing.push('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER');
    if (!config.dryRun && !config.publicUrl) missing.push('PUBLIC_URL');
    if (!config.owner.phone) missing.push('OWNER_PHONE (your number, for alerts)');
    if (missing.length) console.warn(`Not set yet:\n  - ${missing.join('\n  - ')}`);
    if (!config.ai.apiKey) console.log('ANTHROPIC_API_KEY not set: spoken answers use keyword matching (keypresses always work).');
  });

  engine.tick();
  setInterval(() => engine.tick(), 20000);
}

if (require.main === module) start();

module.exports = { createApp, makeTwilioClient };
