# Going live

You need: a calling service (**Telnyx**, or Twilio), a host that stays on 24/7 (**Railway**), and your drivers' numbers. All of it can be done from a phone browser.

> **Important:** the host must never sleep. Free plans that sleep when nobody visits will miss 5am calls. Railway on the Hobby plan is fine.

## 1. Railway (host)

1. railway.com → **Login with GitHub** → **New Project** → **Deploy from GitHub repo** → pick this repo.
2. Add a **Volume** to the service with mount path **`/data`**. This keeps drivers and today's progress safe through restarts.
3. **Settings → Networking → Generate Domain**, e.g. `driver-calls-production.up.railway.app`.
4. **Variables**:

| Variable | Value |
|---|---|
| `PUBLIC_URL` | `https://your-domain.up.railway.app` (https, no slash at the end) |
| `ADMIN_TOKEN` | a long password you make up |
| `DATA_DIR` | `/data` |
| `OWNER_PHONE` | your mobile, e.g. `0146472974` |

5. Switch to the **Hobby** plan before going live (the trial credit runs out).

## 2. Telnyx (calling service)

Menu names in Telnyx may differ slightly. If a screen looks different, send a screenshot.

1. **Sign up** at telnyx.com and confirm your email.
2. **Billing**: add your card and top up a small amount (e.g. US$10).
3. **Verification**: Account Settings → **Verifications** (or **Account Levels**). Complete **Level 2 / Verified**. This is what allows calls to Malaysia. Review can take up to 48 hours.
4. **Outbound Voice Profile**: Voice → **Outbound Voice Profiles** → **Add**. Name it `Driver calls`, add **Malaysia** to the allowed destinations, then save.
5. **TeXML Application**: Voice → Programmable Voice → **TeXML Applications** → **Add new app**.
   - Name: `Driver calls`
   - Webhook URL ("Send a TeXML Webhook to the URL"): `https://your-domain.up.railway.app/voice/inbound`
   - Voice method: **POST**
   - Outbound: choose the `Driver calls` Outbound Voice Profile
   - Save, then copy the app's **ID**.
6. **Buy a number**: Numbers → **Search & Buy**. Pick any country with **Voice** (a US number works for calling Malaysia) and assign it to the `Driver calls` app.
7. **API key**: Account Settings → **Keys & Credentials** → **API Keys** → **Create**. Copy it. It's shown once, and you shouldn't share it.
8. Back in **Railway → Variables**, add:

| Variable | Value |
|---|---|
| `TELNYX_API_KEY` | the key from step 7 |
| `TELNYX_APP_ID` | the app ID from step 5 |
| `TELNYX_FROM_NUMBER` | the number from step 6, in + format, e.g. `+12025550123` |

Railway redeploys by itself. The phone page's "Server setup not finished" box should disappear.

<details>
<summary>Using Twilio instead</summary>

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER` instead of the Telnyx ones. Turn on Malaysia in Twilio → Voice → Settings → Geo permissions.
</details>

## 3. Test on your phone

1. Open `https://your-domain/admin` and sign in with `ADMIN_TOKEN`. Add it to your home screen.
2. **Controls → Test call to my phone.** Press 1 when it rings. The Log tab should say "You confirmed the alert call".
3. **Drivers → + Add driver** for each driver.
4. Press **Test wake-up call** and **Test check call** for each driver while he's with you. Test calls never change today's progress and never call you.
5. Tap **Resume**.

## 4. Tell your drivers

Ask them to **save the calling number as a contact** (e.g. "Wake-up Call PVL") so their phone doesn't block it as spam. Then WhatsApp them:

> Mulai esok, sistem akan telefon untuk kejut bangun dan tanya dah keluar ke belum. Nombor: +1 xxx xxx xxxx (sila save).
> • Panggilan bangun: angkat dan tekan mana-mana nombor.
> • Panggilan "dah keluar?": tekan 1 = dah keluar, 2 = belum, 3 = ada masalah.
> Kalau tak angkat 3 kali, boss akan dapat panggilan.

## Day-to-day

- **Driver off tomorrow:** Today tab → Tomorrow → *Off tomorrow*.
- **Different time or a Sunday job:** Changes tab.
- **Public holiday, no jobs:** Controls → *Pause*. Remember to *Resume*.
- **You got an alert and sorted it out:** nothing to do. Use *Wake-up call now* or *Check call now* if you want the system to check again.

## If something's wrong

Check the **Log** tab first, then Railway → Driver-calls → **Deployments → View logs**. Errors from Telnyx come with a plain-English hint.

| Problem | Fix |
|---|---|
| "Server setup not finished" | It names the missing variable. |
| Log says Telnyx "has not allowed this call" | Finish Level 2 verification, and allow Malaysia in the Outbound Voice Profile. |
| Log says "could not find the TeXML application" | Check `TELNYX_APP_ID`. If Telnyx support says to use the newer call address, also set `TELNYX_ACCOUNT_SID`. |
| Phone rings but it's silent or hangs up at once | `PUBLIC_URL` must be exactly your https domain. |
| Malay voice sounds wrong | Set `VOICE_MS=Azure.ms-MY-OsmanNeural` (male voice). |
| Drivers vanished after a redeploy | The volume isn't mounted at `/data`, or `DATA_DIR` isn't `/data`. |
| Log says "Skipped ... system was off" | The server was down at call time for more than 30 minutes. Check Railway. |
