// Everything the calls say, in Malay (ms) and English (en).
// Edit the wording here if you want it to sound more like you.
const { sayTime, greeting, sayCount } = require('./time');
const { spellDigits } = require('./phone');

const driver = {
  ms: {
    wakeIntro: (d, nowHHMM, company) =>
      `${greeting(nowHHMM, 'ms')} ${d.name}. Ini panggilan bangun tidur dari ${company}. Sekarang ${sayTime(nowHHMM, 'ms')}.`,
    wakePrompt: 'Tekan mana-mana nombor, atau sebut, dah bangun.',
    wakeAck: (outTime) =>
      `Bagus, terima kasih. ${outTime ? `Ingat, keluar ${sayTime(outTime, 'ms')}. ` : ''}Selamat memandu.`,

    outIntro: (d, company) => `Helo ${d.name}, ini ${company}. Dah keluar ke belum?`,
    outPrompt: 'Kalau dah keluar, tekan satu. Kalau belum, tekan dua. Kalau ada masalah, tekan tiga.',
    outDone: 'Terima kasih. Hati-hati memandu. Selamat jalan.',
    outRecheck: (mins) => `Okey. Saya telefon balik dalam ${sayCount(mins, 'ms')} minit. Tolong bersiap cepat.`,
    outNotYetFinal: 'Okey. Saya akan beritahu boss. Sila keluar secepat mungkin.',
    outProblem: 'Okey, saya beritahu boss sekarang. Boss akan telefon awak sekejap lagi.',

    repeat: 'Saya ulang.',
    noInput: 'Saya tak dengar apa-apa. Saya akan telefon semula sekejap lagi.',
    unclear: 'Maaf, saya tak faham.',
    unclearFinal: 'Maaf, saya masih tak faham. Saya akan telefon semula.',
    testNote: 'Ini panggilan ujian sahaja.',
  },
  en: {
    wakeIntro: (d, nowHHMM, company) =>
      `${greeting(nowHHMM, 'en')} ${d.name}. This is your wake-up call from ${company}. The time now is ${sayTime(nowHHMM, 'en')}.`,
    wakePrompt: "Press any key, or say, I'm awake.",
    wakeAck: (outTime) => `Great, thank you. ${outTime ? `Remember, leave at ${sayTime(outTime, 'en')}. ` : ''}Drive safe.`,

    outIntro: (d, company) => `Hello ${d.name}, this is ${company}. Have you left yet?`,
    outPrompt: 'If you have left, press 1. If not yet, press 2. If there is a problem, press 3.',
    outDone: 'Thank you. Drive safe.',
    outRecheck: (mins) => `Okay. I will call you back in ${mins} minutes. Please get ready quickly.`,
    outNotYetFinal: 'Okay. I will let the boss know. Please leave as soon as possible.',
    outProblem: 'Okay, I am telling the boss now. The boss will call you shortly.',

    repeat: 'Again.',
    noInput: "I didn't hear anything. I will call you back shortly.",
    unclear: "Sorry, I didn't understand.",
    unclearFinal: "Sorry, I still didn't understand. I will call you again.",
    testNote: 'This is only a test call.',
  },
};

// What the boss hears. `n` = how many tries.
const owner = {
  ms: {
    wakeNoAnswer: (d, n) => `${d.name} tak angkat panggilan bangun tidur. Saya dah telefon ${sayCount(n, 'ms')} kali. Sila telefon dia.`,
    outNoAnswer: (d, n) =>
      `${d.name} tak angkat bila saya telefon tanya dah keluar ke belum. Saya dah cuba ${sayCount(n, 'ms')} kali. Sila telefon dia.`,
    notOut: (d, n, outTime) =>
      `${d.name} masih belum keluar. Saya dah tanya ${sayCount(n, 'ms')} kali.${outTime ? ` Masa keluar sepatutnya ${sayTime(outTime, 'ms')}.` : ''}`,
    problem: (d, said) =>
      `${d.name} kata ada masalah, belum boleh keluar.${said ? ` Dia sebut: ${said}.` : ''} Sila telefon dia sekarang.`,
    number: (d) => `Nombor ${d.name}, ${spellDigits(d.phone, 'ms')}.`,
    open: 'Helo boss.',
    ackPrompt: 'Tekan satu untuk sahkan boss dah dengar.',
    ackThanks: 'Terima kasih boss.',
    test: 'Ini panggilan ujian dari sistem panggilan pemandu. Kalau boss dengar ini, sistem dah jalan.',
  },
  en: {
    wakeNoAnswer: (d, n) => `${d.name} did not answer the wake-up call. I called ${n} times. Please give a call.`,
    outNoAnswer: (d, n) => `${d.name} did not answer when I called to check about leaving. I tried ${n} times. Please give a call.`,
    notOut: (d, n, outTime) =>
      `${d.name} has still not left. I asked ${n} times.${outTime ? ` Leaving time was ${sayTime(outTime, 'en')}.` : ''}`,
    problem: (d, said) => `${d.name} reports a problem and cannot leave yet.${said ? ` The words were: ${said}.` : ''} Please call now.`,
    number: (d) => `${d.name}'s number is ${spellDigits(d.phone, 'en')}.`,
    open: 'Hello boss.',
    ackPrompt: 'Press 1 to confirm you heard this.',
    ackThanks: 'Thank you boss.',
    test: 'This is a test call from the driver call system. If you can hear this, it is working.',
  },
};

const hints = {
  ms: {
    wake: 'dah bangun, sudah bangun, bangun, okey, ya',
    out: 'dah keluar, sudah keluar, belum, belum keluar, ada masalah, on the way, satu, dua, tiga',
  },
  en: {
    wake: "I'm awake, awake, okay, yes",
    out: 'I have left, already left, not yet, problem, on the way, one, two, three',
  },
};

module.exports = { driver, owner, hints };
