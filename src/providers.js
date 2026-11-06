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
  if (config.provider === 'vonage') {
    // The private.key can be uploaded later on the phone page, so only the app ID is needed here
    return config.vonage.appId ? vonageProvider(config.vonage, fetchImpl) : null;
  }
  if (config.provider === 'telnyx') {
    const { apiKey, appId, from } = config.telnyx;
    return apiKey && appId && from ? telnyxProvider(config.telnyx, fetchImpl) : null;
  }
  const { accountSid, authToken, from } = config.twilio;
  return accountSid && authToken && from ? twilioProvider(config.twilio) : null;
}

/** Which settings are still missing for the chosen calling service. */
function missingProviderSettings(config) {
  if (config.provider === 'vonage') {
    return [!config.vonage.appId && 'VONAGE_APPLICATION_ID', !readVonageKey(config.vonage) && 'private.key (upload it below)'].filter(Boolean);
  }
  if (config.provider === 'telnyx') {
    const t = config.telnyx;
    return [!t.apiKey && 'TELNYX_API_KEY', !t.appId && 'TELNYX_APP_ID', !t.from && 'TELNYX_FROM_NUMBER'].filter(Boolean);
  }
  const t = config.twilio;
  return [!t.accountSid && 'TWILIO_ACCOUNT_SID', !t.authToken && 'TWILIO_AUTH_TOKEN', !t.from && 'TWILIO_FROM_NUMBER'].filter(Boolean);
}

module.exports = { makeProvider, missingProviderSettings, telnyxProvider, twilioProvider, telnyxHint };

// ---------------------------------------------------------------------------
// Vonage. It doesn't read TwiML, so the script is translated into Vonage's
// format (NCCO). When nobody presses anything, Vonage still reports back, and
// we carry on with the rest of the script (like Twilio does by itself).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');

const VONAGE_END_STATUSES = new Set(['completed', 'busy', 'cancelled', 'unanswered', 'rejected', 'failed', 'timeout']);

function decodeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseAttrs(s) {
  const out = {};
  for (const m of String(s || '').matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

/** Turn our TwiML into a simple list: say / gather / pause / hangup. */
function parseTwiml(xml) {
  const body = (String(xml).match(/<Response>([\s\S]*)<\/Response>/) || [null, ''])[1];
  const nodes = [];
  const re = /<Gather([^>]*?)\/>|<Gather([^>]*)>([\s\S]*?)<\/Gather>|<Say([^>]*)>([\s\S]*?)<\/Say>|<Pause([^>]*?)\/>|<Hangup\s*\/>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) nodes.push({ type: 'gather', attrs: parseAttrs(m[1]), says: [] });
    else if (m[2] !== undefined) {
      const says = [...m[3].matchAll(/<Say([^>]*)>([\s\S]*?)<\/Say>/g)].map((s) => ({ attrs: parseAttrs(s[1]), text: decodeXml(s[2]) }));
      nodes.push({ type: 'gather', attrs: parseAttrs(m[2]), says });
    } else if (m[4] !== undefined) nodes.push({ type: 'say', attrs: parseAttrs(m[4]), text: decodeXml(m[5]) });
    else if (m[6] !== undefined) nodes.push({ type: 'pause', attrs: parseAttrs(m[6]) });
    else nodes.push({ type: 'hangup' });
  }
  return nodes;
}

function createNccoRenderer({ styles = {} } = {}) {
  const stash = new Map(); // gid -> what comes after a keypress prompt, if nothing is pressed

  function prune() {
    const cutoff = Date.now() - 30 * 60000;
    for (const [k, v] of stash) if (v.at < cutoff) stash.delete(k);
  }

  function talk(text, attrs = {}, bargeIn = false) {
    const language = attrs.language || 'ms-MY';
    const a = { action: 'talk', text, language };
    const style = styles[language];
    if (style !== undefined && style !== '') a.style = Number(style);
    if (bargeIn) a.bargeIn = true;
    return a;
  }

  function input(attrs, gid) {
    const types = String(attrs.input || 'dtmf')
      .split(/\s+/)
      .filter((t) => t === 'dtmf' || t === 'speech');
    const action = attrs.action || '';
    const a = {
      action: 'input',
      type: types.length ? types : ['dtmf'],
      eventUrl: [`${action}${action.includes('?') ? '&' : '?'}gid=${gid}`],
      eventMethod: 'POST',
    };
    if (a.type.includes('dtmf')) a.dtmf = { maxDigits: Number(attrs.numDigits) || 1, timeOut: Math.min(10, Number(attrs.timeout) || 5), submitOnHash: false };
    if (a.type.includes('speech')) {
      a.speech = { language: attrs.language || 'ms-MY', endOnSilence: 1.5, maxDuration: 10 };
      if (attrs.hints) a.speech.context = attrs.hints.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return a;
  }

  function render(nodes) {
    prune();
    const actions = [];
    let lastLang = 'ms-MY';
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type === 'say') {
        actions.push(talk(n.text, n.attrs));
        lastLang = n.attrs.language || lastLang;
      } else if (n.type === 'hangup') break;
      else if (n.type === 'gather') {
        for (const s of n.says) {
          actions.push(talk(s.text, s.attrs, true));
          lastLang = s.attrs.language || lastLang;
        }
        const gid = crypto.randomBytes(5).toString('hex');
        stash.set(gid, { nodes: nodes.slice(i + 1), at: Date.now() });
        actions.push(input(n.attrs, gid));
        return actions;
      }
    }
    // Vonage needs at least one step; end politely
    if (!actions.length) actions.push(talk(lastLang.startsWith('en') ? 'Thank you.' : 'Terima kasih.', { language: lastLang }));
    return actions;
  }

  return {
    fromTwiml: (xml) => render(parseTwiml(xml)),
    /** Nothing was pressed: carry on with the rest of the script. */
    continueAfter(gid) {
      const s = stash.get(String(gid || ''));
      stash.delete(String(gid || ''));
      return render(s ? s.nodes : []);
    },
  };
}

