const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setup, KL, quietLog } = require('./helpers');
const { load } = require('../src/config');
const { createStore } = require('../src/store');
const { createEngine } = require('../src/engine');

const OWNER = '+60111111111';
const ALI = '+60123456789';

function withDriver(h, extra = {}) {
  return h.engine.addDriver({ name: 'Ali', phone: '012-345 6789', wakeTime: '05:30', outTime: '06:30', ...extra });
}

test('wake-up call: driver presses a key, nothing else happens', async () => {
  const h = setup();
  const ali = withDriver(h);
  await h.at('05:29');
  assert.equal(h.created.length, 0);

  await h.at('05:30');
  assert.equal(h.created.length, 1);
  assert.equal(h.last().to, ALI);
  assert.match(h.last().twiml, /Selamat pagi Ali/);
  assert.match(h.last().twiml, /pukul lima setengah pagi/);

  const xml = await h.engine.handleGather(h.cidOf(h.last()), { Digits: '7' });
  assert.match(xml, /Bagus, terima kasih/);
  assert.match(xml, /keluar pukul enam setengah pagi/);
  h.engine.handleStatus(h.cidOf(h.last()), 'completed');
  assert.equal(h.flow(ali.id, 'wake').state, 'done');
  assert.equal(h.flow(ali.id, 'wake').result, 'awake');

  await h.at('05:45');
  assert.equal(h.created.length, 1, 'no extra calls');
  assert.equal(h.callsTo(OWNER).length, 0);
});

test('wake-up call: speaking also counts as awake', async () => {
  const h = setup();
  const ali = withDriver(h);
  await h.at('05:30');
  await h.engine.handleGather(h.cidOf(h.last()), { SpeechResult: 'ya dah bangun' });
  assert.equal(h.flow(ali.id, 'wake').result, 'awake');
});

test('wake-up call: no answer 3 times -> boss is called, boss presses 1', async () => {
  const h = setup();
  const ali = withDriver(h);
  await h.at('05:30');
  h.engine.handleStatus(h.cidOf(h.last()), 'no-answer');
  assert.equal(h.flow(ali.id, 'wake').state, 'scheduled');

  await h.at('05:34');
  assert.equal(h.created.length, 1, 'waits 5 minutes');
  await h.at('05:35');
  assert.equal(h.created.length, 2);
  h.engine.handleStatus(h.cidOf(h.last()), 'busy');

  await h.at('05:40');
  assert.equal(h.created.length, 3);
  h.engine.handleStatus(h.cidOf(h.last()), 'completed'); // answered but pressed nothing
  await h.flush();

  assert.equal(h.flow(ali.id, 'wake').state, 'alerted');
  assert.equal(h.callsTo(OWNER).length, 1);
  const ownerCall = h.callsTo(OWNER)[0];
  assert.match(ownerCall.twiml, /Ali tak angkat panggilan bangun tidur/);
  assert.match(ownerCall.twiml, /tiga kali/);
  assert.match(ownerCall.twiml, /kosong, satu, dua, tiga/);

  const xml = await h.engine.handleGather(h.cidOf(ownerCall), { Digits: '1' });
  assert.match(xml, /Terima kasih boss/);
  h.engine.handleStatus(h.cidOf(ownerCall), 'completed');
  await h.flush();
  assert.equal(h.store.data.alerts[0].state, 'done');

  await h.at('05:50');
  assert.equal(h.callsTo(OWNER).length, 1, 'boss not called again');
});

test('boss does not confirm -> called 3 times in total, then gives up', async () => {
  const h = setup();
  withDriver(h);
  h.engine.alertOwner('Ujian', {});
  await h.flush();
  assert.equal(h.callsTo(OWNER).length, 1);
  h.engine.handleStatus(h.cidOf(h.last()), 'no-answer');
  await h.flush();
  assert.equal(h.callsTo(OWNER).length, 1, 'waits before trying again');

  h.clock.t += 3 * 60000;
  await h.engine.tick();
  assert.equal(h.callsTo(OWNER).length, 2);
  h.engine.handleStatus(h.cidOf(h.last()), 'no-answer');

  h.clock.t += 3 * 60000;
  await h.engine.tick();
  assert.equal(h.callsTo(OWNER).length, 3);
  h.engine.handleStatus(h.cidOf(h.last()), 'no-answer');
  await h.flush();

  h.clock.t += 10 * 60000;
  await h.engine.tick();
  assert.equal(h.callsTo(OWNER).length, 3);
  assert.equal(h.store.data.alerts[0].state, 'failed');
});

