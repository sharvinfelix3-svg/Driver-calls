// Phone number helpers (Malaysian numbers by default).

/** '012-212 1624' -> '+60122121624'. Returns '' if it doesn't look like a phone number. */
function normalizePhone(input) {
  let s = String(input || '').trim();
  const plus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return '';
  if (plus) return /^\d{8,15}$/.test(s) ? `+${s}` : '';
  if (!s.startsWith('60')) {
    if (!s.startsWith('0')) return '';
    s = `6${s}`;
  }
  return /^60\d{8,11}$/.test(s) ? `+${s}` : '';
}

/** '+60122121624' -> '0122121624' (how Malaysians say it) */
function localNumber(e164) {
  const s = String(e164 || '');
  return s.startsWith('+60') ? `0${s.slice(3)}` : s.replace(/^\+/, '');
}

const MS_DIGITS = ['kosong', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'lapan', 'sembilan'];
const EN_DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** Read a number digit by digit, e.g. 'kosong satu dua ...' */
function spellDigits(e164, lang) {
  const words = lang === 'en' ? EN_DIGITS : MS_DIGITS;
  return localNumber(e164)
    .replace(/\D/g, '')
    .split('')
    .map((d) => words[Number(d)])
    .join(', ');
}

module.exports = { normalizePhone, localNumber, spellDigits };