/** Short-lived login token Vonage asks for (signed with your private.key). */
function vonageJwt(appId, privateKey, nowMs = Date.now()) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(nowMs / 1000);
  const data = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ application_id: appId, iat, nbf: iat - 5, exp: iat + 300, jti: crypto.randomUUID() })}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url');
  return `${data}.${sig}`;
}

function readVonageKey(vonage) {
  if (vonage.privateKey) return vonage.privateKey;
  try {
    if (vonage.keyFile && fs.existsSync(vonage.keyFile)) return fs.readFileSync(vonage.keyFile, 'utf8');
  } catch (e) {
    // fall through
  }
  return '';
}

function vonageHint(status, text) {
  const t = String(text || '').toLowerCase();
  if (/whitelist|white-list|trial|demo|not permitted|permitted destination/.test(t))
    return 'On a Vonage trial you can only call the number you signed up with. Add credit to call your drivers.';
  if (status === 401) return 'Vonage did not accept the login. Check VONAGE_APPLICATION_ID matches the private.key you uploaded.';
  if (status === 402 || /balance|credit|insufficient/.test(t)) return 'Your Vonage balance is too low. Add credit.';
  if (/from|caller|number/.test(t)) return 'Check VONAGE_FROM_NUMBER is a Vonage number you bought (or leave it empty on the trial).';
  return '';
}

function vonageProvider(vonage, fetchImpl = (...a) => fetch(...a)) {
  const ncco = createNccoRenderer({ styles: { 'ms-MY': vonage.styleMs, 'en-US': vonage.styleEn } });
  const digits = (n) => String(n || '').replace(/\D/g, '');
  return {
    name: 'Vonage',
    ncco,
    calls: {
      async create(o) {
        const key = readVonageKey(vonage);
        if (!key) throw new Error('Vonage private.key is missing. Upload it on the phone page (Controls).');
        const body = {
          to: [{ type: 'phone', number: digits(o.to) }],
          from: { type: 'phone', number: digits(o.from) },
          ncco: ncco.fromTwiml(o.twiml),
          event_url: [o.statusCallback],
          event_method: 'POST',
          ringing_timer: Math.min(120, Math.max(5, Number(o.timeout) || 40)),
          length_timer: 300,
        };
        const res = await fetchImpl('https://api.nexmo.com/v1/calls', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${vonageJwt(vonage.appId, key)}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) {
          const hint = vonageHint(res.status, text);
          throw new Error(`Vonage said ${res.status}: ${shorten(text)}${hint ? ` (${hint})` : ''}`);
        }
        let data = {};
        try {
          data = JSON.parse(text);
        } catch (e) {
          // fine
        }
        return { sid: data.uuid || 'vonage' };
      },
    },
  };
}

/** Check and save an uploaded private.key. Returns the cleaned key. */
function saveVonageKey(vonage, pem) {
  const text = String(pem || '').trim();
  try {
    const k = crypto.createPrivateKey(text);
    if (k.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
  } catch (e) {
    throw new Error("That doesn't look like a Vonage private.key file. Pick the private.key Vonage downloaded.");
  }
  fs.mkdirSync(require('path').dirname(vonage.keyFile), { recursive: true });
  fs.writeFileSync(vonage.keyFile, `${text}\n`, { mode: 0o600 });
  return true;
}

module.exports.vonageProvider = vonageProvider;
module.exports.vonageJwt = vonageJwt;
module.exports.parseTwiml = parseTwiml;
module.exports.createNccoRenderer = createNccoRenderer;
module.exports.readVonageKey = readVonageKey;
module.exports.saveVonageKey = saveVonageKey;
module.exports.vonageHint = vonageHint;
module.exports.VONAGE_END_STATUSES = VONAGE_END_STATUSES;
