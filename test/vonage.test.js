const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('../src/config');
const { createStore } = require('../src/store');
const { createEngine } = require('../src/engine');
const { createApp } = require('../src/server');
const P = require('../src/providers');
const { KL, quietLog } = require('./helpers');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

function setupVonage(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vonage-'));
  const config = load({ VONAGE_APPLICATION_ID: 'app-123', OWNER_PHONE: '+60146472974', ADMIN_TOKEN: 'secret', DATA_DIR: dir, ...extraEnv });
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push({ url, opts, body: JSON.parse(opts.body) });
    return { ok: true, status: 201, text: async () => JSON.stringify({ uuid: `uuid-${sent.length}`, status: 'started' }) };
  };
  const provider = P.vonageProvider(config.vonage, fetchImpl);
  const store = createStore(null);
  const clock = { t: KL('05:00') };
  const engine = createEngine({ config, store, client: provider, now: () => clock.t, log: quietLog });
  return { config, provider, engine, store, clock, sent, dir };
}

async function serve(h) {
  const app = createApp({ config: h.config, engine: h.engine, provider: h.provider, log: quietLog });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  h.config.publicUrl = base;
  return { base, close: () => server.close() };
}

const postJson = (url, body, token) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) }, body: JSON.stringify(body) });

test('picks Vonage from its app ID; trial caller ID; keypad only', () => {
  const c = load({ VONAGE_APPLICATION_ID: 'a' });
  assert.equal(c.provider, 'vonage');
  assert.equal(c.providerName, 'Vonage');
  assert.equal(c.callerId, '123456789');
  assert.equal(c.speechInput, false);
  assert.equal(load({ VONAGE_APPLICATION_ID: 'a', VONAGE_FROM_NUMBER: '+12015550123' }).callerId, '+12015550123');
  assert.equal(load({ VONAGE_APPLICATION_ID: 'a', TELNYX_API_KEY: 'k' }).provider, 'telnyx');
  assert.equal(load({ VONAGE_APPLICATION_ID: 'a', TELNYX_API_KEY: 'k', CALL_PROVIDER: 'vonage' }).provider, 'vonage');
});

test('login token is signed with the private key and names the app', () => {
  const jwt = P.vonageJwt('app-123', PEM, Date.parse('2026-11-06T00:00:00Z'));
  const [h, p, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.application_id, 'app-123');
  assert.equal(claims.exp - claims.iat, 300);
  assert.ok(claims.jti);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url')));
});

test('TwiML becomes Vonage steps; silence carries on with the rest of the script', () => {
  const r = P.createNccoRenderer();
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    '<Gather input="dtmf" numDigits="1" timeout="7" action="https://x/voice/gather?cid=c1&amp;key=k" method="POST"><Say voice="v" language="ms-MY">Helo Ali &amp; kawan</Say><Say language="ms-MY">Tekan satu.</Say></Gather>' +
    '<Gather input="dtmf" numDigits="1" timeout="7" action="https://x/voice/gather?cid=c1&amp;key=k" method="POST"><Say language="ms-MY">Saya ulang.</Say></Gather>' +
    '<Say language="ms-MY">Saya tak dengar.</Say><Hangup/></Response>';
  const first = r.fromTwiml(xml);
  assert.equal(first.length, 3);
  assert.deepEqual(first[0], { action: 'talk', text: 'Helo Ali & kawan', language: 'ms-MY', bargeIn: true });
  assert.equal(first[2].action, 'input');
  assert.deepEqual(first[2].type, ['dtmf']);
  assert.deepEqual(first[2].dtmf, { maxDigits: 1, timeOut: 7, submitOnHash: false });
  const gid = new URL(first[2].eventUrl[0]).searchParams.get('gid');
  assert.equal(new URL(first[2].eventUrl[0]).searchParams.get('key'), 'k');

  const second = r.continueAfter(gid);
  assert.equal(second[0].text, 'Saya ulang.');
  const gid2 = new URL(second[1].eventUrl[0]).searchParams.get('gid');
  const third = r.continueAfter(gid2);
  assert.deepEqual(third, [{ action: 'talk', text: 'Saya tak dengar.', language: 'ms-MY' }]);
  assert.deepEqual(r.continueAfter('unknown'), [{ action: 'talk', text: 'Terima kasih.', language: 'ms-MY' }]);
});

test('Vonage: missing key gives a clear error; uploading it on the page fixes it', async () => {
  const h = setupVonage();
  const srv = await serve(h);
  try {
    let state = await (await fetch(`${srv.base}/api/state`, { headers: { 'x-admin-token': 'secret' } })).json();
    assert.equal(state.status.provider, 'Vonage');
    assert.deepEqual(state.status.missing, ['private.key (upload it below)']);

    h.engine.testOwnerCall();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.sent.length, 0);
    assert.match(h.store.data.alerts[0].error, /private\.key is missing/);

    const bad = await postJson(`${srv.base}/api/vonage-key`, { pem: 'hello' }, 'secret');
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /doesn't look like/);

    const ok = await postJson(`${srv.base}/api/vonage-key`, { pem: PEM }, 'secret');
    assert.equal(ok.status, 200);
    assert.ok(fs.existsSync(path.join(h.dir, 'vonage-private.key')));
    state = await (await fetch(`${srv.base}/api/state`, { headers: { 'x-admin-token': 'secret' } })).json();
    assert.deepEqual(state.status.missing, []);
  } finally {
    srv.close();
  }
});

