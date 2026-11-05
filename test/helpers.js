const { load } = require('../src/config');
const { createStore } = require('../src/store');
const { createEngine } = require('../src/engine');

// Monday 9 Nov 2026, Malaysia time (UTC+8)
const KL = (hhmm, date = '2026-11-09') => Date.parse(`${date}T${hhmm}:00+08:00`);

const quietLog = { info() {}, warn() {}, error() {}, log() {} };

function setup({ env = {}, storePath = null, startAt = KL('05:00'), classify } = {}) {
  const config = load({ PUBLIC_URL: 'https://calls.example.com', OWNER_PHONE: '+60111111111', ADMIN_TOKEN: 'secret', ...env });
  const store = createStore(storePath);
  const clock = { t: startAt };
  const created = [];
  let fail = false;
  const client = {
    calls: {
      create: async (opts) => {
        if (fail) throw new Error('Twilio down');
        created.push(opts);
        return { sid: `CA${created.length}` };
      },
    },
  };
  const engine = createEngine({ config, store, client, now: () => clock.t, log: quietLog, ...(classify ? { classify } : {}) });
  const flush = () => new Promise((r) => setImmediate(r));
  const cidOf = (call) => new URL(call.statusCallback).searchParams.get('cid');
  const last = () => created[created.length - 1];
  return {
    config,
    store,
    engine,
    clock,
    created,
    flush,
    cidOf,
    last,
    setFail: (v) => (fail = v),
    at: async (hhmm, date) => {
      clock.t = KL(hhmm, date);
      await engine.tick();
      await flush();
    },
    callsTo: (phone) => created.filter((c) => c.to === phone),
    flow: (driverId, kind, date = '2026-11-09') => store.data.days[date] && store.data.days[date][driverId] && store.data.days[date][driverId][kind],
  };
}

module.exports = { setup, KL, quietLog };
