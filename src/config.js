// All settings come from environment variables (.env on your computer,
// or the "Variables" screen on your host). See .env.example.
require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

function load(env = process.env) {
  return {
    port: num(env.PORT, 3000),
    publicUrl: String(env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    adminToken: env.ADMIN_TOKEN || '',
    dataDir: env.DATA_DIR || './data',
    timezone: env.TIMEZONE || 'Asia/Kuala_Lumpur',
    companyName: env.COMPANY_NAME || 'Pacific Venture Logistics',
    dryRun: bool(env.DRY_RUN, false),
    validateTwilioSignature: bool(env.VALIDATE_TWILIO_SIGNATURE, true),

    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || '',
      authToken: env.TWILIO_AUTH_TOKEN || '',
      from: env.TWILIO_FROM_NUMBER || '',
      ringSeconds: num(env.RING_SECONDS, 40),
    },

    owner: {
      phone: env.OWNER_PHONE || '',
      lang: env.OWNER_LANG === 'en' ? 'en' : 'ms',
    },

    voices: {
      ms: { voice: env.VOICE_MS || 'Google.ms-MY-Standard-A', language: 'ms-MY', speech: env.SPEECH_LANG_MS || 'ms-MY' },
      en: { voice: env.VOICE_EN || 'Google.en-US-Standard-C', language: 'en-US', speech: env.SPEECH_LANG_EN || 'en-US' },
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
      // If Twilio never reports a call ended, treat it as unanswered after this long
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
