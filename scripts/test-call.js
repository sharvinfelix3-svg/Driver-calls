// Quick check that Twilio and the Malay voice work (Twilio only).
// Usage:  npm run test-call              (calls OWNER_PHONE)
//         npm run test-call -- 0123456789
const twilio = require('twilio');
const { load } = require('../src/config');
const { normalizePhone } = require('../src/phone');
const M = require('../src/messages');

const config = load();
if (config.provider === 'telnyx') {
  console.log('With Telnyx, use the "Test call to my phone" button on your phone page instead (it needs the server running online).');
  process.exit(0);
}
const to = normalizePhone(process.argv[2] || config.owner.phone);
const { accountSid, authToken, from } = config.twilio;

if (!accountSid || !authToken || !from) {
  console.error('Fill in TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER in .env first.');
  process.exit(1);
}
if (!to) {
  console.error('Give a phone number (npm run test-call -- 0123456789) or set OWNER_PHONE in .env.');
  process.exit(1);
}

const lang = config.owner.lang;
const v = config.voices[lang];
const r = new twilio.twiml.VoiceResponse();
r.say({ voice: v.voice, language: v.language }, M.owner[lang].test);
r.pause({ length: 1 });
r.say({ voice: v.voice, language: v.language }, M.owner[lang].test);

twilio(accountSid, authToken)
  .calls.create({ to, from, twiml: r.toString() })
  .then((call) => console.log(`Calling ${to} now (call ${call.sid}). Your phone should ring in a few seconds.`))
  .catch((e) => {
    console.error(`Twilio said: ${e.message}`);
    if (/unverified|trial/i.test(e.message)) console.error('On a Twilio trial, you can only call numbers you have verified in the Twilio console.');
    if (/permission|geo/i.test(e.message)) console.error('Turn on calls to Malaysia in Twilio: Voice > Settings > Geo permissions.');
    process.exit(1);
  });
