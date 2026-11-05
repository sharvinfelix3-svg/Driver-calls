# Going live

About 30 minutes. You need: your Twilio account (the same one as the aircooler agent is fine), a host that stays on 24/7, and your drivers' numbers.

> **Important:** the host must never sleep. Free plans that sleep when nobody visits (e.g. Render free) will miss 5am calls. Railway with a paid plan, or any always-on server, is fine.

## 1. Twilio

1. Log in at console.twilio.com.
2. **Allow calls to Malaysia:** Voice → Settings → Geo permissions → tick **Malaysia** → Save.
3. Copy your **Account SID** and **Auth Token** (home page of the console).
4. Use the phone number you already have, or buy one (any country with voice works for calling out).
5. If your account is still a **trial**, upgrade it. Trial accounts play a "trial account" message before every call and can only call numbers you've verified.

Quick check from your computer (after filling in `.env`):

```bash
npm install
npm run test-call            # calls OWNER_PHONE
npm run test-call -- 0123456789
```

If you hear the Malay voice, Twilio is ready.

## 2. Put it online (Railway)

1. Create a new **service** from this folder (connect a GitHub repo, or use `railway up`). You can add it to the same project as the aircooler agent as a separate service.
2. Add a **Volume** to the service with mount path **`/data`**. This keeps the drivers list and today's progress safe through restarts.
3. Under **Settings → Networking**, generate a public domain, e.g. `driver-calls.up.railway.app`.
4. Under **Variables**, add:

| Variable | Value |
|---|---|
| `PUBLIC_URL` | `https://driver-calls.up.railway.app` (your domain, with https, no slash at the end) |
| `ADMIN_TOKEN` | a long password you make up |
| `DATA_DIR` | `/data` |
| `TWILIO_ACCOUNT_SID` | from step 1 |
| `TWILIO_AUTH_TOKEN` | from step 1 |
| `TWILIO_FROM_NUMBER` | your Twilio number, e.g. `+12025550123` |
| `OWNER_PHONE` | your mobile, e.g. `0146472974` or `+60146472974` |
| `ANTHROPIC_API_KEY` | optional, the same key as the aircooler agent |

Everything else has sensible defaults (see `.env.example`).

5. Deploy. The logs should say `Driver call system running` with nothing listed under "Not set yet".

## 3. Set up on your phone

1. Open `https://your-domain/admin` and sign in with `ADMIN_TOKEN`.
2. Add it to your home screen (Share → Add to Home Screen) so it opens like an app.
3. **Controls → Test call to my phone.** Press 1 when it rings. The log should say "You confirmed the alert call".
4. **Drivers → + Add driver** for each driver: name (the call says it out loud, so use what he's called), number, language, wake-up time, check time, working days.
5. Press **Test wake-up call** and **Test check call** for each driver while he's with you. Test calls never change today's progress and never call you.

## 4. Tell your drivers

Send them the Twilio number and ask them to **save it as a contact** (e.g. "Wake-up Call PVL") so their phone doesn't block it as spam. Then WhatsApp them something like:

> Mulai esok, sistem akan telefon untuk kejut bangun dan tanya dah keluar ke belum. Nombor: +1 xxx xxx xxxx (sila save).
> • Panggilan bangun: angkat dan tekan mana-mana nombor.
> • Panggilan "dah keluar?": tekan 1 = dah keluar, 2 = belum, 3 = ada masalah. Boleh cakap juga.
> Kalau tak angkat 3 kali, boss akan dapat panggilan.

## Day-to-day

- **Driver off tomorrow:** Today tab → Tomorrow → *Off tomorrow*.
- **Different time or a Sunday job:** Changes tab.
- **Public holiday, no jobs:** Controls → *Pause*. Remember to *Resume*.
- **You got an alert and sorted it out:** nothing to do. Use *Wake-up call now* or *Check call now* if you want the system to check again.

## If something's wrong

| Problem | Fix |
|---|---|
| Phone page says "Server setup not finished" | A variable is missing; it names which. |
| Calls go out but keypresses do nothing | `PUBLIC_URL` must be exactly your https domain. The logs will say "bad signature" if it doesn't match. |
| "Twilio said: ... permission" in logs | Turn on Malaysia in Twilio Geo permissions. |
| Calls stopped after a redeploy and drivers vanished | The volume isn't mounted at `/data`, or `DATA_DIR` isn't `/data`. |
| Log says "Skipped ... system was off" | The server was down at call time for more than 30 minutes. Check your host. |