test('dah keluar check: pressed 1 -> done', async () => {
  const h = setup();
  const ali = withDriver(h, { wakeTime: '' });
  await h.at('06:30');
  assert.equal(h.created.length, 1);
  assert.match(h.last().twiml, /Dah keluar ke belum/);
  const xml = await h.engine.handleGather(h.cidOf(h.last()), { Digits: '1' });
  assert.match(xml, /Hati-hati memandu/);
  assert.equal(h.flow(ali.id, 'out').result, 'out');
  h.engine.handleStatus(h.cidOf(h.last()), 'completed');
  await h.at('06:50');
  assert.equal(h.created.length, 1);
});

test('dah keluar check: belum twice -> rechecks in 10 min, then calls the boss', async () => {
  const h = setup();
  const ali = withDriver(h);
  await h.at('05:30');
  await h.engine.handleGather(h.cidOf(h.last()), { Digits: '1' });
  h.engine.handleStatus(h.cidOf(h.last()), 'completed');

  await h.at('06:30');
  assert.equal(h.created.length, 2);
  let xml = await h.engine.handleGather(h.cidOf(h.last()), { Digits: '2' });
  assert.match(xml, /telefon balik dalam sepuluh minit/);
  h.engine.handleStatus(h.cidOf(h.last()), 'completed');
  assert.equal(h.flow(ali.id, 'out').state, 'scheduled');

  await h.at('06:39');
  assert.equal(h.created.length, 2);
  await h.at('06:40');
  assert.equal(h.created.length, 3);
  xml = await h.engine.handleGather(h.cidOf(h.last()), { SpeechResult: 'belum lagi boss, kejap' });
  assert.match(xml, /beritahu boss/);
  await h.flush();

  assert.equal(h.flow(ali.id, 'out').result, 'not_out');
  const ownerCall = h.callsTo(OWNER)[0];
  assert.ok(ownerCall, 'boss called');
  assert.match(ownerCall.twiml, /Ali masih belum keluar/);
  assert.match(ownerCall.twiml, /Masa keluar sepatutnya pukul enam setengah pagi/);
});

test('dah keluar check: problem -> boss called right away with what driver said', async () => {
  const h = setup();
  const ali = withDriver(h, { wakeTime: '' });
  await h.at('06:30');
  const xml = await h.engine.handleGather(h.cidOf(h.last()), { SpeechResult: 'tayar lori pancit' });
  assert.match(xml, /saya beritahu boss sekarang/);
  await h.flush();
  assert.equal(h.flow(ali.id, 'out').result, 'problem');
  const ownerCall = h.callsTo(OWNER)[0];
  assert.match(ownerCall.twiml, /Ali kata ada masalah/);
  assert.match(ownerCall.twiml, /Dia sebut: tayar lori pancit/);
});

test('dah keluar check: unclear answer -> asks again, then counts as no answer', async () => {
  const h = setup();
  const ali = withDriver(h, { wakeTime: '' });
  await h.at('06:30');
  const cid = h.cidOf(h.last());
  let xml = await h.engine.handleGather(cid, { SpeechResult: 'hmm apa' });
  assert.match(xml, /Maaf, saya tak faham/);
  assert.match(xml, /<Gather/);
  xml = await h.engine.handleGather(cid, { Digits: '9' });
  assert.match(xml, /masih tak faham/);
  h.engine.handleStatus(cid, 'completed');
  assert.equal(h.flow(ali.id, 'out').state, 'scheduled');
  assert.equal(h.flow(ali.id, 'out').attempts, 1);
});

test('dah keluar check: no answer 3 times -> boss called', async () => {
  const h = setup();
  const ali = withDriver(h, { wakeTime: '' });
  for (const t of ['06:30', '06:35', '06:40']) {
    await h.at(t);
    h.engine.handleStatus(h.cidOf(h.last()), 'no-answer');
  }
  await h.flush();
  assert.equal(h.flow(ali.id, 'out').result, 'no_answer');
  assert.match(h.callsTo(OWNER)[0].twiml, /tak angkat bila saya telefon tanya dah keluar/);
});

test('check call waits while the wake-up call is still retrying', async () => {
  const h = setup();
  const ali = withDriver(h, { wakeTime: '05:30', outTime: '05:32' });
  await h.at('05:30');
  h.engine.handleStatus(h.cidOf(h.last()), 'no-answer');
  await h.at('05:33');
  assert.equal(h.created.length, 1, 'no check call yet');
  await h.at('05:35');
  assert.equal(h.created.length, 2);
  assert.match(h.last().twiml, /bangun tidur/);
  await h.engine.handleGather(h.cidOf(h.last()), { Digits: '1' });
  h.engine.handleStatus(h.cidOf(h.last()), 'completed');
  await h.at('05:35');
  assert.equal(h.created.length, 3);
  assert.match(h.last().twiml, /Dah keluar ke belum/);
  assert.equal(h.flow(ali.id, 'out').state, 'calling');
});

