const test = require('node:test');
const assert = require('node:assert/strict');
const twilio = require('twilio');
const { createApp } = require('../src/server');
const { setup, KL, quietLog } = require('./helpers');

async function withServer(fn) {
  const h = setup({ env: { TWILIO_AUTH_TOKEN: 'authtoken123', PUBLIC_URL: '' } });
  const app = createApp({ config: h.config, engine: h.engine, log: quietLog });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Twilio signs with the public address; use the real local address for the test
  h.config.publicUrl = base;
  try {
    await fn({ h, base });
  } finally {
    server.close();
  }
}

const api = (base, method, path, body, token = 'secret') =>
  fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-token': token },
    body: body ? JSON.stringify(body) : undefined,
  });

function signedPost(base, path, params, authToken = 'authtoken123') {
  const url = base + path;
  const signature = twilio.getExpectedTwilioSignature(authToken, url, params);
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    body: new URLSearchParams(params).toString(),
  });
}

test('phone page API needs the password', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await api(base, 'GET', '/state', null, 'wrong')).status, 401);
    assert.equal((await api(base, 'GET', '/state')).status, 200);
    const page = await fetch(base + '/admin');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Driver Calls/);
  });
});

test('add a driver, set a day off, see it in the state', async () => {
  await withServer(async ({ h, base }) => {
    h.clock.t = KL('20:00');
    let res = await api(base, 'POST', '/drivers', { name: 'Ravi', phone: '012-111 2222', wakeTime: '05:00', outTime: '06:00', days: [1, 2, 3] });
    assert.equal(res.status, 200);
    const driver = await res.json();

    res = await api(base, 'POST', '/drivers', { name: '', phone: 'x' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Name is needed/);

    res = await api(base, 'PUT', '/overrides', { date: '2026-11-10', driverId: driver.id, off: true });
    assert.equal(res.status, 200);

    const state = await (await api(base, 'GET', '/state')).json();
    assert.equal(state.date, '2026-11-09');
    assert.equal(state.tomorrow, '2026-11-10');
    assert.equal(state.drivers[0].tomorrow, null, 'off tomorrow');
    assert.deepEqual(state.drivers[0].today.schedule, { wakeTime: '05:00', outTime: '06:00', engineTime: '', plate: '' });
    assert.equal(state.overrides.length, 1);

    res = await api(base, 'DELETE', `/overrides?date=2026-11-10&driverId=${driver.id}`);
    assert.equal(res.status, 200);
    const after = await (await api(base, 'GET', '/state')).json();
    assert.equal(after.overrides.length, 0);
  });
});

test('Twilio webhooks: signed requests with the key work; missing key or bad signature is refused', async () => {
  await withServer(async ({ h, base }) => {
    const d = h.engine.addDriver({ name: 'Ali', phone: '0123456789', wakeTime: '05:30' });
    await h.at('05:30');
    const call = h.last();
    const cid = h.cidOf(call);
    assert.ok(call.statusCallback.startsWith(base + '/voice/status?cid='));
    const key = new URL(call.statusCallback).searchParams.get('key');
    assert.ok(key && key.length >= 16, 'secret key in callback link');
    const path = (p) => `/voice/${p}?cid=${cid}&key=${encodeURIComponent(key)}`;

    // no signature
    const unsigned = await fetch(base + path('gather'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'Digits=1',
    });
    assert.equal(unsigned.status, 403);
    // signed but no key
    const noKey = await signedPost(base, `/voice/gather?cid=${cid}`, { Digits: '1' });
    assert.equal(noKey.status, 403);

    const ok = await signedPost(base, path('gather'), { Digits: '1', CallSid: 'CA1' });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /xml/);
    assert.match(await ok.text(), /Bagus, terima kasih/);

    const st = await signedPost(base, path('status'), { CallStatus: 'completed', CallSid: 'CA1' });
    assert.equal(st.status, 204);
    assert.equal(h.flow(d.id, 'wake').result, 'awake');
  });
});

