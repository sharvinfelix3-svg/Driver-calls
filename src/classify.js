// Works out what a driver meant on the "dah keluar?" call.
// Keypresses are exact. Spoken answers go to Claude (if ANTHROPIC_API_KEY is set),
// with simple keyword matching as the backup.

const OUTCOMES = ['out', 'not_yet', 'problem', 'unclear'];

function fromDigits(digits) {
  const d = String(digits || '').trim().charAt(0);
  if (d === '1') return 'out';
  if (d === '2') return 'not_yet';
  if (d === '3') return 'problem';
  return d ? 'unclear' : null;
}

function keywordClassify(text) {
  let t = ` ${String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ')} `.replace(/\s+/g, ' ');
  if (!t.trim()) return 'unclear';

  // "no problem" / "takde masalah" must not count as a problem
  t = t.replace(/\b(tak ada|takde|tak de|tiada|tidak ada|no|not a|not any)\s+(masalah|problem|problems)\b/g, ' ');

  const only = t.trim();
  if (/^(1|satu|one|won)$/.test(only)) return 'out';
  if (/^(2|dua|two|to|too)$/.test(only)) return 'not_yet';
  if (/^(3|tiga|three)$/.test(only)) return 'problem';

  const PROBLEM =
    /\b(masalah|problem|rosak|breakdown|break down|pancit|puncture|accident|kemalangan|sakit|sick|emergency|kecemasan|tolong|help|tak boleh|tidak boleh|cannot|can't|cant|tak dapat|tak dapat keluar)\b/;
  const NOT_YET =
    /\b(belum|belom|blum|not yet|nanti|kejap|sekejap|jap|later|masih|tak lagi|nak keluar|nak gerak|nak jalan|about to|going to|getting ready|bersiap|siap siap|mandi)\b/;
  const OUT =
    /\b(dah|sudah|udah|da|keluar|jalan|gerak|otw|on the way|on my way|left|already|dalam perjalanan|driving|memandu|yes|ya|yup|yeah)\b/;

  if (PROBLEM.test(t)) return 'problem';
  if (NOT_YET.test(t)) return 'not_yet';
  if (OUT.test(t)) return 'out';
  return 'unclear';
}

const SYSTEM_PROMPT = [
  "You classify a lorry driver's spoken answer to the question \"Have you left for work yet?\" (asked in Malay as \"Dah keluar ke belum?\").",
  'The text is a speech-to-text transcript and may be Malay, English, Manglish or Tamil-English, with recognition mistakes.',
  'Reply with exactly one word:',
  'OUT = he has already left / is on the way.',
  'NOT_YET = he has not left yet, or is about to leave.',
  'PROBLEM = something stops him leaving (breakdown, sick, accident, emergency, cannot come).',
  'UNCLEAR = you cannot tell.',
].join('\n');

async function aiClassify(text, { apiKey, model, timeoutMs }, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 5,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Transcript: "${String(text).slice(0, 300)}"` }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}`);
    const body = await res.json();
    const word = String(body?.content?.[0]?.text || '')
      .trim()
      .toUpperCase();
    if (word.startsWith('NOT_YET') || word.startsWith('NOT')) return 'not_yet';
    if (word.startsWith('OUT')) return 'out';
    if (word.startsWith('PROBLEM')) return 'problem';
    return 'unclear';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide the answer for a "dah keluar?" call.
 * Returns { outcome: 'out'|'not_yet'|'problem'|'unclear', via: 'keypad'|'ai'|'keywords' }
 */
async function classifyOutAnswer({ digits, speech }, aiConfig, { ai = aiClassify, log = console } = {}) {
  const fromKeys = fromDigits(digits);
  if (fromKeys) return { outcome: fromKeys, via: 'keypad' };
  if (!speech || !String(speech).trim()) return { outcome: 'unclear', via: 'keywords' };
  if (aiConfig && aiConfig.apiKey) {
    try {
      const outcome = await ai(speech, aiConfig);
      if (OUTCOMES.includes(outcome) && outcome !== 'unclear') return { outcome, via: 'ai' };
    } catch (e) {
      log.error(`[ai] could not classify "${speech}": ${e.message}. Using keywords.`);
    }
  }
  return { outcome: keywordClassify(speech), via: 'keywords' };
}

module.exports = { classifyOutAnswer, keywordClassify, fromDigits, aiClassify };
