import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASE_DIR = path.resolve(__dirname, "..");
export const CONFIG_PATH = path.join(BASE_DIR, "config.json");

// DATA_DIR: auxiliary data (loyalty.json, etc.). DB_PATH: SQLite file.
// Priority for DB: DB_DIR (if set) > DATA_DIR (if set) > BASE_DIR/data
// If both DB_DIR and DATA_DIR are set, DB_DIR wins for DB file only; DATA_DIR remains for other data.
const _rawDataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(BASE_DIR, "data");
export const DATA_DIR = _rawDataDir;
const _effectiveDbDir = process.env.DB_DIR
  ? path.resolve(process.env.DB_DIR)
  : process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : DATA_DIR;
export const DB_PATH = path.join(_effectiveDbDir, "data.db");

// Ensure DATA_DIR exists with explicit mode respecting umask (0o755)
try {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o755 });
} catch (e) {
  console.error(`[config] cannot create DATA_DIR ${DATA_DIR}:`, e.message);
}
// Ensure DB directory exists if different from DATA_DIR
if (_effectiveDbDir !== DATA_DIR) {
  try {
    fs.mkdirSync(_effectiveDbDir, { recursive: true, mode: 0o755 });
  } catch (e) {
    console.error(`[config] cannot create DB_DIR ${_effectiveDbDir}:`, e.message);
  }
}
// Migration: copy legacy DB (BASE_DIR/data.db or BASE_DIR/data/data.db) to new location without data loss
try {
  const legacyPaths = [path.join(BASE_DIR, "data.db")];
  const defaultDataDb = path.join(BASE_DIR, "data", "data.db");
  if (defaultDataDb !== DB_PATH) legacyPaths.push(defaultDataDb);
  for (const legacy of legacyPaths) {
    if (fs.existsSync(legacy) && !fs.existsSync(DB_PATH)) {
      try {
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o755 });
        fs.copyFileSync(legacy, DB_PATH);
        console.log(`[config] migrated legacy DB ${legacy} -> ${DB_PATH}`);
      } catch (migErr) {
        console.error(`[config] failed to migrate DB ${legacy} -> ${DB_PATH}:`, migErr.message);
      }
      break;
    }
  }
} catch {}

// TOKEN_FILE must respect DATA_DIR (not hardcoded BASE_DIR/data)
export const TOKEN_FILE = path.join(DATA_DIR, ".panel-token");

