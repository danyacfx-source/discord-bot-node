import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { log } from "../notify.js";

const LOYALTY_FILE = path.join(DATA_DIR, "loyalty.json");
const STREAK_FILE = path.join(DATA_DIR, "streaks.json");

function loadJson(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (e) {
    log.error("Engagement", `Не удалось прочитать ${filePath}`, e);
  }
  return {};
}

function saveJson(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (e) {
    log.error("Engagement", `Не удалось сохранить ${filePath}`, e);
  }
}

const cog = {
  name: "Engagement",
  loyalty: {},
  streaks: {},
  _polls: {},

  async setup(_registry) {
    cog.loyalty = loadJson(LOYALTY_FILE);
    cog.streaks = loadJson(STREAK_FILE);
  },

  _pointsKey(user, channel) {
    return `${channel}:${user}`;
  },

  addPoints(user, channel, amount, reason) {
    const key = cog._pointsKey(user, channel);
    if (!cog.loyalty[key]) {
      cog.loyalty[key] = { points: 0, total: 0, user, channel };
    }
    cog.loyalty[key].points += amount;
    cog.loyalty[key].total += amount;
    cog.loyalty[key].last_active = Date.now() / 1000;
    if (reason) cog.loyalty[key].last_reason = reason;
    saveJson(LOYALTY_FILE, cog.loyalty);
  },

  getPoints(user, channel) {
    const key = cog._pointsKey(user, channel);
    return (cog.loyalty[key] || {}).points || 0;
  },

  spendPoints(user, channel, amount) {
    const key = cog._pointsKey(user, channel);
    const entry = cog.loyalty[key];
    if (!entry || entry.points < amount) return false;
    entry.points -= amount;
    saveJson(LOYALTY_FILE, cog.loyalty);
    return true;
  },
};

export default cog;
