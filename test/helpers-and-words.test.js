const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, spellDigits } = require('../src/phone');
const { localParts, sayTime, msNumber } = require('../src/time');
const { keywordClassify, classifyOutAnswer } = require('../src/classify');
const { quietLog } = require('./helpers');

test('phone numbers', () => {
  assert.equal(normalizePhone('012-212 1624'), '+60122121624');
  assert.equal(normalizePhone('60122121624'), '+60122121624');
  assert.equal(normalizePhone('+60 11-2345 6789'), '+601123456789');
  assert.equal(normalizePhone('+6591234567'), '+6591234567');
  assert.equal(normalizePhone('12345'), '');
  assert.equal(normalizePhone(''), '');
  assert.equal(spellDigits('+60122121624', 'ms'), 'kosong, satu, dua, dua, satu, dua, satu, enam, dua, empat');
});

test('Malaysia time', () => {
  const p = localParts(Date.parse('2026-11-08T21:30:00Z'), 'Asia/Kuala_Lumpur');
  assert.deepEqual(p, { date: '2026-11-09', minutes: 5 * 60 + 30, weekday: 1, hhmm: '05:30' });
});

test('saying times and numbers in Malay', () => {
  assert.equal(msNumber(10), 'sepuluh');
  assert.equal(msNumber(11), 'sebelas');
  assert.equal(msNumber(17), 'tujuh belas');
  assert.equal(msNumber(45), 'empat puluh lima');
  assert.equal(sayTime('05:30', 'ms'), 'pukul lima setengah pagi');
  assert.equal(sayTime('06:00', 'ms'), 'pukul enam pagi');
  assert.equal(sayTime('04:45', 'ms'), 'pukul empat, empat puluh lima minit pagi');
  assert.equal(sayTime('15:15', 'ms'), 'pukul tiga suku petang');
  assert.equal(sayTime('05:05', 'en'), '5:05 AM');
});

test('understanding spoken answers without AI', () => {
  const cases = {
    'dah keluar boss': 'out',
    'sudah on the way': 'out',
    'otw': 'out',
    'ya': 'out',
    'satu': 'out',
    'belum keluar lagi': 'not_yet',
    'nak keluar dah ni': 'not_yet',
    'kejap lagi': 'not_yet',
    'not yet': 'not_yet',
    'dua': 'not_yet',
    'lori rosak': 'problem',
    'tak boleh keluar anak sakit': 'problem',
    'tayar pancit': 'problem',
    'dah keluar, takde masalah': 'out',
    'already left no problem': 'out',
    'tiga': 'problem',
    'hmm apa': 'unclear',
    '': 'unclear',
  };
  for (const [said, want] of Object.entries(cases)) assert.equal(keywordClassify(said), want, said);
});

test('keypress always wins; AI is used for speech; AI failure falls back to keywords', async () => {
  const aiCfg = { apiKey: 'k', model: 'm', timeoutMs: 100 };
  let aiCalls = 0;
  const ai = async () => (aiCalls++, 'problem');
  assert.deepEqual(await classifyOutAnswer({ digits: '1', speech: 'lori rosak' }, aiCfg, { ai }), { outcome: 'out', via: 'keypad' });
  assert.equal(aiCalls, 0);
  assert.deepEqual(await classifyOutAnswer({ speech: 'aduh boss, enjin mati' }, aiCfg, { ai }), { outcome: 'problem', via: 'ai' });
  const broken = async () => {
    throw new Error('timeout');
  };
  assert.deepEqual(await classifyOutAnswer({ speech: 'dah gerak' }, aiCfg, { ai: broken, log: quietLog }), { outcome: 'out', via: 'keywords' });
  assert.deepEqual(await classifyOutAnswer({ speech: 'dah gerak' }, { apiKey: '' }), { outcome: 'out', via: 'keywords' });
});

test('AI request is shaped correctly', async () => {
  const { aiClassify } = require('../src/classify');
  let sent;
  const fakeFetch = async (url, opts) => {
    sent = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'NOT_YET' }] }) };
  };
  const out = await aiClassify('kejap boss mandi', { apiKey: 'sk-test', model: 'claude-haiku-5-5', timeoutMs: 1000 }, fakeFetch);
  assert.equal(out, 'not_yet');
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.opts.headers['x-api-key'], 'sk-test');
  assert.equal(sent.opts.headers['anthropic-version'], '2023-06-01');
  assert.equal(sent.body.model, 'claude-haiku-5-5');
  assert.match(sent.body.messages[0].content, /kejap boss mandi/);
});
