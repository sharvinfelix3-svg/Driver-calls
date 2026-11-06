const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../src/config');
const { telnyxProvider, makeProvider, missingProviderSettings } = require('../src/providers');

test('picks Telnyx automatically when its key is set', () => {
  assert.equal(load({}).provider, 'twilio');
  assert.equal(load({ TELNYX_API_KEY: 'k' }).provider, 'telnyx');
  assert.equal(load({ TELNYX_API_KEY: 'k', CALL_PROVIDER: 'twilio' }).provider, 'twilio');
  assert.equal(load({ CALL_PROVIDER: 'Telnyx' }).provider, 'telnyx');
  const c = load({ TELNYX_API_KEY: 'k', TELNYX_FROM_NUMBER: '+12025550123' });
  assert.equal(c.callerId, '+12025550123');
  assert.equal(c.voices.ms.voice, 'Azure.ms-MY-YasminNeural');
  assert.deepEqual(missingProviderSettings(c), ['TELNYX_APP_ID']);
  assert.equal(makeProvider(c), null, 'not set up until all three are filled in');
  assert.ok(makeProvider(load({ TELNYX_API_KEY: 'k', TELNYX_APP_ID: 'a', TELNYX_FROM_NUMBER: '+1' })));
});

test('webhook key comes from ADMIN_TOKEN unless set', () => {
  const a = load({ ADMIN_TOKEN: 'pw1' }).webhookKey;
  const b = load({ ADMIN_TOKEN: 'pw2' }).webhookKey;
  assert.equal(a.length, 24);
  assert.notEqual(a, b);
  assert.equal(load({ ADMIN_TOKEN: 'pw1', WEBHOOK_KEY: 'mine' }).webhookKey, 'mine');
  assert.equal(load({}).webhookKey, '');
});

test('Telnyx: uses the newer address when TELNYX_ACCOUNT_SID is set', async () => {
  let sent;
  const p = telnyxProvider({ apiKey: 'K', appId: 'APP', accountSid: 'ACC' }, async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, text: async () => '{"from":"+1","to":"+60","status":"queued"}' };
  });
  const res = await p.calls.create({ to: '+60123', from: '+1', url: 'https://x/voice/twiml?cid=1', statusCallback: 'https://x/voice/status?cid=1', timeout: 200 });
  assert.equal(sent.url, 'https://api.telnyx.com/v2/texml/Accounts/ACC/Calls');
  assert.equal(sent.body.ApplicationSid, 'APP');
  assert.equal(sent.body.Timeout, 120, 'capped at Telnyx maximum');
  assert.equal(res.sid, 'telnyx');
});

test('Telnyx errors are explained', async () => {
  const fail = (status, text) =>
    telnyxProvider({ apiKey: 'K', appId: 'APP' }, async () => ({ ok: false, status, text: async () => text })).calls.create({ to: '+60', from: '+1', timeout: 30 });
  await assert.rejects(fail(401, '{"errors":[{"title":"Authentication failed"}]}'), /Check TELNYX_API_KEY/);
  await assert.rejects(fail(403, '{"errors":[{"detail":"Destination not allowed by outbound voice profile"}]}'), /allow Malaysia/);
  await assert.rejects(fail(404, 'not found'), /TELNYX_APP_ID/);
  await assert.rejects(fail(402, 'insufficient balance'), /Top up/);
});

test('OWNER_PHONE in local format gets the country code', () => {
  assert.equal(load({ OWNER_PHONE: '0146472974' }).owner.phone, '+60146472974');
  assert.equal(load({ OWNER_PHONE: '014-647 2974' }).owner.phone, '+60146472974');
  assert.equal(load({ OWNER_PHONE: '+60146472974' }).owner.phone, '+60146472974');
  assert.equal(load({}).owner.phone, '');
});
