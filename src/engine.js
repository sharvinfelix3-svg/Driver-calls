// The brain: decides who to call and when, what each call says,
// what each answer means, and when to phone the boss.
const crypto = require('crypto');
const twilio = require('twilio');
const { localParts, toMinutes, isHHMM, isDate, addDays } = require('./time');
const { normalizePhone } = require('./phone');
const M = require('./messages');
const { classifyOutAnswer } = require('./classify');
const { missingProviderSettings } = require('./providers');

const { VoiceResponse } = twilio.twiml;
const BUSY = new Set(['calling', 'scheduled']);
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function newFlow() {
  return { state: 'waiting', attempts: 0, notYet: 0, nextAt: null, cid: null, callStartedAt: null, result: null, doneAt: null, lastAnswer: null };
}

function weekdayOf(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

/** Pull the spoken text out of TwiML, for dry-run printing. */
function sayText(twiml) {
  return [...String(twiml).matchAll(/<Say[^>]*>([\s\S]*?)<\/Say>/g)].map((m) => m[1]).join(' ');
}

function createEngine({ config, store, client = null, now = () => Date.now(), classify = classifyOutAnswer, log = console, later = () => {} }) {
  const rules = config.rules;
  const db = () => store.data;
  const lp = (ms = now()) => localParts(ms, config.timezone);
  const newId = () => crypto.randomBytes(6).toString('hex');
  let ticking = false;
  let alerting = false;

  // ---------- small helpers ----------

  function addLog(entry) {
    const d = db();
    d.log.unshift({ at: now(), ...entry });
    if (d.log.length > 300) d.log.length = 300;
  }

  const driverById = (id) => db().drivers.find((d) => d.id === id);
  const langOf = (driver) => (driver && driver.lang === 'en' ? 'en' : 'ms');
  const hookUrl = (path, cid) =>
    `${config.publicUrl}/voice/${path}?cid=${cid}${config.webhookKey ? `&key=${encodeURIComponent(config.webhookKey)}` : ''}`;

  /** The driver's times for a date, or null if not working that day. */
  function scheduleFor(driver, date, weekday = weekdayOf(date)) {
    if (!driver || driver.active === false) return null;
    const ov = db().overrides[date] && db().overrides[date][driver.id];
    if (ov && ov.off) return null;
    if (ov) {
      return {
        wakeTime: 'wakeTime' in ov ? ov.wakeTime : driver.wakeTime || '',
        outTime: 'outTime' in ov ? ov.outTime : driver.outTime || '',
        changed: true,
      };
    }
    const days = Array.isArray(driver.days) ? driver.days : ALL_DAYS;
    if (!days.includes(weekday)) return null;
    return { wakeTime: driver.wakeTime || '', outTime: driver.outTime || '' };
  }

  function dayRecord(date, driverId) {
    const d = db();
    d.days[date] = d.days[date] || {};
    d.days[date][driverId] = d.days[date][driverId] || { wake: newFlow(), out: newFlow() };
    return d.days[date][driverId];
  }

  function voiceSay(node, lang, text) {
    const v = config.voices[lang];
    node.say({ voice: v.voice, language: v.language }, text);
  }

  // ---------- placing calls ----------

  async function placeCall(to, twiml, cid) {
    // Keep the script so the calling service can fetch it from /voice/twiml (Telnyx does this)
    if (db().calls[cid]) db().calls[cid].twiml = twiml;
    if (config.dryRun) {
      log.info(`\n[DRY RUN] Calling ${to}\n  "${sayText(twiml)}"\n  (pretending nobody answered)\n`);
      const t = setTimeout(() => handleStatus(cid, 'no-answer'), 1500);
      if (t.unref) t.unref();
      return { sid: 'DRY-RUN' };
    }
    if (!client) throw new Error(`${config.providerName} is not set up yet, so no call was made`);
    if (!config.publicUrl) throw new Error('PUBLIC_URL is not set, so calls cannot hear keypresses');
    return client.calls.create({
      cid,
      to,
      from: config.callerId,
      twiml,
      url: hookUrl('twiml', cid),
      timeout: config.ringSeconds,
      statusCallback: hookUrl('status', cid),
    });
  }

  /** The script for a call, when the calling service asks for it. */
  function getTwiml(cid) {
    const call = db().calls[cid];
    if (call && call.twiml) return call.twiml;
    const r = new VoiceResponse();
    r.hangup();
    return r.toString();
  }

  function driverCallTwiml(driver, kind, cid, { test = false } = {}) {
    const lang = langOf(driver);
    const S = M.driver[lang];
    const r = new VoiceResponse();
    const intro = kind === 'wake' ? S.wakeIntro(driver, lp().hhmm, config.companyName) : S.outIntro(driver, config.companyName);
    const prompt = kind === 'wake' ? S.wakePrompt(config.speechInput) : S.outPrompt;
    for (let i = 0; i < 2; i++) {
      const g = r.gather(gatherOptions(lang, kind, cid));
      if (i === 0 && test) voiceSay(g, lang, S.testNote);
      voiceSay(g, lang, i === 0 ? intro : `${S.repeat} ${intro}`);
      voiceSay(g, lang, prompt);
    }
    voiceSay(r, lang, S.noInput);
    r.hangup();
    return r.toString();
  }

  function gatherOptions(lang, kind, cid) {
    const keys = { input: 'dtmf', numDigits: 1, timeout: 7, action: hookUrl('gather', cid), method: 'POST' };
    if (!config.speechInput) return keys;
    return {
      ...keys,
      input: 'dtmf speech',
      speechTimeout: 'auto',
      language: config.voices[lang].speech,
      hints: M.hints[lang][kind],
    };
  }

  async function startDriverCall(date, driver, kind, { test = false } = {}) {
    const t = now();
    const cid = newId();
    const call = { cid, kind, date, driverId: driver.id, test, createdAt: t, ended: false, handled: false, unclear: 0 };
    if (!test) {
      const flow = dayRecord(date, driver.id)[kind];
      flow.attempts += 1;
      flow.state = 'calling';
      flow.callStartedAt = t;
      flow.cid = cid;
      flow.nextAt = null;
      call.attempt = flow.attempts;
    }
    db().calls[cid] = call;
    addLog({ driverId: driver.id, kind, event: test ? 'test_call' : 'calling', attempt: call.attempt });
    store.save();
    try {
      const res = await placeCall(driver.phone, driverCallTwiml(driver, kind, cid, { test }), cid);
      call.sid = res && res.sid;
      log.info(`[call] ${test ? 'test ' : ''}${kind} call to ${driver.name} placed (${call.sid})`);
    } catch (e) {
      log.error(`[call] could not call ${driver.name}: ${e.message}`);
      call.error = e.message;
      handleStatus(cid, 'failed');
    }
    store.save();
    return cid;
  }

  // ---------- the clock ----------

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const t = now();
      const p = lp(t);
      const d = db();

      // Calls the service never reported back on count as unanswered
      for (const call of Object.values(d.calls)) {
        if (!call.ended && t - call.createdAt > rules.callStaleMinutes * 60000) handleStatus(call.cid, 'no-status');
      }

      if (!d.paused) {
        for (const driver of [...d.drivers]) {
          const sched = scheduleFor(driver, p.date, p.weekday);
          if (!sched) continue;
          const rec = dayRecord(p.date, driver.id);
          for (const kind of ['wake', 'out']) {
            const flow = rec[kind];
            if (kind === 'out' && BUSY.has(rec.wake.state)) continue; // finish the wake-up first
            if (rec.wake.state === 'calling' || rec.out.state === 'calling') continue; // one call at a time
            const time = kind === 'wake' ? sched.wakeTime : sched.outTime;

            if (flow.state === 'waiting' && isHHMM(time) && p.minutes >= toMinutes(time)) {
              if (p.minutes - toMinutes(time) > rules.catchUpMinutes) {
                markMissed(driver, kind, flow);
                continue;
              }
              await startDriverCall(p.date, driver, kind);
            } else if (flow.state === 'scheduled' && t >= flow.nextAt) {
              if (t - flow.nextAt > rules.catchUpMinutes * 60000) {
                markMissed(driver, kind, flow);
                continue;
              }
              await startDriverCall(p.date, driver, kind);
            }
          }
        }
      }

      await processAlerts();
      prune(p.date);
      store.save();
    } catch (e) {
      log.error(`[tick] ${e.stack || e.message}`);
    } finally {
      ticking = false;
    }
  }

  function markMissed(driver, kind, flow) {
    flow.state = 'missed';
    flow.result = 'missed';
    flow.doneAt = now();
    addLog({ driverId: driver.id, kind, event: 'missed', note: 'The system was off at call time' });
    log.warn(`[tick] Skipped ${kind} call for ${driver.name}: the system was off at call time.`);
  }

  function prune(today) {
    const d = db();
    const keepDays = addDays(today, -14);
    for (const date of Object.keys(d.days)) if (date < keepDays) delete d.days[date];
    const yesterday = addDays(today, -1);
    for (const date of Object.keys(d.overrides)) if (date < yesterday) delete d.overrides[date];
    const cutoff = now() - 3 * 86400000;
    for (const [cid, c] of Object.entries(d.calls)) if (c.createdAt < cutoff) delete d.calls[cid];
    let finished = 0;
    d.alerts = d.alerts.filter((a) => BUSY.has(a.state) || ++finished <= 30);
  }

  // ---------- what the calling service tells us ----------

  /** The calling service sends what the person pressed or said. Returns TwiML for what to say next. */
  async function handleGather(cid, params = {}) {
    const digits = params.Digits || '';
    const speech = String(params.SpeechResult || '').trim().slice(0, 120);
    const call = db().calls[cid];
    const r = new VoiceResponse();
    if (!call) {
      r.hangup();
      return r.toString();
    }
    if (call.kind === 'owner') return ownerAnswered(call);

    const driver = driverById(call.driverId);
    if (!driver) {
      r.hangup();
      return r.toString();
    }
    const lang = langOf(driver);
    const S = M.driver[lang];
    const say = (text) => voiceSay(r, lang, text);
    const flow = call.test ? null : db().days[call.date] && db().days[call.date][driver.id] && db().days[call.date][driver.id][call.kind];
    const current = !!flow && flow.cid === cid && flow.state === 'calling';
    const sched = scheduleFor(driver, call.date);

    if (call.kind === 'wake') {
      call.handled = true;
      call.answer = 'awake';
      if (current) {
        flow.state = 'done';
        flow.result = 'awake';
        flow.doneAt = now();
        flow.lastAnswer = speech || (digits ? `key ${digits}` : '');
        addLog({ driverId: driver.id, kind: 'wake', event: 'awake' });
      }
      say(S.wakeAck(sched && sched.outTime));
      if (call.test) say(S.testNote);
      r.hangup();
      store.save();
      return r.toString();
    }

    // "Dah keluar?" call
    const { outcome, via } = await classify({ digits, speech }, config.ai, { log });
    call.answers = [...(call.answers || []), { digits, speech, outcome, via }];

    if (outcome === 'unclear') {
      if (call.unclear < 1) {
        call.unclear += 1;
        const g = r.gather(gatherOptions(lang, 'out', cid));
        voiceSay(g, lang, `${S.unclear} ${S.outPrompt}`);
        say(S.noInput);
      } else {
        say(S.unclearFinal); // call ends without an answer, so it counts as unanswered
      }
      r.hangup();
      store.save();
      return r.toString();
    }

    call.handled = true;
    call.answer = outcome;

    if (!current) {
      // A test call, or an old call: say the right thing but change nothing
      say(outcome === 'out' ? S.outDone : outcome === 'not_yet' ? S.outRecheck(rules.outRecheckMinutes) : S.outProblem);
      if (call.test) say(S.testNote);
      r.hangup();
      store.save();
      return r.toString();
    }

    flow.lastAnswer = speech || `key ${digits}`;
    const ownerLang = config.owner.lang;
    const O = M.owner[ownerLang];

    if (outcome === 'out') {
      flow.state = 'done';
      flow.result = 'out';
      flow.doneAt = now();
      addLog({ driverId: driver.id, kind: 'out', event: 'out', via });
      say(S.outDone);
    } else if (outcome === 'not_yet') {
      flow.notYet += 1;
      addLog({ driverId: driver.id, kind: 'out', event: 'not_yet', count: flow.notYet, via });
      if (flow.notYet >= rules.outMaxNotYet) {
        flow.state = 'alerted';
        flow.result = 'not_out';
        flow.doneAt = now();
        say(S.outNotYetFinal);
        alertOwner(`${O.notOut(driver, flow.notYet, sched && sched.outTime)} ${O.number(driver)}`, {
          driverId: driver.id,
          reason: 'not_out',
        });
      } else {
        flow.state = 'scheduled';
        flow.result = 'not_yet';
        flow.attempts = 0;
        flow.nextAt = now() + rules.outRecheckMinutes * 60000;
        say(S.outRecheck(rules.outRecheckMinutes));
      }
    } else {
      flow.state = 'alerted';
      flow.result = 'problem';
      flow.doneAt = now();
      addLog({ driverId: driver.id, kind: 'out', event: 'problem', via, said: via === 'keypad' ? '' : speech });
      say(S.outProblem);
      alertOwner(`${O.problem(driver, via === 'keypad' ? '' : speech)} ${O.number(driver)}`, { driverId: driver.id, reason: 'problem' });
    }
    r.hangup();
    store.save();
    return r.toString();
  }

  /** The calling service says a call has ended. */
  // Call endings worth showing in the Log (a normal answered call ends "completed")
  const QUIET_ENDS = new Set(['completed', 'no-answer', 'no-status', 'unanswered', 'timeout', 'busy']);

  function handleStatus(cid, status, detail = '') {
    const call = db().calls[cid];
    if (!call || call.ended) return;
    call.ended = true;
    call.status = status;
    call.detail = detail;
    call.endedAt = now();
    if (call.test || call.kind === 'owner' || !QUIET_ENDS.has(status)) {
      if (!(call.handled && status === 'completed')) {
        addLog({ event: 'call_end', driverId: call.driverId, kind: call.kind, status, detail: detail || call.error || '', test: !!call.test });
      }
    }
    if (!QUIET_ENDS.has(status) || detail) log.warn(`[call] ${call.kind} call ${cid} ended: ${status}${detail ? ` (${detail})` : ''}${call.error ? ` — ${call.error}` : ''}`);
    if (call.kind === 'owner') {
      ownerCallEnded(call);
      store.save();
      processAlerts().catch((e) => log.error(`[alert] ${e.message}`));
      return;
    }
    if (!call.handled && !call.test) {
      driverCallUnanswered(call);
      // Call again right away instead of waiting for the next clock check
      later(() => tick(), 3000);
    }
    store.save();
  }

  function driverCallUnanswered(call) {
    const rec = db().days[call.date] && db().days[call.date][call.driverId];
    const flow = rec && rec[call.kind];
    if (!flow || flow.cid !== call.cid || flow.state !== 'calling') return;
    const driver = driverById(call.driverId);
    const alertAfter = call.kind === 'wake' ? rules.wakeMaxAttempts : rules.outMaxAttempts;
    const maxCalls = Math.max(alertAfter, call.kind === 'wake' ? rules.wakeMaxCalls : rules.outMaxCalls);
    const gap = call.kind === 'wake' ? rules.wakeRetryMinutes : rules.outRetryMinutes;
    addLog({ driverId: call.driverId, kind: call.kind, event: 'no_answer', attempt: flow.attempts, status: call.status });

    // Missed enough calls: phone the boss once, but keep calling the driver
    if (flow.attempts >= alertAfter && !flow.ownerAlerted && driver) {
      flow.ownerAlerted = true;
      const O = M.owner[config.owner.lang];
      const msg = call.kind === 'wake' ? O.wakeNoAnswer(driver, flow.attempts) : O.outNoAnswer(driver, flow.attempts);
      alertOwner(`${msg} ${O.number(driver)}`, { driverId: driver.id, reason: `${call.kind}_no_answer` });
    }

    if (flow.attempts >= maxCalls) {
      flow.state = 'alerted';
      flow.result = 'no_answer';
      flow.doneAt = now();
      addLog({ driverId: call.driverId, kind: call.kind, event: 'gave_up', attempt: flow.attempts });
    } else {
      flow.state = 'scheduled';
      flow.nextAt = now() + gap * 60000;
    }
  }

  // ---------- calling the boss ----------

  function alertOwner(message, meta = {}) {
    const d = db();
    const t = now();
    const waiting = d.alerts.find((a) => a.state === 'scheduled' && a.attempt === 0);
    if (waiting) waiting.messages.push(message);
    else d.alerts.unshift({ id: newId(), messages: [message], meta, attempt: 0, state: 'scheduled', nextAt: t, createdAt: t });
    addLog({ event: 'alert_owner', driverId: meta.driverId, reason: meta.reason, message });
    store.save();
    processAlerts().catch((e) => log.error(`[alert] ${e.message}`));
  }

  /** One call to the boss at a time, oldest message first. */
  async function processAlerts() {
    if (alerting) return false;
    alerting = true;
    try {
      const d = db();
      if (d.alerts.some((a) => a.state === 'calling')) return false;
      const t = now();
      const due = d.alerts.filter((a) => a.state === 'scheduled' && t >= a.nextAt).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!due) return false;
      await dialOwner(due);
      return true;
    } finally {
      alerting = false;
    }
  }

  async function dialOwner(alert) {
    if (!config.owner.phone && !config.dryRun) {
      alert.state = 'failed';
      alert.error = 'OWNER_PHONE is not set';
      log.error(`[alert] OWNER_PHONE is not set, so the boss was not called. Message: ${alert.messages.join(' ')}`);
      store.save();
      return;
    }
    const cid = newId();
    alert.attempt += 1;
    alert.state = 'calling';
    alert.cid = cid;
    db().calls[cid] = { cid, kind: 'owner', alertId: alert.id, createdAt: now(), ended: false, handled: false };
    store.save();
    try {
      const res = await placeCall(config.owner.phone || '(OWNER_PHONE)', ownerTwiml(alert, cid), cid);
      db().calls[cid].sid = res && res.sid;
      log.info(`[call] call to boss placed (${db().calls[cid].sid})`);
    } catch (e) {
      log.error(`[alert] could not call the boss: ${e.message}`);
      alert.error = e.message;
      handleStatus(cid, 'failed');
    }
  }

  function ownerTwiml(alert, cid) {
    const lang = config.owner.lang;
    const O = M.owner[lang];
    const r = new VoiceResponse();
    const text = `${O.open} ${alert.messages.join(' ')}`;
    for (let i = 0; i < 2; i++) {
      const g = r.gather({ input: 'dtmf', numDigits: 1, timeout: 6, action: hookUrl('gather', cid), method: 'POST' });
      voiceSay(g, lang, i === 0 ? text : `${M.driver[lang].repeat} ${text}`);
      voiceSay(g, lang, O.ackPrompt);
    }
    r.hangup();
    return r.toString();
  }

  function ownerAnswered(call) {
    const alert = db().alerts.find((a) => a.id === call.alertId);
    call.handled = true;
    if (alert && alert.state !== 'done') {
      alert.state = 'done';
      alert.ackAt = now();
      addLog({ event: 'owner_confirmed', reason: alert.meta && alert.meta.reason });
    }
    const r = new VoiceResponse();
    voiceSay(r, config.owner.lang, M.owner[config.owner.lang].ackThanks);
    r.hangup();
    store.save();
    return r.toString();
  }

  function ownerCallEnded(call) {
    const alert = db().alerts.find((a) => a.id === call.alertId);
    if (!alert || alert.cid !== call.cid || call.handled || alert.state !== 'calling') return;
    if (alert.attempt > rules.ownerRetries) {
      alert.state = 'failed';
      addLog({ event: 'owner_no_answer', attempts: alert.attempt });
      log.error(`[alert] The boss did not confirm after ${alert.attempt} calls. Giving up on: ${alert.messages.join(' ')}`);
    } else {
      alert.state = 'scheduled';
      alert.nextAt = now() + rules.ownerRetryMinutes * 60000;
    }
  }

  // ---------- admin actions ----------

  function cleanDriver(input, existing = {}) {
    const out = { ...existing };
    if ('name' in input) out.name = String(input.name || '').trim().slice(0, 40);
    if ('phone' in input) out.phone = normalizePhone(input.phone);
    if ('lang' in input) out.lang = input.lang === 'en' ? 'en' : 'ms';
    if ('wakeTime' in input) out.wakeTime = input.wakeTime || '';
    if ('outTime' in input) out.outTime = input.outTime || '';
    if ('days' in input) out.days = [...new Set((input.days || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    if ('active' in input) out.active = !!input.active;

    const errors = [];
    if (!out.name) errors.push('Name is needed');
    if (!out.phone) errors.push('Phone number looks wrong (use e.g. 012-345 6789)');
    errors.push(...timeErrors(out.wakeTime, out.outTime));
    if (!out.days || !out.days.length) errors.push('Pick at least one working day');
    if (errors.length) throw new Error(errors.join('. '));
    return out;
  }

  function timeErrors(wakeTime, outTime) {
    const errors = [];
    if (wakeTime && !isHHMM(wakeTime)) errors.push('Wake-up time looks wrong');
    if (outTime && !isHHMM(outTime)) errors.push('Check time looks wrong');
    if (!wakeTime && !outTime) errors.push('Set a wake-up time, a check time, or both');
    if (isHHMM(wakeTime) && isHHMM(outTime) && toMinutes(outTime) <= toMinutes(wakeTime)) errors.push('Check time must be after wake-up time');
    return errors;
  }

  function addDriver(input) {
    const driver = cleanDriver({ lang: 'ms', days: [1, 2, 3, 4, 5, 6], active: true, wakeTime: '', outTime: '', ...input });
    driver.id = newId();
    db().drivers.push(driver);
    addLog({ event: 'driver_added', driverId: driver.id });
    store.save();
    return driver;
  }

  function updateDriver(id, input) {
    const d = db();
    const i = d.drivers.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('Driver not found');
    d.drivers[i] = cleanDriver(input, d.drivers[i]);
    store.save();
    return d.drivers[i];
  }

  function removeDriver(id) {
    const d = db();
    const before = d.drivers.length;
    d.drivers = d.drivers.filter((x) => x.id !== id);
    if (d.drivers.length === before) throw new Error('Driver not found');
    for (const date of Object.keys(d.overrides)) delete d.overrides[date][id];
    store.save();
  }

  function setOverride(date, driverId, { off, wakeTime = '', outTime = '' } = {}) {
    if (!isDate(date)) throw new Error('Date looks wrong');
    if (date < lp().date) throw new Error('That date has passed');
    if (!driverById(driverId)) throw new Error('Driver not found');
    let value;
    if (off) value = { off: true };
    else {
      const errors = timeErrors(wakeTime, outTime);
      if (errors.length) throw new Error(errors.join('. '));
      value = { wakeTime, outTime };
    }
    const d = db();
    d.overrides[date] = d.overrides[date] || {};
    d.overrides[date][driverId] = value;
    store.save();
    return value;
  }

  function clearOverride(date, driverId) {
    const d = db();
    if (d.overrides[date]) {
      delete d.overrides[date][driverId];
      if (!Object.keys(d.overrides[date]).length) delete d.overrides[date];
    }
    store.save();
  }

  function setPaused(paused) {
    db().paused = !!paused;
    addLog({ event: paused ? 'paused' : 'resumed' });
    store.save();
  }

  /** Start today's real wake-up or check call right now (e.g. to try again). */
  async function callNow(driverId, kind) {
    const driver = driverById(driverId);
    if (!driver) throw new Error('Driver not found');
    if (!['wake', 'out'].includes(kind)) throw new Error('Unknown call type');
    const date = lp().date;
    const rec = dayRecord(date, driverId);
    if (rec.wake.state === 'calling' || rec.out.state === 'calling') throw new Error(`Already calling ${driver.name}`);
    rec[kind] = newFlow();
    await startDriverCall(date, driver, kind);
  }

  async function testCall(driverId, kind) {
    const driver = driverById(driverId);
    if (!driver) throw new Error('Driver not found');
    if (!['wake', 'out'].includes(kind)) throw new Error('Unknown call type');
    return startDriverCall(lp().date, driver, kind, { test: true });
  }

  function testOwnerCall() {
    alertOwner(M.owner[config.owner.lang].test, { reason: 'test' });
  }

  function snapshot() {
    const t = now();
    const p = lp(t);
    const d = db();
    const tomorrow = addDays(p.date, 1);
    const drivers = d.drivers.map((driver) => {
      const rec = d.days[p.date] && d.days[p.date][driver.id];
      return {
        ...driver,
        today: {
          schedule: scheduleFor(driver, p.date, p.weekday),
          wake: rec ? rec.wake : newFlow(),
          out: rec ? rec.out : newFlow(),
        },
        tomorrow: scheduleFor(driver, tomorrow),
      };
    });
    const overrides = [];
    for (const [date, byDriver] of Object.entries(d.overrides)) {
      if (date < p.date) continue;
      for (const [driverId, value] of Object.entries(byDriver)) overrides.push({ date, driverId, ...value });
    }
    overrides.sort((a, b) => a.date.localeCompare(b.date));
    return {
      now: t,
      timezone: config.timezone,
      date: p.date,
      time: p.hhmm,
      weekday: p.weekday,
      tomorrow,
      paused: !!d.paused,
      drivers,
      overrides,
      alerts: d.alerts.slice(0, 10),
      log: d.log.slice(0, 80),
      status: {
        provider: config.providerName,
        calls: !!client,
        missing: missingProviderSettings(config),
        storageWarning: config.storageWarning,
        publicUrl: !!config.publicUrl,
        owner: !!config.owner.phone,
        ai: !!config.ai.apiKey,
        dryRun: !!config.dryRun,
      },
      rules,
    };
  }

  return {
    tick,
    handleGather,
    handleStatus,
    alertOwner,
    processAlerts,
    addDriver,
    updateDriver,
    removeDriver,
    setOverride,
    clearOverride,
    setPaused,
    callNow,
    testCall,
    testOwnerCall,
    snapshot,
    scheduleFor,
    getTwiml,
    _driverCallTwiml: driverCallTwiml,
    _ownerTwiml: ownerTwiml,
  };
}

module.exports = { createEngine, sayText };