test('Telnyx: script is served from /voice/twiml, answers work with the key, no Twilio signature needed', async () => {
  const fetchCalls = [];
  const h = setup({ env: { TELNYX_API_KEY: 'KEY123', TELNYX_APP_ID: 'app-1', TELNYX_FROM_NUMBER: '+12025550123', PUBLIC_URL: '' } });
  const { telnyxProvider } = require('../src/providers');
  const provider = telnyxProvider(h.config.telnyx, async (url, opts) => {
    fetchCalls.push({ url, opts, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { call_sid: 'v3:abc', status: 'queued' } }) };
  });
  const { createEngine } = require('../src/engine');
  const engine = createEngine({ config: h.config, store: h.store, client: provider, now: () => h.clock.t, log: quietLog });
  const app = createApp({ config: h.config, engine, log: quietLog });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  h.config.publicUrl = base;
  try {
    assert.equal(h.config.provider, 'telnyx');
    assert.equal(h.config.speechInput, false, 'keypad only on Telnyx by default');
    const d = engine.addDriver({ name: 'Ali', phone: '0123456789', wakeTime: '05:30' });
    h.clock.t = KL('05:30');
    await engine.tick();

    assert.equal(fetchCalls.length, 1);
    const sent = fetchCalls[0];
    assert.equal(sent.url, 'https://api.telnyx.com/v2/texml/calls/app-1');
    assert.equal(sent.opts.headers.authorization, 'Bearer KEY123');
    assert.equal(sent.body.To, '+60123456789');
    assert.equal(sent.body.From, '+12025550123');
    assert.equal(sent.body.StatusCallbackEvent, 'completed');
    assert.ok(sent.body.Url.startsWith(base + '/voice/twiml?cid='));

    // Telnyx fetches the script
    const script = await fetch(sent.body.Url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'CallSid=v3:abc' });
    const xml = await script.text();
    assert.equal(script.status, 200);
    assert.match(xml, /Selamat pagi Ali/);
    assert.match(xml, /voice="Azure.ms-MY-YasminNeural"/);
    assert.match(xml, /Tekan mana-mana nombor untuk sahkan/);
    assert.doesNotMatch(xml, /atau sebut/);
    assert.doesNotMatch(xml, /speech/);

    // ...and without the key it gets nothing
    const cid = new URL(sent.body.Url).searchParams.get('cid');
    assert.equal((await fetch(`${base}/voice/twiml?cid=${cid}`)).status, 403);

    // driver presses a key; Telnyx posts form data like Twilio
    const gatherUrl = sent.body.StatusCallback.replace('/voice/status', '/voice/gather');
    const g = await fetch(gatherUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'Digits=5' });
    assert.match(await g.text(), /Bagus, terima kasih/);
    const st = await fetch(sent.body.StatusCallback, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'CallStatus=completed' });
    assert.equal(st.status, 204);
    assert.equal(h.store.data.days['2026-11-09'][d.id].wake.result, 'awake');

    // someone calls the number back
    const inbound = await fetch(`${base}/voice/inbound`);
    assert.match(await inbound.text(), /sistem panggilan pemandu/);
  } finally {
    server.close();
  }
});

test('test-call and test-owner buttons place calls', async () => {
  await withServer(async ({ h, base }) => {
    const d = h.engine.addDriver({ name: 'Ali', phone: '0123456789', wakeTime: '05:30' });
    assert.equal((await api(base, 'POST', '/test-call', { driverId: d.id, kind: 'wake' })).status, 200);
    assert.equal((await api(base, 'POST', '/test-owner')).status, 200);
    await h.flush();
    assert.equal(h.created.length, 2);
    assert.match(h.created[1].twiml, /panggilan ujian/);
    assert.equal((await api(base, 'POST', '/test-call', { driverId: 'nope', kind: 'wake' })).status, 400);
  });
});
