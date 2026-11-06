const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../src/config');
const { createStore } = require('../src/store');
const { createEngine } = require('../src/engine');
const { KL, quietLog } = require('./helpers');

const OWNER = '+60111111111';

function setup(env = {}) {
  const config = load({ PUBLIC_URL: 'https://calls.example.com', OWNER_PHONE: OWNER, ...env });
  const store = createStore(null);
  const clock = { t: KL('05:30') };
  const created = [];
  const kicks = [];
  const client = { calls: { create: async (o) => (created.push(o), { sid: `CA${created.length}` }) } };
  const engine = createEngine({ config, store, client, now: () => clock.t, log: quietLog, later: (fn, ms) => kicks.push({ fn, ms }) });
  const cidOf = (c) => new URL(c.statusCallback).searchParams.get('cid');
  const toDriver = () => created.filter((c) => c.to !== OWNER);
  const toOwner = () => created.filter((c) => c.to === OWNER);
  return { config, store, clock, created, kicks, engine, cidOf, toDriver, toOwner };
}

test('default: no answer -> calls again straight away, no 5-minute wait', async () => {
  const h = setup();
  const ali = h.engine.addDriver({ name: 'Ali', phone: '0123456789', wakeTime: '05:30' });
  await h.engine.tick();
  assert.equal(h.toDriver().length, 1);

  h.clock.t += 45000; // rang for 45 seconds, no answer
  h.engine.handleStatus(h.cidOf(h.created[0]), 'no-answer');
  assert.equal(h.kicks.length, 1, 'asks for a quick re-check');
  assert.equal(h.kicks[0].ms, 3000);
  h.clock.t += 3000;
  await h.kicks[0].fn();
  assert.equal(h.toDriver().length, 2, 'second call ~3 seconds later');
  assert.equal(h.store.data.days['2026-11-09'][ali.id].wake.attempts, 2);
});

test('default: boss called once after 3 misses, driver keeps getting called until he answers', async () => {
  const h = setup();
  const ali = h.engine.addDriver({ name: 'Ali', phone: '0123456789', wakeTime: '05:30' });
  await h.engine.tick();
  for (let i = 0; i < 6; i++) {
    const last = h.toDriver()[h.toDriver().length - 1];
    h.clock.t += 45000;
    h.engine.handleStatus(h.cidOf(last), 'no-answer');
    await new Promise((r) => setImmediate(r));
    await h.engine.tick();
  }
  assert.equal(h.toDriver().length, 7, 'still calling after 6 misses');
  assert.equal(h.toOwner().length, 1, 'boss called only once');
  assert.match(h.toOwner()[0].twiml, /saya akan terus telefon dia/);

  // He finally answers
  const last = h.toDriver()[h.toDriver().length - 1];
  await h.engine.handleGather(h.cidOf(last), { Digits: '1' });
  h.engine.handleStatus(h.cidOf(last), 'completed');
  const flow = h.store.data.days['2026-11-09'][ali.id].wake;
  assert.equal(flow.result, 'awake');
  h.clock.t += 60000;
  await h.engine.tick();
  assert.equal(h.toDriver().length, 7, 'no more calls once awake');
});

test('default: stops after 20 calls', async () => {
  const h = setup();
  const ali = h.engine.addDriver({ name: 'Ali', phone: '0123456789', wakeTime: '05:30' });
  await h.engine.tick();
  for (let i = 0; i < 25; i++) {
    const last = h.toDriver()[h.toDriver().length - 1];
    h.clock.t += 45000;
    h.engine.handleStatus(h.cidOf(last), 'no-answer');
    await new Promise((r) => setImmediate(r));
    await h.engine.tick();
  }
  assert.equal(h.toDriver().length, 20);
  const flow = h.store.data.days['2026-11-09'][ali.id].wake;
  assert.equal(flow.state, 'alerted');
  assert.equal(flow.result, 'no_answer');
  assert.ok(h.store.data.log.some((e) => e.event === 'gave_up' && e.attempt === 20));
});

test('limits can be changed', () => {
  const c = load({ WAKE_RETRY_MINUTES: '1', WAKE_MAX_CALLS: '10' });
  assert.equal(c.rules.wakeRetryMinutes, 1);
  assert.equal(c.rules.wakeMaxCalls, 10);
  assert.equal(load({}).rules.outRetryMinutes, 0);
  assert.equal(load({}).rules.outMaxCalls, 20);
});
