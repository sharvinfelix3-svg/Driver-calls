// Web server: the calling service talks to /voice/*, your phone page talks to /api/*.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const twilio = require('twilio');
const { load } = require('./config');
const { createStore } = require('./store');
const { createEngine } = require('./engine');
const { makeProvider, missingProviderSettings, saveVonageKey, VONAGE_END_STATUSES } = require('./providers');

function createApp({ config, engine, provider = null, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/', (req, res) => res.redirect('/admin'));
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

  // ---------- the calling service (Twilio or Telnyx) ----------
  const HANGUP = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
  const voice = express.Router();
  voice.use(express.urlencoded({ extended: false }));
  voice.use(express.json({ limit: '100kb' }));
  const params = (req) => ({ ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) });

  // Someone rings your calling number back: a short message, then hang up.
  const isVonage = config.provider === 'vonage';
  const vonageNcco = (xml) => (provider && provider.ncco ? provider.ncco.fromTwiml(xml) : []);
  voice.all('/inbound', (req, res) => {
    const v = config.voices.ms;
    const text = `Ini nombor sistem panggilan pemandu ${config.companyName}. Untuk sebarang hal, sila telefon boss terus. Terima kasih.`;
    if (isVonage) return res.json([{ action: 'talk', text, language: 'ms-MY' }]);
    const r = new twilio.twiml.VoiceResponse();
    r.say({ voice: v.voice, language: v.language }, text);
    r.hangup();
    res.type('text/xml').send(r.toString());
  });
  // Vonage sends general call events here (set as the app's Event URL). Nothing to do.
  voice.all('/events', (req, res) => res.sendStatus(204));

  // Everything else must carry the secret key, so nobody can fake a driver's answer.
  voice.use((req, res, next) => {
    if (config.webhookKey) {
      const got = Buffer.from(String(req.query.key || ''));
      const want = Buffer.from(config.webhookKey);
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
        log.warn(`[voice] Rejected a request without the right key (${req.path}).`);
        return res.status(403).send('Forbidden');
      }
    }
    if (config.provider === 'twilio' && config.validateTwilioSignature && !config.dryRun) {
      const signature = req.get('X-Twilio-Signature') || '';
      const url = config.publicUrl + req.originalUrl;
      if (!config.twilio.authToken || !twilio.validateRequest(config.twilio.authToken, signature, url, req.body || {})) {
        log.warn(`[voice] Rejected a request with a bad Twilio signature (${req.path}). Check PUBLIC_URL matches your real address.`);
        return res.status(403).send('Forbidden');
      }
    }
    next();
  });
  voice.all('/twiml', (req, res) => {
    res.type('text/xml').send(engine.getTwiml(String(req.query.cid || '')));
  });
  voice.all('/gather', async (req, res) => {
    const cid = String(req.query.cid || '');
    try {
      if (isVonage) {
        const b = req.body || {};
        const digits = String((b.dtmf && b.dtmf.digits) || '');
        const results = (b.speech && b.speech.results) || [];
        const speech = String((results[0] && results[0].text) || '');
        // Nothing pressed or said: carry on with the rest of the call script
        if (!digits && !speech) return res.json(provider ? provider.ncco.continueAfter(req.query.gid) : []);
        return res.json(vonageNcco(await engine.handleGather(cid, { Digits: digits, SpeechResult: speech })));
      }
      const xml = await engine.handleGather(cid, params(req));
      res.type('text/xml').send(xml);
    } catch (e) {
      log.error(`[voice] gather failed: ${e.stack || e.message}`);
      if (isVonage) return res.json(provider ? provider.ncco.continueAfter('') : []);
      res.type('text/xml').send(HANGUP);
    }
  });
  voice.all('/status', (req, res) => {
    try {
      const p = params(req);
      if (isVonage) {
        // Vonage reports every step (started, ringing, answered...). Only the end matters.
        const st = String(p.status || '');
        if (VONAGE_END_STATUSES.has(st)) engine.handleStatus(String(req.query.cid || ''), st);
      } else {
        engine.handleStatus(String(req.query.cid || ''), p.CallStatus || p.call_status || 'completed');
      }
    } catch (e) {
      log.error(`[voice] status failed: ${e.stack || e.message}`);
    }
    res.sendStatus(204);
  });
  app.use('/voice', voice);

  // ---------- your phone page ----------
  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
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
  api.post('/vonage-key', wrap((req, b) => {
    if (config.provider !== 'vonage') throw new Error('This server is not set to use Vonage');
    saveVonageKey(config.vonage, b.pem);
  }));
  app.use('/api', api);

  return app;
}

function start() {
  const config = load();
  const store = createStore(path.resolve(config.dataDir, 'db.json'));
  const client = makeProvider(config);
  const engine = createEngine({ config, store, client });
  const app = createApp({ config, engine, provider: client });

  app.listen(config.port, () => {
    console.log(`Driver call system running on port ${config.port} using ${config.providerName}${config.dryRun ? ' (DRY RUN: no real calls)' : ''}`);
    console.log(`Phone page: ${config.publicUrl || `http://localhost:${config.port}`}/admin`);
    const missing = [];
    if (!config.adminToken) missing.push('ADMIN_TOKEN (password for the phone page)');
    if (!config.dryRun && !client) missing.push(`${config.providerName}: ${missingProviderSettings(config).join(', ')}`);
    if (!config.dryRun && !config.publicUrl) missing.push('PUBLIC_URL');
    if (!config.owner.phone) missing.push('OWNER_PHONE (your number, for alerts)');
    if (config.storageWarning) console.warn(`WARNING: ${config.storageWarning}`);
    if (missing.length) console.warn(`Not set yet:\n  - ${missing.join('\n  - ')}`);
    if (!config.ai.apiKey) console.log('ANTHROPIC_API_KEY not set: spoken answers use keyword matching (keypresses always work).');
  });

  engine.tick();
  setInterval(() => engine.tick(), 20000);
}

if (require.main === module) start();

module.exports = { createApp };
