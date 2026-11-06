// The calling services. Both take the same call details and place the call.
//
// The engine gives each call:
//   to, from        phone numbers in +60... format
//   twiml           what the call says (TwiML / TeXML: both use the same format)
//   url             a link on this server that returns that same script
//   statusCallback  a link the service calls when the call ends
//   timeout         seconds to ring
const twilio = require('twilio');

function twilioProvider({ accountSid, authToken }) {
  const client = twilio(accountSid, authToken);
  return {
    name: 'Twilio',
    calls: {
      create: (o) =>
        client.calls.create({
          to: o.to,
          from: o.from,
          twiml: o.twiml,
          timeout: o.timeout,
          statusCallback: o.statusCallback,
          statusCallbackMethod: 'POST',
          statusCallbackEvent: ['completed'],
        }),
    },
  };
}

function shorten(text, n = 300) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Explain common Telnyx errors in plain words. */
function telnyxHint(status, text) {
  const t = String(text || '').toLowerCase();
  if (status === 401 || status === 403) {
    if (/verif|level|international|not allowed|permission|whitelist|destination/.test(t)) {
      return 'Telnyx has not allowed this call yet. Finish account verification (Level 2) and allow Malaysia in your Outbound Voice Profile.';
    }
    return 'Telnyx rejected the API key. Check TELNYX_API_KEY.';
  }
  if (status === 404) return 'Telnyx could not find the TeXML application. Check TELNYX_APP_ID (and TELNYX_ACCOUNT_SID if you set it).';
  if (status === 402 || /balance|insufficient|credit/.test(t)) return 'Your Telnyx balance is too low. Top up your account.';
  if (/outbound voice profile|outbound_voice_profile/.test(t)) return 'Attach an Outbound Voice Profile (with Malaysia allowed) to your TeXML application.';
  if (/from|caller|number/.test(t) && status === 422) return 'Check TELNYX_FROM_NUMBER is a number you bought in Telnyx, in + format, and assigned to your TeXML application.';
  return '';
}

function telnyxProvider({ apiKey, appId, accountSid }, fetchImpl = (...a) => fetch(...a)) {
  return {
    name: 'Telnyx',
    calls: {
      async create(o) {
        // Newer address needs your account SID; the older one only needs the application ID.
        const endpoint = accountSid
          ? `https://api.telnyx.com/v2/texml/Accounts/${encodeURIComponent(accountSid)}/Calls`
          : `https://api.telnyx.com/v2/texml/calls/${encodeURIComponent(appId)}`;
        const body = {
          To: o.to,
          From: o.from,
          Url: o.url,
          UrlMethod: 'POST',
          StatusCallback: o.statusCallback,
          StatusCallbackMethod: 'POST',
          StatusCallbackEvent: 'completed',
          Timeout: Math.min(120, Math.max(5, Number(o.timeout) || 30)),
        };
        if (accountSid) body.ApplicationSid = appId;

        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) {
          const hint = telnyxHint(res.status, text);
          throw new Error(`Telnyx said ${res.status}: ${shorten(text)}${hint ? ` (${hint})` : ''}`);
        }
        let data = {};
        try {
          data = JSON.parse(text);
        } catch (e) {
          // not JSON; fine
        }
        const d = data.data || data;
        return { sid: d.call_sid || d.sid || d.CallSid || 'telnyx' };
      },
    },
  };
}

/** The calling service from your settings, or null if it isn't set up yet. */
function makeProvider(config, fetchImpl) {
  if (config.dryRun) return null;
  if (config.provider === 'telnyx') {
    const { apiKey, appId, from } = config.telnyx;
    return apiKey && appId && from ? telnyxProvider(config.telnyx, fetchImpl) : null;
  }
  const { accountSid, authToken, from } = config.twilio;
  return accountSid && authToken && from ? twilioProvider(config.twilio) : null;
}

/** Which settings are still missing for the chosen calling service. */
function missingProviderSettings(config) {
  if (config.provider === 'telnyx') {
    const t = config.telnyx;
    return [!t.apiKey && 'TELNYX_API_KEY', !t.appId && 'TELNYX_APP_ID', !t.from && 'TELNYX_FROM_NUMBER'].filter(Boolean);
  }
  const t = config.twilio;
  return [!t.accountSid && 'TWILIO_ACCOUNT_SID', !t.authToken && 'TWILIO_AUTH_TOKEN', !t.from && 'TWILIO_FROM_NUMBER'].filter(Boolean);
}

module.exports = { makeProvider, missingProviderSettings, telnyxProvider, twilioProvider, telnyxHint };
