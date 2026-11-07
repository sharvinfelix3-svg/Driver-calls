# Going live

You need: a calling service (**Vonage**, or Telnyx / Twilio), a host that stays on 24/7 (**Railway**), and your drivers' numbers. All of it can be done from a phone browser.

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

## 2. Vonage (calling service)

Vonage's menus may look a bit different from these steps. If a screen doesn't match, send a screenshot.

1. Open the **Vonage API Dashboard** (dashboard.nexmo.com) and sign in.
2. **Applications → Create a new application**.
   - Name: `Driver calls`
   - Tap **Generate public and private key**. A file called **private.key** downloads to your phone. Keep it, and don't send it to anyone.
   - Turn on **Voice**:
     - Answer URL: `https://your-domain.up.railway.app/voice/inbound` (HTTP GET)
     - Event URL: `https://your-domain.up.railway.app/voice/events` (HTTP POST)
   - Tap **Generate new application**, then copy the **Application ID**.
3. **Railway → Variables**: add `VONAGE_APPLICATION_ID` with that ID. Railway redeploys by itself.
4. Open your **phone page → Today → Controls → Vonage key → Upload private.key** and pick the file from Downloads.
5. Tap **Test call to my phone**. On the free trial, `OWNER_PHONE` must be the number you signed up to Vonage with.

**To call your drivers** (the trial can only call your own number):

6. **Billing**: add credit.
7. **Numbers → Buy numbers**: buy one with **Voice**. A US number is fine for calling Malaysia. Link it to the `Driver calls` application.
8. **Railway → Variables**: add `VONAGE_FROM_NUMBER`, e.g. `12015550123`.

<details>
<summary>Using Telnyx instead</summary>

1. Sign up at telnyx.com, add a card, and complete **Level 2** verification (this allows calls to Malaysia).
2. **Outbound Voice Profiles → Add**, and allow **Malaysia**.
3. **TeXML Applications → Add new app**. Set the webhook URL to `https://your-domain/voice/inbound` (POST), pick the profile, and copy the app ID.
4. Buy a number with Voice and assign it to the app. Create an **API key**.
5. Railway variables: `TELNYX_API_KEY`, `TELNYX_APP_ID`, `TELNYX_FROM_NUMBER` (+ format).
</details>

<details>
<summary>Using Twilio instead</summary>

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER`. Turn on Malaysia in Twilio → Voice → Settings → Geo permissions.
</details>

## 3. Test on your phone

1. Open `https://your-domain/admin` and sign in with `ADMIN_TOKEN`. Add it to your home screen.
2. **Controls → Test call to my phone.** Press 1 when it rings. The Log tab should say "You confirmed the alert call".
3. **Drivers → + Add driver** for each driver.
4. Press **Test wake-up call** and **Test check call** for each driver while he's with you. Test calls never change today's progress and never call you.
5. Tap **Resume**.

## 4. Tell your drivers

Ask them to **save the calling number as a contact** (e.g. "Wake-up Call Empire") so their phone doesn't block it as spam. Then WhatsApp them:

> Mulai esok, sistem akan telefon untuk kejut bangun dan tanya dah keluar ke belum. Nombor: +1 xxx xxx xxxx (sila save).
> • Panggilan bangun: angkat dan tekan mana-mana nombor.
> • Panggilan "dah keluar?": tekan 1 = dah keluar, 2 = belum, 3 = ada masalah.
> Kalau tak angkat 3 kali, boss akan dapat panggilan.

## Selling to another company: free trial, then pay

Each customer gets their own copy (own link, own `ADMIN_TOKEN`). You keep the Railway login, so only you can change the time limit.

1. On the customer's copy in **Railway → Variables**, add `SELLER_TOKEN`: your own seller password, different from the customer's `ADMIN_TOKEN`. Never give it to customers. (Optional: `SELLER_CONTACT`, the number customers WhatsApp to pay. Default `014-647 2974`.)
2. Open the customer's phone page → **Today → Subscription → Seller**, type the seller password, and tap **7 days free** or **14 days free**.
3. The customer sees "Free trial · X days left". After the last day, driver calls stop and the page says "Free trial ended — WhatsApp … to continue".
4. When they pay: **Seller → +1 month** (or +3 / +12). Paid early adds on top of the end date; paid late starts from today. Calls start again on the next tick.
5. **Remove time limit** makes it run with no end date (use this for your own company).

**Without the seller password:** in **Railway → Variables** on the customer's copy, add `TRIAL_UNTIL` (e.g. `14/11/2026`) or, once they pay, `PAID_UNTIL`. It's applied when Railway redeploys, and again each time you change the value.

A copy with no trial or paid date set has no time limit.

## Day-to-day

- **Driver off tomorrow:** Today tab → Tomorrow → *Off tomorrow*.
- **Different time or a Sunday job:** Changes tab.
- **Public holiday, no jobs:** Controls → *Pause*. Remember to *Resume*.
- **You got an alert and sorted it out:** nothing to do. Use *Wake-up call now* or *Check call now* if you want the system to check again.

## If something's wrong

Check the **Log** tab first, then Railway → Driver-calls → **Deployments → View logs**. Errors from Vonage and Telnyx come with a plain-English hint.

| Problem | Fix |
|---|---|
| "Server setup not finished" | It names the missing variable. |
| Log says "only call the number you signed up with" | You're on the Vonage trial. Add credit and buy a number (steps 6–8). |
| Log says "private.key is missing" | Upload it on the phone page (Controls → Vonage key). Attach the `/data` Volume first, or it's lost on restart. |
| Log says Telnyx "has not allowed this call" | Finish Level 2 verification, and allow Malaysia in the Outbound Voice Profile. |
| Log says "could not find the TeXML application" | Check `TELNYX_APP_ID`. If Telnyx support says to use the newer call address, also set `TELNYX_ACCOUNT_SID`. |
| Phone rings but it's silent or hangs up at once | `PUBLIC_URL` must be exactly your https domain. |
| Malay voice sounds wrong | Set `VOICE_MS=Azure.ms-MY-OsmanNeural` (male voice). |
| Phone page warns "No Railway Volume attached" | Attach a Volume with mount path `/data`, and set `DATA_DIR=/data`. |
| Log says "Skipped ... system was off" | The server was down at call time for more than 30 minutes. Check Railway. |
