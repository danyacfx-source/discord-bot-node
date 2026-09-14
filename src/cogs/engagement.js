import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { log } from "../notify.js";

const LOYALTY_FILE = path.join(DATA_DIR, "loyalty.json");
const STREAK_FILE = path.join(DATA_DIR, "streaks.json");

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validateLoyalty(data) {
  if (!isPlainObject(data)) return {};
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (!isPlainObject(v)) continue;
    if (typeof v.points !== "number" || typeof v.total !== "number") continue;
    out[k] = v;
  }
  return out;
}

function loadJson(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) throw new Error("root is not object");
      // schema validation per file
      if (filePath === LOYALTY_FILE) return validateLoyalty(parsed);
      if (filePath === STREAK_FILE && !isPlainObject(parsed)) return {};
      return parsed;
    }
  } catch (e) {
    log.error("Engagement", `Не удалось прочитать ${filePath} (сброшено к {}): ${e.message}`, e);
    // move corrupted file aside for debugging instead of silently overwriting
    try {
      const bak = filePath + ".corrupt." + Date.now();
      fs.renameSync(filePath, bak);
    } catch {}
  }
  return {};
}

async function saveJsonAsync(filePath, data) {
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp." + process.pid;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await fsp.rename(tmp, filePath);
  } catch (e) {
    log.error("Engagement", `Не удалось сохранить ${filePath}`, e);
  }
}

// Debounced batched save: coalesce many addPoints/spendPoints per second into one async write
const pendingSaves = new Map(); // filePath -> { dataRef, timer }
function scheduleSave(filePath, data) {
  let entry = pendingSaves.get(filePath);
  if (entry) clearTimeout(entry.timer);
  // не клонируем на каждый вызов (дорого при 10k записей) — клонируем только при фактической записи
  const timer = setTimeout(() => {
    const e = pendingSaves.get(filePath);
    if (!e) return;
    pendingSaves.delete(filePath);
    const snapshot = JSON.parse(JSON.stringify(e.dataRef));
    void saveJsonAsync(filePath, snapshot);
  }, 800);
  timer.unref?.();
  pendingSaves.set(filePath, { dataRef: data, timer });
}

async function flushSaves() {
  const tasks = [];
  for (const [filePath, entry] of pendingSaves) {
    clearTimeout(entry.timer);
    const snapshot = JSON.parse(JSON.stringify(entry.dataRef));
    tasks.push(saveJsonAsync(filePath, snapshot));
  }
  pendingSaves.clear();
  await Promise.allSettled(tasks);
}

const cog = {
  name: "Engagement",
  loyalty: {},
  streaks: {},
  _polls: {},

  async setup(_registry) {
    this.loyalty = loadJson(LOYALTY_FILE);
    this.streaks = loadJson(STREAK_FILE);
  },

  _pointsKey(user, channel) {
    return `${channel}:${user}`;
  },

  addPoints(user, channel, amount, reason) {
    const key = this._pointsKey(user, channel);
    if (!this.loyalty[key]) {
      this.loyalty[key] = { points: 0, total: 0, user, channel };
    }
    this.loyalty[key].points += amount;
    this.loyalty[key].total += amount;
    this.loyalty[key].last_active = Date.now() / 1000;
    if (reason) this.loyalty[key].last_reason = reason;
    scheduleSave(LOYALTY_FILE, this.loyalty);
  },

  getPoints(user, channel) {
    const key = this._pointsKey(user, channel);
    return (this.loyalty[key] || {}).points || 0;
  },

  spendPoints(user, channel, amount) {
    const key = this._pointsKey(user, channel);
    const entry = this.loyalty[key];
    if (!entry || entry.points < amount) return false;
    entry.points -= amount;
    scheduleSave(LOYALTY_FILE, this.loyalty);
    return true;
  },

  // expose for graceful shutdown / tests
  async _flush() {
    await flushSaves();
  },
};

export default cog;
