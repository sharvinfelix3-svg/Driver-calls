// Keeps drivers, today's call progress and alerts in one JSON file.
// The file lives in DATA_DIR, which must be on a persistent disk on your host
// so a restart doesn't forget who has already been called.
const fs = require('fs');
const path = require('path');

function emptyData() {
  return {
    drivers: [],
    overrides: {}, // date -> driverId -> { off: true } or { wakeTime, outTime }
    days: {}, // date -> driverId -> { wake: flow, out: flow }
    calls: {}, // callId -> what the call was for
    alerts: [], // calls to the boss
    log: [],
    paused: false,
    // Free trial / paid-until date, set by the seller. null = no time limit.
    licence: null, // { until: 'YYYY-MM-DD', kind: 'trial' | 'paid', stopNoted }
  };
}

function createStore(filePath) {
  let data = emptyData();
  if (filePath && fs.existsSync(filePath)) {
    try {
      data = { ...emptyData(), ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    } catch (e) {
      const backup = `${filePath}.broken-${Date.now()}`;
      fs.copyFileSync(filePath, backup);
      console.error(`[store] Could not read ${filePath} (${e.message}). Saved a copy as ${backup} and started fresh.`);
    }
  }

  function save() {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  }

  return {
    get data() {
      return data;
    },
    save,
  };
}

module.exports = { createStore, emptyData };
