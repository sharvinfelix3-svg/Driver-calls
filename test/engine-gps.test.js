const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../src/config');
const { createStore } = require('../src/store');
const { createEngine } = require('../src/engine');
const { KL, quietLog } = require('./helpers');

const OWNER = '+60111111111';

function setup({ gps = null } = {}) {
  const config = load({ PUBLIC_URL: 'https://calls.example.com', OWNER_PHONE: OWNER });
  const store = createStore(null);
  const clock = { t: KL('05:00') };
  const created = [];
  const kicks = [];
  const client = { calls: { create: async (o) => (created.push(o), { sid: `CA${created.length}` }) } };
  const engine = createEngine({ config, store, client, gps, now: () => clock.t, log: quietLog, later: (fn, ms) => kicks.push({ fn, ms }) });
  const at = async (hhmm) => {
    clock.t = KL(hhmm);
    await engine.tick();
    await new Promise((r) => setImmediate(r));
  };
  const cidOf = (c) => new URL(c.statusCallback).searchParams.get('cid');
  const flow = (id, kind) => store.data.days['2026-11-09'][id][kind];
  const toOwner = () => created.filter((c) => c.to === OWNER);
  const toDriver = () => created.filter((c) => c.to !== OWNER);
  return { config, store, clock, created, kicks, engine, at, cidOf, flow, toOwner, toDriver };
}

const fakeGps = (on) => {
  const asked = [];
  return { asked, engineStatus: async (plate) => (asked.push(plate), { on: typeof on === 'function' ? on() : on }) };
};

test('driver needs a plate for an engine time; engine-only drivers are allowed', () => {
  const h = setup();
  assert.throws(() => h.engine.addDriver({ name: 'Ali', phone: '0123456789', engineTime: '06:00' }), /lorry plate/);
  const d = h.engine.addDriver({ name: 'Ali', phone: '0123456789', plate: ' bsn  4631 ', engineTime: '06:00' });
  assert.equal(d.plate, 'BSN 4631');
  assert.equal(d.engineTime, '06:00');
  assert.throws(() => h.engine.updateDriver(d.id, { engineTime: '25:00' }), /Engine time looks wrong/);
});

test('no GPS connected: engine time just shows "GPS not connected", no calls', async () => {
  const h = setup();
  const d = h.engine.addDriver({ name: 'Ali', phone: '0123456789', plate: 'BSN 4631', engineTime: '06:00' });
  await h.at('06:00');
  assert.equal(h.flow(d.id, 'engine').state, 'no_gps');
  assert.equal(h.created.length, 0);
  assert.equal(h.engine.snapshot().status.gps, false);
});

test('engine ON at the set time: no calls', async () => {
  const gps = fakeGps(true);
  const h = setup({ gps });
  const d = h.engine.addDriver({ name: 'Ali', phone: '0123456789', plate: 'BSN 4631', engineTime: '06:00', outTime: '06:30' });
  await h.at('05:59');
  assert.equal(gps.asked.length, 0);
  await h.at('06:00');
  assert.deepEqual(gps.asked, ['BSN 4631']);
  assert.equal(h.flow(d.id, 'engine').result, 'on');
  assert.equal(h.created.length, 0);
});

test('engine OFF at the set time: boss is called and driver is asked straight away', async () => {
  const h = setup({ gps: fakeGps(false) });
  const d = h.engine.addDriver({ name: 'Ali', phone: '0123456789', plate: 'BSN 4631', engineTime: '06:00', outTime: '06:30' });
  await h.at('06:00');
  assert.equal(h.flow(d.id, 'engine').result, 'off');
  assert.equal(h.toOwner().length, 1);
  assert.match(h.toOwner()[0].twiml, /Lori B S N, 4 6 3 1, enjin belum hidup/);
  assert.match(h.toOwner()[0].twiml, /Sepatutnya hidup pukul enam pagi/);
  assert.equal(h.toDriver().length, 1, 'driver gets the dah keluar call now, not at 06:30');
  assert.match(h.toDriver()[0].twiml, /Dah keluar ke belum/);
  // He answers "dah keluar"
  await h.engine.handleGather(h.cidOf(h.toDriver()[0]), { Digits: '1' });
  h.engine.handleStatus(h.cidOf(h.toDriver()[0]), 'completed');
  await h.at('06:30');
  assert.equal(h.toDriver().length, 1, 'no second check call at 06:30');
});

test('driver presses 1 but engine still off a few minutes later: boss is called', async () => {
  let on = false;
  const h = setup({ gps: fakeGps(() => on) });
  h.engine.addDriver({ name: 'Ali', phone: '0123456789', plate: 'BSN 4631', outTime: '06:30' });
  await h.at('06:30');
  const call = h.toDriver()[0];
  await h.engine.handleGather(h.cidOf(call), { Digits: '1' });
  assert.equal(h.kicks.length, 1);
  assert.equal(h.kicks[0].ms, 3 * 60000);
  await h.kicks[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.toOwner().length, 1);
  assert.match(h.toOwner()[0].twiml, /Ali kata dah keluar, tapi enjin lori B S N, 4 6 3 1 masih belum hidup/);

  // Same, but the engine is on: no call
  const h2 = setup({ gps: fakeGps(true) });
  h2.engine.addDriver({ name: 'Ali', phone: '0123456789', plate: 'BSN 4631', outTime: '06:30' });
  await h2.at('06:30');
  await h2.engine.handleGather(h2.cidOf(h2.toDriver()[0]), { Digits: '1' });
  await h2.kicks[0].fn();
  assert.equal(h2.toOwner().length, 0);
  on = true;
});

test('GPS error: tries 3 times, then shows the error without calling anyone', async () => {
  const gps = { engineStatus: async () => { throw new Error('login failed'); } };
  const h = setup({ gps });
  const d = h.engine.addDriver({ name: 'Ali', phone: '0123456789', plate: 'BSN 4631', engineTime: '06:00' });
  await h.at('06:00');
  assert.equal(h.flow(d.id, 'engine').state, 'waiting');
  await h.at('06:01');
  await h.at('06:02');
  assert.equal(h.flow(d.id, 'engine').state, 'error');
  assert.equal(h.flow(d.id, 'engine').lastAnswer, 'login failed');
  assert.equal(h.created.length, 0);
});