test('Vonage: full wake-up call — silence, then key press, then call ends', async () => {
  const h = setupVonage({ VONAGE_PRIVATE_KEY: PEM.replace(/\n/g, '\\n') });
  const srv = await serve(h);
  try {
    const d = h.engine.addDriver({ name: 'Ali', phone: '012-345 6789', wakeTime: '05:30', outTime: '06:30' });
    h.clock.t = KL('05:30');
    await h.engine.tick();

    assert.equal(h.sent.length, 1);
    const { url, opts, body } = h.sent[0];
    assert.equal(url, 'https://api.nexmo.com/v1/calls');
    assert.match(opts.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.deepEqual(body.to, [{ type: 'phone', number: '60123456789' }]);
    assert.deepEqual(body.from, { type: 'phone', number: '123456789' });
    assert.ok(body.event_url[0].startsWith(`${srv.base}/voice/status?cid=`));
    assert.match(body.ncco[0].text, /Selamat pagi Ali/);
    assert.equal(body.ncco[0].language, 'ms-MY');
    const input = body.ncco.find((a) => a.action === 'input');
    assert.ok(input, 'asks for a keypress');

    // Vonage reports progress; these must not end the call
    for (const status of ['started', 'ringing', 'answered']) assert.equal((await postJson(body.event_url[0], { status })).status, 204);
    assert.equal(h.store.data.days['2026-11-09'][d.id].wake.state, 'calling');

    // Nothing pressed: Vonage still reports back, we repeat the message
    let res = await postJson(input.eventUrl[0], { dtmf: { digits: '', timed_out: true }, speech: { results: [] } });
    let next = await res.json();
    assert.match(next[0].text, /Saya ulang/);
    assert.equal(h.store.data.days['2026-11-09'][d.id].wake.state, 'calling', 'silence is not "awake"');

    // Now he presses a key
    const input2 = next.find((a) => a.action === 'input');
    res = await postJson(input2.eventUrl[0], { dtmf: { digits: '5', timed_out: false } });
    next = await res.json();
    assert.match(next[0].text, /Bagus, terima kasih/);
    assert.equal(h.store.data.days['2026-11-09'][d.id].wake.result, 'awake');

    assert.equal((await postJson(body.event_url[0], { status: 'completed' })).status, 204);
    assert.equal(h.store.data.days['2026-11-09'][d.id].wake.state, 'done');

    // Without the secret key, nothing is accepted
    const noKey = input.eventUrl[0].replace(/key=[^&]+&?/, '');
    assert.equal((await postJson(noKey, { dtmf: { digits: '1' } })).status, 403);

    // Inbound and app events
    assert.deepEqual((await (await fetch(`${srv.base}/voice/inbound`)).json())[0].action, 'talk');
    assert.equal((await postJson(`${srv.base}/voice/events`, { status: 'started' })).status, 204);
  } finally {
    srv.close();
  }
});

test('Vonage: driver never answers -> retries, then boss is called', async () => {
  const h = setupVonage({ VONAGE_PRIVATE_KEY: PEM });
  const srv = await serve(h);
  try {
    const d = h.engine.addDriver({ name: 'Ali', phone: '0123456789', wakeTime: '', outTime: '06:30' });
    for (const t of ['06:30', '06:35', '06:40']) {
      h.clock.t = KL(t);
      await h.engine.tick();
      const call = h.sent[h.sent.length - 1].body;
      await postJson(call.event_url[0], { status: 'timeout' });
    }
    await new Promise((r) => setImmediate(r));
    assert.equal(h.store.data.days['2026-11-09'][d.id].out.result, 'no_answer');
    const ownerCall = h.sent[h.sent.length - 1].body;
    assert.deepEqual(ownerCall.to, [{ type: 'phone', number: '60146472974' }]);
    assert.match(ownerCall.ncco[0].text, /Ali tak angkat/);
  } finally {
    srv.close();
  }
});

test('Vonage errors are explained', async () => {
  const fail = (status, text) =>
    P.vonageProvider({ appId: 'a', privateKey: PEM }, async () => ({ ok: false, status, text: async () => text })).calls.create({
      to: '+60',
      from: '123456789',
      twiml: '<Response><Say>x</Say></Response>',
      statusCallback: 'https://x',
    });
  await assert.rejects(fail(403, '{"title":"Forbidden","detail":"Non Whitelisted Destination"}'), /only call the number you signed up with/);
  await assert.rejects(fail(401, '{"title":"Unauthorized"}'), /VONAGE_APPLICATION_ID/);
  await assert.rejects(fail(402, 'Insufficient credit'), /Add credit/);
});

test('storage warning on Railway without a volume', () => {
  assert.equal(load({}).storageWarning, '');
  assert.match(load({ RAILWAY_ENVIRONMENT: 'production', DATA_DIR: '/data' }).storageWarning, /No Railway Volume/);
  assert.equal(load({ RAILWAY_ENVIRONMENT: 'production', DATA_DIR: '/data', RAILWAY_VOLUME_MOUNT_PATH: '/data' }).storageWarning, '');
  assert.match(load({ RAILWAY_ENVIRONMENT: 'production', DATA_DIR: './data', RAILWAY_VOLUME_MOUNT_PATH: '/data' }).storageWarning, /Set DATA_DIR to \/data/);
});
