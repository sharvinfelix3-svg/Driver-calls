// Time helpers. Everything is worked out in the business time zone (Malaysia by default).

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map();

function fmt(tz) {
  if (!formatters.has(tz)) {
    formatters.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
        hourCycle: 'h23',
      })
    );
  }
  return formatters.get(tz);
}

/** { date: 'YYYY-MM-DD', minutes: minutes since midnight, weekday: 0=Sun..6=Sat, hhmm } */
function localParts(ms, tz) {
  const p = {};
  for (const part of fmt(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: hour * 60 + minute,
    weekday: WEEKDAYS[p.weekday],
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

function isHHMM(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- saying times and numbers out loud ----------

const MS_UNITS = ['kosong', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'lapan', 'sembilan', 'sepuluh', 'sebelas'];

/** 1..99 in Malay words */
function msNumber(n) {
  n = Math.floor(n);
  if (n < 12) return MS_UNITS[n];
  if (n < 20) return `${MS_UNITS[n - 10]} belas`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  const t = tens === 1 ? 'sepuluh' : `${MS_UNITS[tens]} puluh`;
  return ones ? `${t} ${MS_UNITS[ones]}` : t;
}

function msPeriod(h) {
  if (h < 12) return 'pagi';
  if (h < 14) return 'tengah hari';
  if (h < 19) return 'petang';
  return 'malam';
}

/** '05:30' -> 'pukul lima setengah pagi' / '5:30 AM' */
function sayTime(hhmm, lang) {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = h % 12 || 12;
  if (lang === 'en') {
    const ampm = h < 12 ? 'AM' : 'PM';
    return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  }
  const hour = msNumber(h12);
  const period = msPeriod(h);
  if (m === 0) return `pukul ${hour} ${period}`;
  if (m === 30) return `pukul ${hour} setengah ${period}`;
  if (m === 15) return `pukul ${hour} suku ${period}`;
  return `pukul ${hour}, ${msNumber(m)} minit ${period}`;
}

function greeting(hhmm, lang) {
  const h = Number(hhmm.split(':')[0]);
  if (lang === 'en') {
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }
  return `Selamat ${msPeriod(h)}`;
}

function sayCount(n, lang) {
  return lang === 'en' ? String(n) : msNumber(n);
}

module.exports = { localParts, isHHMM, toMinutes, isDate, addDays, msNumber, sayTime, greeting, sayCount };