test('server started late: within 30 min still calls, later marks missed', async () => {
  const h = setup({ startAt: KL('05:50') });
  const ali = withDriver(h);
  await h.at('05:50');
  assert.equal(h.created.length, 1, 'still calls 20 min late');

  const h2 = setup();
  const bob = withDriver(h2);
  await h2.at('06:15');
  assert.equal(h2.created.length, 0);
  assert.equal(h2.flow(bob.id, 'wake').state, 'missed');
  await h2.at('06:30');
  assert.equal(h2.created.length, 1, 'check call still happens');
  assert.ok(ali);
});

test('restart in the middle of a call: picks up where it left off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drv-'));
  const file = path.join(dir, 'db.json');
  const h = setup({ storePath: file });
  const ali = withDriver(h);
  await h.at('05:30');
  const cid = h.cidOf(h.last());

  // new process
  const config = load({ PUBLIC_URL: 'https://calls.example.com', OWNER_PHONE: OWNER });
  const store = createStore(file);
  const created = [];
  const clock = { t: KL('05:31') };
  const client = { calls: { create: async (o) => (created.push(o), { sid: 'X' }) } };
  const engine = createEngine({ config, store, client, now: () => clock.t, log: quietLog });
  await engine.tick();
  assert.equal(created.length, 0, 'does not double-call');
  engine.handleStatus(cid, 'no-answer');
  assert.equal(store.data.days['2026-11-09'][ali.id].wake.state, 'scheduled');
  clock.t = KL('05:36');
  await engine.tick();
  assert.equal(created.length, 1);
});

test('Twilio never reports back: treated as no answer after 4 minutes', async () => {
  const h = setup();
  const ali = withDriver(h);
  await h.at('05:30');
  await h.at('05:33');
  assert.equal(h.flow(ali.id, 'wake').state, 'calling');
  await h.at('05:35');
  assert.equal(h.flow(ali.id, 'wake').state, 'scheduled');
  await h.at('05:40');
  assert.equal(h.created.length, 2);
});

test('Twilio error counts as a failed try and still reaches the boss', async () => {
  const h = setup();
  const ali = withDriver(h);
  h.setFail(true);
  await h.at('05:30');
  assert.equal(h.flow(ali.id, 'wake').state, 'scheduled');
  await h.at('05:35');
  await h.at('05:40');
  assert.equal(h.flow(ali.id, 'wake').result, 'no_answer');
  assert.equal(h.callsTo(OWNER).length, 0, 'boss call also failed while Twilio was down');
  h.setFail(false);
  await h.at('05:43');
  assert.equal(h.callsTo(OWNER).length, 1, 'boss call retried once Twilio is back');
});

test('working days, day off and different times', async () => {
  const h = setup();
  const ali = withDriver(h, { days: [1, 2, 3, 4, 5, 6] });
  // Sunday 8 Nov: not a working day
  await h.at('05:30', '2026-11-08');
  assert.equal(h.created.length, 0);

  h.clock.t = KL('04:00');
  h.engine.setOverride('2026-11-09', ali.id, { off: true });
  await h.at('05:30');
  await h.at('06:30');
  assert.equal(h.created.length, 0, 'day off');

  h.engine.setOverride('2026-11-09', ali.id, { wakeTime: '07:00', outTime: '08:00' });
  await h.at('06:45');
  assert.equal(h.created.length, 0);
  await h.at('07:00');
  assert.equal(h.created.length, 1, 'new time used');

  // Sunday override makes him work
  h.engine.setOverride('2026-11-15', ali.id, { wakeTime: '06:00', outTime: '' });
  await h.at('06:00', '2026-11-15');
  assert.equal(h.created.length, 2);
});

test('paused -> no driver calls', async () => {
  const h = setup();
  withDriver(h);
  h.engine.setPaused(true);
  await h.at('05:30');
  assert.equal(h.created.length, 0);
});

