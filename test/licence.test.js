const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { addMonths, daysBetween } = require('../src/time');
const { setup, KL, quietLog } = require('./helpers');

const DRIVER = { name: 'Ali', phone: '0123456789', wakeTime: '05:30', outTime: '', days: [0, 1, 2, 3, 4, 5, 6] };

test('month and day helpers', () => {
  assert.equal(addMonths('2026-11-09', 1), '2026-12-09');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(daysBetween('2026-11-09', '2026-11-16'), 7);
});

test('no time limit by default: calls run, page says so', async () => {
  const h = setup();
  h.engine.addDriver(DRIVER);
  await h.at('05:30', '2027-06-01');
  assert.equal(h.created.length, 1);
  assert.deepEqual(h.engine.snapshot().licence, { limited: false, contact: '014-647 2974', whatsapp: '60146472974' });
});

test('7-day free trial: calls run until the last day, then stop', async () => {
  const h = setup();
  const d = h.engine.addDriver(DRIVER);
  const lic = h.engine.setLicence({ action: 'trial', days: 7 });
  assert.equal(lic.kind, 'trial');
  assert.equal(lic.until, '2026-11-16');
  assert.equal(lic.daysLeft, 7);
  assert.equal(lic.expired, false);

  await h.at('05:30', '2026-11-16'); // last trial day
  assert.equal(h.created.length, 1);
  assert.equal(h.engine.snapshot().licence.daysLeft, 0);

  await h.at('05:30', '2026-11-17'); // trial over
  await h.at('05:31', '2026-11-17');
  assert.equal(h.created.length, 1, 'no call after the trial ends');
  assert.equal(h.flow(d.id, 'wake', '2026-11-17'), undefined);
  assert.equal(h.engine.snapshot().licence.expired, true);
  assert.equal(h.store.data.log.filter((e) => e.event === 'licence_stopped').length, 1, 'noted once');

  // Manual and test calls are blocked too
  await assert.rejects(h.engine.callNow(d.id, 'wake'), /Free trial ended on 2026-11-16\. WhatsApp 014-647 2974/);
  await assert.rejects(h.engine.testCall(d.id, 'wake'), /Free trial ended/);
  assert.throws(() => h.engine.testOwnerCall(), /Free trial ended/);

  // Customer pays a month late: starts from today, calls come back
  const paid = h.engine.setLicence({ action: 'paid', months: 1 });
  assert.deepEqual([paid.kind, paid.until, paid.expired], ['paid', '2026-12-17', false]);
  h.clock.t = KL('05:30', '2026-11-18');
  await h.engine.tick();
  assert.equal(h.created.length, 2);
});

test('paying early adds on top; set a date; remove the limit', () => {
  const h = setup();
  h.engine.setLicence({ action: 'trial', days: 14 }); // until 2026-11-23
  assert.equal(h.engine.setLicence({ action: 'paid', months: 1 }).until, '2026-12-23');
  assert.equal(h.engine.setLicence({ action: 'paid', months: 3 }).until, '2027-03-23');
  assert.equal(h.engine.setLicence({ action: 'date', until: '2026-12-31' }).until, '2026-12-31');
  assert.equal(h.engine.setLicence({ action: 'clear' }).limited, false);
  assert.throws(() => h.engine.setLicence({ action: 'trial', days: 0 }), /1 to 90/);
  assert.throws(() => h.engine.setLicence({ action: 'paid', months: 'x' }), /1 to 36/);
  assert.throws(() => h.engine.setLicence({ action: 'date', until: 'soon' }), /end date/);
  assert.throws(() => h.engine.setLicence({ action: 'free-forever' }), /Unknown/);
});

test('only the seller password can change it, not the customer password', async () => {
  const run = async (env, fn) => {
    const h = setup({ env });
    const app = createApp({ config: h.config, engine: h.engine, log: quietLog });
    const server = await new Promise((r) => {
      const s = app.listen(0, () => r(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(h, base);
    } finally {
      server.close();
    }
  };
  const sell = (base, token, body) =>
    fetch(base + '/seller/licence', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-seller-token': token } : {}) },
      body: JSON.stringify(body),
    });

  // Not set up yet
  await run({}, async (h, base) => {
    const res = await sell(base, 'anything', { action: 'trial', days: 7 });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /SELLER_TOKEN/);
  });

  await run({ SELLER_TOKEN: 'seller-pass', SELLER_CONTACT: '012-212 1624' }, async (h, base) => {
    assert.equal((await sell(base, 'secret', { action: 'clear' })).status, 401, 'customer password does not work');
    assert.equal((await sell(base, '', { action: 'clear' })).status, 401);
    assert.equal(h.store.data.licence, null);

    const res = await sell(base, 'seller-pass', { action: 'trial', days: 14 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).until, '2026-11-23');

    const state = await (await fetch(base + '/api/state', { headers: { 'x-admin-token': 'secret' } })).json();
    assert.equal(state.licence.kind, 'trial');
    assert.equal(state.licence.daysLeft, 14);
    assert.equal(state.licence.whatsapp, '60122121624');

    const bad = await sell(base, 'seller-pass', { action: 'paid', months: 99 });
    assert.equal(bad.status, 400);

    // Guessing gets locked out
    for (let i = 0; i < 8; i++) await sell(base, 'guess', { action: 'clear' });
    const locked = await sell(base, 'seller-pass', { action: 'clear' });
    assert.equal(locked.status, 429);
    assert.equal(h.store.data.licence.kind, 'trial', 'still on trial');
  });
});
