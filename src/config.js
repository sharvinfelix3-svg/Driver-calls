// All settings come from environment variables (.env on your computer,
// or the "Variables" screen on your host). See .env.example.
require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const { normalizePhone } = require('./phone');

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

// Default voices for each calling service
const VOICE_DEFAULTS = {
  twilio: { ms: 'Google.ms-MY-Standard-A', en: 'Google.en-US-Standard-C' },
  telnyx: { ms: 'Azure.ms-MY-YasminNeural', en: 'Azure.en-US-JennyNeural' },
  vonage: { ms: 'vonage', en: 'vonage' }, // Vonage picks the voice from the language
};
const NAMES = { twilio: 'Twilio', telnyx: 'Telnyx', vonage: 'Vonage' };

/** Warn if Railway has no storage attached, so a restart would wipe the drivers list. */
function storageWarning(env, dataDir) {
  const onRailway = !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);
  if (!onRailway) return '';
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH || '';
  if (!mount) return 'No Railway Volume attached. Drivers and settings will be lost when Railway restarts. Attach a Volume with mount path /data.';
  const dir = path.resolve(dataDir);
  const m = path.resolve(mount);
  if (dir !== m && !dir.startsWith(m + path.sep)) return `Set DATA_DIR to ${mount} (your Volume), or drivers will be lost when Railway restarts.`;
  return '';
}

function load(env = process.env) {
  // Which calling service to use. CALL_PROVIDER wins; otherwise it follows which keys are filled in.
  const asked = String(env.CALL_PROVIDER || '').toLowerCase();
  const provider = NAMES[asked]
    ? asked
    : env.TELNYX_API_KEY
      ? 'telnyx'
      : env.VONAGE_APPLICATION_ID
        ? 'vonage'
        : 'twilio';
  const dataDir = env.DATA_DIR || './data';
  const adminToken = env.ADMIN_TOKEN || '';
  // Secret added to every link the calling service calls back on, so nobody else can fake answers.
  const webhookKey =
    env.WEBHOOK_KEY || (adminToken ? crypto.createHmac('sha256', adminToken).update('driver-calls-webhook').digest('hex').slice(0, 24) : '');

  return {
    port: num(env.PORT, 3000),
    publicUrl: String(env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    adminToken,
    webhookKey,
    dataDir,
    storageWarning: storageWarning(env, dataDir),
    timezone: env.TIMEZONE || 'Asia/Kuala_Lumpur',
    companyName: env.COMPANY_NAME || 'Pacific Venture Logistics',
    dryRun: bool(env.DRY_RUN, false),
    validateTwilioSignature: bool(env.VALIDATE_TWILIO_SIGNATURE, true),

    provider,
    providerName: NAMES[provider],
    // The number your drivers see calling them
    // (Vonage trial: 12345678901 is Vonage's test caller ID, which can only call your own number)
    callerId:
      (provider === 'telnyx' ? env.TELNYX_FROM_NUMBER : provider === 'vonage' ? env.VONAGE_FROM_NUMBER || '12345678901' : env.TWILIO_FROM_NUMBER) || '',
    ringSeconds: num(env.RING_SECONDS, 40),
    // Let drivers answer by speaking as well as pressing keys
    speechInput: bool(env.SPEECH_INPUT, provider === 'twilio'),

    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || '',
      authToken: env.TWILIO_AUTH_TOKEN || '',
      from: env.TWILIO_FROM_NUMBER || '',
    },

    vonage: {
      appId: env.VONAGE_APPLICATION_ID || '',
      from: env.VONAGE_FROM_NUMBER || '',
      // Either paste the key here, or upload private.key on the phone page (saved in DATA_DIR)
      privateKey: String(env.VONAGE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim(),
      keyFile: path.resolve(dataDir, 'vonage-private.key'),
      styleMs: env.VONAGE_STYLE_MS || '',
      styleEn: env.VONAGE_STYLE_EN || '',
    },

    telnyx: {
      apiKey: env.TELNYX_API_KEY || '',
      appId: env.TELNYX_APP_ID || '',
      accountSid: env.TELNYX_ACCOUNT_SID || '',
      from: env.TELNYX_FROM_NUMBER || '',
    },

    owner: {
      // 0146472974 -> +60146472974 (calling services need the country code)
      phone: normalizePhone(env.OWNER_PHONE) || String(env.OWNER_PHONE || '').trim(),
      lang: env.OWNER_LANG === 'en' ? 'en' : 'ms',
    },

    voices: {
      ms: { voice: env.VOICE_MS || VOICE_DEFAULTS[provider].ms, language: 'ms-MY', speech: env.SPEECH_LANG_MS || 'ms-MY' },
      en: { voice: env.VOICE_EN || VOICE_DEFAULTS[provider].en, language: 'en-US', speech: env.SPEECH_LANG_EN || 'en-US' },
    },

    rules: {
      // Wake-up call: how many tries before calling the boss, and the gap between tries
      wakeMaxAttempts: num(env.WAKE_MAX_ATTEMPTS, 3),
      wakeRetryMinutes: num(env.WAKE_RETRY_MINUTES, 5),
      // "Dah keluar?" call
      outMaxAttempts: num(env.OUT_MAX_ATTEMPTS, 3),
      outRetryMinutes: num(env.OUT_RETRY_MINUTES, 5),
      outRecheckMinutes: num(env.OUT_RECHECK_MINUTES, 10),
      outMaxNotYet: num(env.OUT_MAX_NOT_YET, 2),
      // If the server was down at call time, still call if it's no later than this
      catchUpMinutes: num(env.CATCH_UP_MINUTES, 30),
      // Calls to the boss
      ownerRetries: num(env.OWNER_CALL_RETRIES, 2),
      ownerRetryMinutes: num(env.OWNER_RETRY_MINUTES, 3),
      // If the calling service never reports a call ended, treat it as unanswered after this long
      callStaleMinutes: num(env.CALL_STALE_MINUTES, 4),
    },

    ai: {
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.MODEL || 'claude-haiku-5-5',
      timeoutMs: num(env.AI_TIMEOUT_MS, 4000),
    },
  };
}

module.exports = { load };
