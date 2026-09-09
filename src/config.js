import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASE_DIR = path.resolve(__dirname, "..");
export const CONFIG_PATH = path.join(BASE_DIR, "config.json");
export const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, "data");
export const DB_PATH = process.env.DB_DIR ? path.join(process.env.DB_DIR, "data.db") : path.join(BASE_DIR, "data.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadEnv() {
  const envPath = path.join(BASE_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv();

export const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

CONFIG.token =
  process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || CONFIG.token || "";
CONFIG.youtube = CONFIG.youtube || {};
CONFIG.youtube.client_id = process.env.YOUTUBE_CLIENT_ID || CONFIG.youtube.client_id || "";
CONFIG.youtube.client_secret = process.env.YOUTUBE_CLIENT_SECRET || CONFIG.youtube.client_secret || "";
CONFIG.youtube.refresh_token = process.env.YOUTUBE_REFRESH_TOKEN || CONFIG.youtube.refresh_token || "";

export const LEVELS = [...(CONFIG.levels || [])].sort((a, b) => a.messages - b.messages);
export const EXTRA_ROLES = CONFIG.extra_roles || [];
export const ROLE_SETTINGS = CONFIG.role_settings || {};
export const CHANNELS = CONFIG.channels || {};
export const BOT_NAME = CONFIG.bot_name || "Милый Килла";
export const GUILD_ID = CONFIG.guild_id || 0;
export const TOKEN = CONFIG.token;
export const PROXY_URL = process.env.DISCORD_PROXY || "";
export const WHITELIST_CHANNELS = new Set(CONFIG.whitelist_channels || []);
export const EXCLUDE_ROLES = new Set(CONFIG.exclude_roles || []);
export const ANNOUNCE_CHANNEL_ID = CONFIG.announce_channel_id || 0;
export const LOG_CHANNEL_ID = CONFIG.log_channel_id || 0;
export const PING_ROLES = CONFIG.ping_roles || ["Owner", "Moderator"];

const tempTriggers = {};
for (const [k, v] of Object.entries(CONFIG.temp_triggers || {})) {
  tempTriggers[Number(k)] = v;
}
export const TEMP_TRIGGERS = tempTriggers;
export const SEASON = CONFIG.season || {};
export const OVERLAY = CONFIG.overlay || {};

export const TEMP_CATS = {};
for (const [name, spec] of Object.entries(CHANNELS)) {
  if (spec && spec.type === "temp") TEMP_CATS[name] = spec;
}