test('test calls do not change today\'s progress', async () => {
  const h = setup();
  const ali = withDriver(h);
  h.clock.t = KL('05:00');
  await h.engine.testCall(ali.id, 'out');
  assert.match(h.last().twiml, /Ini panggilan ujian sahaja/);
  const xml = await h.engine.handleGather(h.cidOf(h.last()), { Digits: '3' });
  assert.match(xml, /Ini panggilan ujian sahaja/);
  h.engine.handleStatus(h.cidOf(h.last()), 'completed');
  await h.flush();
  assert.equal(h.callsTo(OWNER).length, 0, 'test problem does not call boss');
  await h.at('05:30');
  assert.equal(h.flow(ali.id, 'wake').state, 'calling', 'real wake-up still happens');
});

test('two alerts at the same time become one call to the boss', async () => {
  const h = setup();
  const ali = withDriver(h, { wakeTime: '' });
  const bob = h.engine.addDriver({ name: 'Bob', phone: '0198887777', outTime: '06:30' });
  await h.at('06:30');
  const calls = h.created.slice();
  assert.equal(calls.length, 2);
  // Hold the boss's phone line busy with an earlier alert
  h.engine.alertOwner('Mesej pertama.', {});
  await h.flush();
  const first = h.last();
  for (const c of calls) await h.engine.handleGather(h.cidOf(c), { Digits: '3' });
  await h.flush();
  assert.equal(h.callsTo(OWNER).length, 1, 'waits for the line');
  h.engine.handleStatus(h.cidOf(first), 'completed');
  await h.flush();
  await h.engine.tick();
  const ownerCalls = h.callsTo(OWNER);
  assert.equal(ownerCalls.length, 2);
  assert.match(ownerCalls[1].twiml, /Ali kata ada masalah/);
  assert.match(ownerCalls[1].twiml, /Bob kata ada masalah/);
  assert.ok(ali && bob);
});

test('call now restarts today\'s call', async () => {
  const h = setup();
  const ali = withDriver(h);
  for (const t of ['05:30', '05:35', '05:40']) {
    await h.at(t);
    h.engine.handleStatus(h.cidOf(h.last()), 'no-answer');
  }
  await h.flush();
  assert.equal(h.flow(ali.id, 'wake').state, 'alerted');
  await h.engine.callNow(ali.id, 'wake');
  assert.equal(h.flow(ali.id, 'wake').state, 'calling');
  assert.equal(h.flow(ali.id, 'wake').attempts, 1);
  await assert.rejects(() => h.engine.callNow(ali.id, 'out'), /Already calling/);
});

test('English driver gets English calls; boss can choose English', async () => {
  const h = setup({ env: { OWNER_LANG: 'en' } });
  withDriver(h, { lang: 'en', wakeTime: '' });
  await h.at('06:30');
  assert.match(h.last().twiml, /Have you left yet/);
  assert.match(h.last().twiml, /language="en-US"/);
  await h.engine.handleGather(h.cidOf(h.last()), { Digits: '3' });
  await h.flush();
  assert.match(h.callsTo(OWNER)[0].twiml, /Ali reports a problem/);
  assert.match(h.callsTo(OWNER)[0].twiml, /zero, one, two/);
});

test('driver details are checked', () => {
  const h = setup();
  assert.throws(() => h.engine.addDriver({ name: '', phone: '123' }), /Name is needed.*Phone number looks wrong/);
  assert.throws(() => h.engine.addDriver({ name: 'A', phone: '0123456789', wakeTime: '06:00', outTime: '05:00' }), /must be after/);
  assert.throws(() => h.engine.addDriver({ name: 'A', phone: '0123456789' }), /Set a wake-up time/);
  assert.throws(() => h.engine.addDriver({ name: 'A', phone: '0123456789', wakeTime: '06:00', days: [] }), /working day/);
  const d = h.engine.addDriver({ name: 'A', phone: '+60 12-345 6789', wakeTime: '06:00' });
  assert.equal(d.phone, '+60123456789');
  assert.throws(() => h.engine.setOverride('2026-11-01', d.id, { off: true }), /passed/);
});

test('dry run prints calls and pretends nobody answered', async () => {
  const lines = [];
  const config = load({ DRY_RUN: 'true', OWNER_PHONE: OWNER });
  const store = createStore(null);
  const clock = { t: KL('05:30') };
  const engine = createEngine({ config, store, client: null, now: () => clock.t, log: { ...quietLog, info: (s) => lines.push(s) } });
  const ali = engine.addDriver({ name: 'Ali', phone: '0123456789', wakeTime: '05:30' });
  await engine.tick();
  assert.match(lines[0], /DRY RUN.*\+60123456789/s);
  assert.match(lines[0], /Selamat pagi Ali/);
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(store.data.days['2026-11-09'][ali.id].wake.state, 'scheduled');
});