function parseEnvValue(raw) {
  let v = String(raw ?? "");
  if (v.charCodeAt(0) === 0xFEFF) v = v.slice(1);
  v = v.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function loadEnv() {
  const envPath = path.join(BASE_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  try {
    let content = fs.readFileSync(envPath, "utf-8");
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    for (let raw of content.split(/\r?\n/)) {
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      let line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) line = line.slice(7).trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (!key || key.startsWith("#")) continue;
      let valueRaw = line.slice(eq + 1);
      const trimmed = valueRaw.trim();
      const isQuoted = trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")));
      let value;
      if (isQuoted) {
        value = parseEnvValue(valueRaw);
      } else {
        const hashIdx = valueRaw.indexOf(" #");
        if (hashIdx !== -1) valueRaw = valueRaw.slice(0, hashIdx);
        else {
          const tabHash = valueRaw.indexOf("\t#");
          if (tabHash !== -1) valueRaw = valueRaw.slice(0, tabHash);
        }
        value = parseEnvValue(valueRaw);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (e) {
    console.error("[config] failed to load .env:", e.message);
  }
}
loadEnv();

let rawConfig;
try {
  rawConfig = fs.readFileSync(CONFIG_PATH, "utf-8");
} catch (e) {
  console.error(`[config] cannot read ${CONFIG_PATH}:`, e.message);
  console.error("[config] using empty defaults — create config.json from config.example.json");
  rawConfig = "{}";
}

let parsed;
try {
  parsed = JSON.parse(rawConfig);
} catch (e) {
  console.error(`[config] invalid JSON in ${CONFIG_PATH}:`, e.message);
  throw new Error(`config.json parse failed: ${e.message}`);
}

export const CONFIG = parsed;

CONFIG.token =
  process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || CONFIG.token || "";
if (!CONFIG.token) {
  console.warn("[config] DISCORD_TOKEN is empty — bot will fail to login. Set DISCORD_TOKEN in .env or config.json");
}
CONFIG.youtube = CONFIG.youtube || {};
CONFIG.youtube.client_id = process.env.YOUTUBE_CLIENT_ID || CONFIG.youtube.client_id || "";
CONFIG.youtube.client_secret = process.env.YOUTUBE_CLIENT_SECRET || CONFIG.youtube.client_secret || "";
CONFIG.youtube.refresh_token = process.env.YOUTUBE_REFRESH_TOKEN || CONFIG.youtube.refresh_token || "";
CONFIG.twitch = CONFIG.twitch || {};
CONFIG.twitch.client_id = process.env.TWITCH_CLIENT_ID || CONFIG.twitch.client_id || "";
CONFIG.twitch.client_secret = process.env.TWITCH_CLIENT_SECRET || CONFIG.twitch.client_secret || "";
CONFIG.kick = CONFIG.kick || {};
const _overlayEnv = (process.env.OVERLAY_TOKEN || "").trim();
if (_overlayEnv) {
  if (_overlayEnv.length < 16) {
    console.warn("[config] OVERLAY_TOKEN too short (<16 chars) — ignoring insecure token");
  } else {
    CONFIG.overlay = CONFIG.overlay || {};
    CONFIG.overlay.token = _overlayEnv;
  }
}
CONFIG.ai = CONFIG.ai || {};
const _geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.OPENROUTER_API_KEY || "";
if (_geminiKey) CONFIG.ai.api_key = _geminiKey;
if (!CONFIG.overlay) CONFIG.overlay = {};
if (!CONFIG.overlay.token) {
  console.warn("[config] overlay.token is empty — overlay will be disabled");
} else if (String(CONFIG.overlay.token).trim().length < 16) {
  console.warn("[config] overlay.token too short (<16) — insecure, overlay disabled");
  // do not keep insecure token silently: clear it so consumers must re-validate
  CONFIG.overlay.token = "";
  console.warn("[config] overlay.token cleared due to insufficient length");
}

export const EXTRA_ROLES = CONFIG.extra_roles || [];
export const ROLE_SETTINGS = CONFIG.role_settings || {};
export const CHANNELS = CONFIG.channels || {};
export const BOT_NAME = CONFIG.bot_name || "Милый Килла";
const _rawGuildId = (CONFIG.guild_id ?? process.env.GUILD_ID ?? "").toString().trim();
export const GUILD_ID = _rawGuildId ? String(_rawGuildId) : "";
if (GUILD_ID && !/^\d{17,22}$/.test(GUILD_ID)) {
  console.warn(`[config] GUILD_ID "${GUILD_ID}" looks invalid — expected 17-22 digit snowflake`);
}
export const TOKEN = CONFIG.token;
export const PROXY_URL = process.env.DISCORD_PROXY || "";
export const WHITELIST_CHANNELS = new Set((CONFIG.whitelist_channels || []).map(String));
export const EXCLUDE_ROLES = new Set(CONFIG.exclude_roles || []);
const _rawAnnounce = (CONFIG.announce_channel_id ?? "").toString().trim();
export const ANNOUNCE_CHANNEL_ID = _rawAnnounce ? String(_rawAnnounce) : "";
const _rawLog = (CONFIG.log_channel_id ?? "").toString().trim();
export const LOG_CHANNEL_ID = _rawLog ? String(_rawLog) : "";
export const PING_ROLES = CONFIG.ping_roles || ["Owner", "Moderator"];
// Validation for critical env vars
if (!TOKEN) console.warn("[config] DISCORD_TOKEN missing — bot will fail to login (already warned above)");
if (!GUILD_ID) console.warn("[config] GUILD_ID not set — guild-scoped commands will be global; set GUILD_ID in .env or config.json");

const tempTriggers = {};
for (const [k, v] of Object.entries(CONFIG.temp_triggers || {})) {
  if (typeof v !== "string") {
    console.warn(`[config] temp_triggers[${k}] should be string, got ${typeof v} — skipping`);
    continue;
  }
  tempTriggers[String(k)] = v;
}
export const TEMP_TRIGGERS = tempTriggers;
export const SEASON = CONFIG.season || {};
export const OVERLAY = CONFIG.overlay || {};

export const TEMP_CATS = {};
if (CHANNELS && typeof CHANNELS === "object" && !Array.isArray(CHANNELS)) {
  for (const [name, spec] of Object.entries(CHANNELS)) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      if (spec && typeof spec === "string") console.warn(`[config] CHANNELS[${name}] is string, expected object with type "temp" — skipping`);
      continue;
    }
    if (spec.type === "temp") {
      if (!spec.create && !spec.category) {
        console.warn(`[config] TEMP_CATS[${name}] missing "create" field — using default`);
      }
      TEMP_CATS[String(name)] = spec;
    }
  }
}
