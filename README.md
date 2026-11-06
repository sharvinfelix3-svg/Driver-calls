# Driver Wake-up & "Dah Keluar?" Calls

Phones your lorry drivers every working morning (through Vonage, Telnyx or Twilio), checks they're on the road, and phones **you** only when something is wrong.

## What happens each morning

**1. Wake-up call** at the driver's wake-up time
> "Selamat pagi Ravi. Ini panggilan bangun tidur dari Empire Creation. Sekarang pukul lima setengah pagi. Tekan mana-mana nombor untuk sahkan awak dah bangun."

- Presses any key → "Bagus. Ingat, keluar pukul enam setengah pagi." Done.
- No answer (or answers and says nothing) → **calls again straight away, non-stop**. After 3 missed calls **you get a call**, and it keeps calling him until he answers (stops after 20 calls).

**2. "Dah keluar?" call** at the driver's check time
> "Helo Ravi. Dah keluar ke belum? Kalau dah keluar, tekan satu. Kalau belum, tekan dua. Kalau ada masalah, tekan tiga."

| Driver answers | What happens |
|---|---|
| **1** / "dah keluar", "otw" | "Hati-hati memandu." Done. |
| **2** / "belum", "kejap" | Calls back in 10 minutes. Second "belum" → **you get a call**. |
| **3** / "lori rosak", "tayar pancit" | **You get a call right away**, with what he said. |
| No answer | Calls again straight away. After 3 misses **you get a call**, and it keeps calling (up to 20). |

Spoken answers (the words in quotes) work when `SPEECH_INPUT=true`. That's on by default with Twilio and off with Vonage and Telnyx, where keypresses are the reliable way.

**Your alert call** says who, what happened, and reads out the driver's number. Press 1 to confirm. If you don't, it tries 2 more times.

The check call waits until the wake-up call is finished, and only one call goes to each person at a time. If two alerts happen together, you get one call with both.

**3. Lorry engine check** (optional, needs GPS connected)
Set a lorry plate and an "enjin hidup by" time for a driver. At that time the system asks the GPS whether the engine is on.
- Engine ON → nothing to do.
- Engine OFF → **you get a call** ("Lori B S N 4 6 3 1, enjin belum hidup") and the driver gets the "dah keluar?" call straight away.
- If a driver presses 1 ("dah keluar") but the engine is still off 3 minutes later → **you get a call**.

Until the GPS is connected, the times are saved and the page shows "GPS not connected".

## Your phone page (`/admin`)

- **Today**: live status for every driver (awake, dah keluar, belum, no answer), a button to call them yourself, and buttons to start a wake-up or check call now.
- **Tomorrow**: one tap for "Off tomorrow".
- **Drivers**: add drivers with their own times, working days and call language (Melayu or English). There's a test button for each call type.
- **Changes**: a day off or different times for any date. Changed times also work on a normal day off.
- **Pause** all calls for public holidays, and a **test call to your phone**.

## Run it on your computer (no real calls)

```bash
npm install
cp .env.example .env      # set ADMIN_TOKEN at least
npm run dry               # open http://localhost:3000/admin
npm test                  # 45 automated tests
```

Going live: see **SETUP.md**.

## Files

- `src/engine.js`: who to call and when, retries, alerts
- `src/messages.js`: **everything the calls say** (edit wording here)
- `src/classify.js`: understanding "dah / belum / masalah"
- `src/providers.js`: Vonage, Telnyx and Twilio (the calling services)
- `src/server.js`: web server for the calling service and the phone page
- `public/admin.html`: the phone page
