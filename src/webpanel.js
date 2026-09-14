import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChannelType } from "discord.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(BASE_DIR, "webpanel", "index.html");
// Respect DATA_DIR env (Docker volume /app/state) — same logic as src/config.js
const _dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(BASE_DIR, "data");
const TOKEN_FILE = path.join(_dataDir, ".panel-token");
const TRUST_PROXY = String(process.env.TRUST_PROXY || "").toLowerCase() === "true" || String(process.env.TRUST_PROXY) === "1";

const PANEL_HOST = process.env.PANEL_HOST || "0.0.0.0";
const PANEL_PORT = Number.parseInt(process.env.PORT || process.env.PANEL_PORT || "17890", 10) || 17890;
const PANEL_PASSWORD = (process.env.PANEL_PASSWORD || "").trim();
const PANEL_PUBLIC_URL = (process.env.PANEL_PUBLIC_URL || "").trim().replace(/\/+$/, "");
// GUILD_ID scoping for IDOR fix — read from env (mirrors src/config.js)
const PANEL_GUILD_ID = String(process.env.GUILD_ID || "").trim() || null;

// Build allowlist strictly — handle 0.0.0.0 case (browser never sends Origin 0.0.0.0)
const ALLOWED_ORIGINS = new Set();
if (PANEL_PUBLIC_URL) ALLOWED_ORIGINS.add(new URL(PANEL_PUBLIC_URL).origin);
if (PANEL_HOST !== "0.0.0.0") {
  ALLOWED_ORIGINS.add(`http://${PANEL_HOST}:${PANEL_PORT}`);
}
ALLOWED_ORIGINS.add(`http://localhost:${PANEL_PORT}`);
ALLOWED_ORIGINS.add(`http://127.0.0.1:${PANEL_PORT}`);

// ---- Persistent token / session tokens ----
function loadOrCreatePersistentToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const existing = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
      if (existing && existing.length >= 20) return existing;
    }
  } catch {}
  const tok = randomBytes(32).toString("base64url");
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, tok + "\n", { mode: 0o600 });
  } catch {}
  return tok;
}

// If PANEL_PASSWORD is set we use per-login session tokens (24h) instead of single static token.
// Otherwise we use a single persistent token stored on disk.
const STATIC_TOKEN = PANEL_PASSWORD ? null : loadOrCreatePersistentToken();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessionTokens = new Map(); // token -> expiresAt (ms)
if (PANEL_PASSWORD) {
  // periodic cleanup
  const iv = setInterval(() => {
    const now = Date.now();
    for (const [t, exp] of sessionTokens) if (exp <= now) sessionTokens.delete(t);
  }, 60 * 60 * 1000);
  if (iv.unref) iv.unref();
}
function createSessionToken() {
  const t = randomBytes(32).toString("base64url");
  sessionTokens.set(t, Date.now() + SESSION_TTL_MS);
  return t;
}
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try {
    const ha = createHash("sha256").update(String(a)).digest();
    const hb = createHash("sha256").update(String(b)).digest();
    return timingSafeEqual(ha, hb) && a.length === b.length;
  } catch {
    return false;
  }
}
function isValidSessionToken(tok) {
  if (typeof tok !== "string" || !tok) return false;
  const tokHash = createHash("sha256").update(tok).digest();
  let found = null;
  let exp = 0;
  let matched = false;
  for (const [stored, storedExp] of sessionTokens) {
    try {
      const storedHash = createHash("sha256").update(stored).digest();
      const eq = timingSafeEqual(storedHash, tokHash) && stored.length === tok.length;
      if (eq && !matched) {
        found = stored;
        exp = storedExp;
        matched = true;
      }
    } catch {}
  }
  if (!matched) return false;
  if (exp <= Date.now()) {
    if (found) sessionTokens.delete(found);
    return false;
  }
  return true;
}
function isValidStaticToken(tok) {
  if (!STATIC_TOKEN || typeof tok !== "string") return false;
  try {
    const ha = createHash("sha256").update(String(tok)).digest();
    const hb = createHash("sha256").update(String(STATIC_TOKEN)).digest();
    const eq = timingSafeEqual(ha, hb);
    if (!eq) return false;
    return tok.length === STATIC_TOKEN.length;
  } catch {
    return false;
  }
}
function isValidToken(tok) {
  if (PANEL_PASSWORD) return isValidSessionToken(tok);
  return isValidStaticToken(tok);
}

// Rate limit for /api/login : 5 attempts per minute per IP
const loginAttempts = new Map(); // ip -> { count, windowStart, blockedUntil }
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX = 5;
function getClientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0]?.trim();
    if (xff) {
      if (/^[a-zA-Z0-9:.\-_]+$/.test(xff) && xff.length <= 45) return xff;
      return xff.slice(0, 45);
    }
  }
  return req.socket?.remoteAddress || "unknown";
}
function maskIpForLog(ip) {
  try {
    const s = String(ip || "unknown");
    if (s.includes(":")) return s.split(":").slice(0, 3).join(":") + ":xxx";
    const parts = s.split(".");
    if (parts.length === 4) return parts.slice(0, 3).join(".") + ".xxx";
    return s.slice(0, 8) + ".xxx";
  } catch { return "unknown"; }
}
function checkLoginRateLimit(ip) {
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec) {
    rec = { count: 0, windowStart: now, blockedUntil: 0 };
    loginAttempts.set(ip, rec);
  }
  if (rec.blockedUntil && now < rec.blockedUntil) return { blocked: true, retryAfter: Math.ceil((rec.blockedUntil - now) / 1000) };
  if (now - rec.windowStart > LOGIN_WINDOW_MS) {
    rec.count = 0;
    rec.windowStart = now;
    rec.blockedUntil = 0;
  }
  if (rec.count >= LOGIN_MAX) {
    rec.blockedUntil = now + LOGIN_WINDOW_MS;
    return { blocked: true, retryAfter: Math.ceil((rec.blockedUntil - now) / 1000) };
  }
  return { blocked: false, rec };
}
function recordLoginAttempt(ip, success) {
  if (success) {
    loginAttempts.delete(ip);
    return;
  }
  const r = checkLoginRateLimit(ip);
  if (!r.blocked && r.rec) r.rec.count += 1;
}

export const COLOR_NAMES = {
  red: 0xe74c3c, orange: 0xe67e22, yellow: 0xf1c40f,
  green: 0x2ecc71, teal: 0x1abc9c, blue: 0x3498db,
  darkblue: 0x206694, purple: 0x9b59b6, pink: 0xe91e63,
  white: 0xffffff, gray: 0x95a5a6, dark: 0x2c2f33,
};

let bot = null;

function mainGuild() {
  if (PANEL_GUILD_ID && PANEL_GUILD_ID !== "0") {
    const g = bot.guilds.cache.get(PANEL_GUILD_ID);
    if (g) return g;
  }
  for (const g of bot.guilds.cache.values()) return g;
  return null;
}

function isAllowedOrigin(origin) {
  try {
    const u = new URL(origin);
    const normalized = u.origin;
    if (ALLOWED_ORIGINS.has(normalized) || ALLOWED_ORIGINS.has(origin)) return true;
    return false;
  } catch {
    return false;
  }
}

function requireToken(req) {
  const origin = req.headers.origin;
  const referer = req.headers.referer || req.headers.referrer;
  if (origin) {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      throw { status: 403, text: "bad origin" };
    }
    const originOrigin = originUrl.origin;
    if (!ALLOWED_ORIGINS.has(originOrigin) && !ALLOWED_ORIGINS.has(origin)) {
      throw { status: 403, text: "bad origin" };
    }
  }
  if (referer) {
    let refUrl;
    try {
      refUrl = new URL(referer);
    } catch {
      throw { status: 403, text: "bad referer" };
    }
    const refOrigin = refUrl.origin;
    if (!ALLOWED_ORIGINS.has(refOrigin)) {
      throw { status: 403, text: "bad referer" };
    }
  }

  const token = req.headers["x-panel-token"] || "";
  if (!isValidToken(String(token))) {
    throw { status: 401, text: "bad token" };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    const limit = 10 * 1024 * 1024;

    function fail(err) {
      if (rejected) return;
      rejected = true;
      try { req.removeAllListeners("data"); req.removeAllListeners("end"); req.removeAllListeners("error"); } catch {}
      try { req.pause(); } catch {}
      try {
        if (!req.destroyed) req.destroy();
      } catch {}
      reject(err);
    }

    req.on("data", (c) => {
      if (rejected) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c), "utf-8");
      total += buf.length;
      if (total > limit) {
        const e = new Error("payload too large");
        e.status = 413;
        fail(e);
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (rejected) return;
      if (chunks.length === 0) return resolve({});
      try {
        const data = Buffer.concat(chunks, total).toString("utf-8");
        if (!data) return resolve({});
        resolve(JSON.parse(data));
      } catch (e) {
        const err = new Error("malformed json");
        err.status = 400;
        err.cause = e;
        reject(err);
      }
    });
    req.on("error", (e) => fail(e));
  });
}

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function isValidWebhookUrl(webhookUrl) {
  if (typeof webhookUrl !== "string" || !webhookUrl) return false;
  if (/%2e/i.test(webhookUrl) || /%252e/i.test(webhookUrl) || webhookUrl.includes("\\") || webhookUrl.includes("\0")) return false;
  let u;
  try {
    u = new URL(webhookUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  const allowedHosts = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]);
  const isSubDomain = (h, base) => h === base || h.endsWith("." + base);
  const isAllowedHost = allowedHosts.has(host) || isSubDomain(host, "discord.com") || isSubDomain(host, "discordapp.com");
  if (!isAllowedHost) return false;
  let pathname;
  try {
    pathname = decodeURIComponent(u.pathname);
  } catch {
    return false;
  }
  if (pathname.includes("\0") || pathname.includes("\\")) return false;
  if (!pathname.startsWith("/api/webhooks/")) return false;
  if (pathname.includes("..")) return false;
  if (pathname.includes("//")) return false;
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "webhooks") return false;
  if (!/^\d{16,22}$/.test(parts[2])) return false;
  if (!parts[3] || parts[3].length < 10) return false;
  if (u.search && /(\.\.|\\|%2e)/i.test(u.search)) return false;
  return true;
}

async function webhookRequest(method, url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const init = { method, signal: controller.signal, headers: {} };
    if (payload !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(payload);
    }
    const r = await fetch(url, init);
    const text = await r.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
}

let cachedIndexHtml = null;
try {
  cachedIndexHtml = fs.readFileSync(INDEX_PATH, "utf-8");
} catch {}
function getIndexHtml() {
  if (cachedIndexHtml !== null) return cachedIndexHtml;
  try {
    cachedIndexHtml = fs.readFileSync(INDEX_PATH, "utf-8");
    return cachedIndexHtml;
  } catch {
    return "<!doctype html><html><body>panel unavailable</body></html>";
  }
}

function handleIndex(req, res) {
  let html = getIndexHtml();
  if (PANEL_PASSWORD) {
    html = html.replaceAll("__PANEL_TOKEN__", "");
    html = html.replaceAll("__PANEL_LOGIN__", "true");
  } else {
    html = html.replaceAll("__PANEL_TOKEN__", STATIC_TOKEN);
    html = html.replaceAll("__PANEL_LOGIN__", "false");
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

async function handleLogin(req, res) {
  const ip = getClientIp(req);
  const rl = checkLoginRateLimit(ip);
  if (rl.blocked) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return json(res, { error: "too many attempts, try again later" }, 429);
  }
  let data;
  try {
    data = await readBody(req);
  } catch (e) {
    const status = e.status || 400;
    recordLoginAttempt(ip, false);
    return json(res, { error: e.message || "bad request" }, status);
  }
  const password = (data.password || "").trim();
  let ok = false;
  if (PANEL_PASSWORD) {
    try {
      const ha = createHash("sha256").update(String(password)).digest();
      const hb = createHash("sha256").update(String(PANEL_PASSWORD)).digest();
      ok = timingSafeEqual(ha, hb) && String(password).length === String(PANEL_PASSWORD).length;
      if (!ok) {
        // hash compare already constant-time; length check prevents hash-collision edge
        ok = false;
      } else {
        // ensure exact equality beyond hash
        ok = constantTimeEqual(password, PANEL_PASSWORD);
      }
    } catch {
      ok = false;
    }
  }
  if (PANEL_PASSWORD && ok) {
    recordLoginAttempt(ip, true);
    const tok = createSessionToken();
    return json(res, { token: tok });
  }
  recordLoginAttempt(ip, false);
  return json(res, { error: "wrong password" }, 401);
}

async function handleStatus(req, res) {
  try {
    requireToken(req);
  } catch (e) {
    return json(res, { error: e.text }, e.status);
  }
  const guild = mainGuild();
  return json(res, {
    ok: true,
    bot_online: bot?.readyAt != null,
    bot_name: bot.user?.username ?? null,
    guild_id: guild ? String(guild.id) : null,
    guild_name: guild ? guild.name : null,
  });
}

async function handleChannels(req, res) {
  try {
    requireToken(req);
  } catch (e) {
    return json(res, { error: e.text }, e.status);
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const guildIdParam = url.searchParams.get("guild_id");
  if (guildIdParam && PANEL_GUILD_ID && PANEL_GUILD_ID !== "0") {
    if (String(guildIdParam) !== String(PANEL_GUILD_ID)) return json(res, { error: "forbidden guild" }, 403);
  } else if (guildIdParam && (!PANEL_GUILD_ID || PANEL_GUILD_ID === "0")) {
    if (!/^\d{17,22}$/.test(String(guildIdParam))) return json(res, { error: "forbidden guild" }, 403);
    const requested = bot.guilds.cache.get(String(guildIdParam));
    if (!requested) return json(res, { error: "guild not found" }, 404);
  }
  let guild;
  if (PANEL_GUILD_ID && PANEL_GUILD_ID !== "0") {
    guild = bot.guilds.cache.get(String(PANEL_GUILD_ID));
  } else {
    guild = mainGuild();
  }
  if (!guild) return json(res, { error: "guild not found" }, 404);
  const me = guild.members.me;
  const channels = [];
  for (const c of guild.channels.cache.values()) {
    if (c.type !== ChannelType.GuildText) continue;
    if (!me?.permissionsIn(c).has(0x800)) continue; // SendMessages
    channels.push({
      id: String(c.id),
      name: c.name,
      category: c.parent ? c.parent.name : null,
    });
  }
  channels.sort((a, b) => (a.category || "").localeCompare(b.category || "") || a.name.localeCompare(b.name));
  return json(res, { ok: true, channels });
}

async function handleWebhook(req, res, op) {
  try {
    requireToken(req);
  } catch (e) {
    return json(res, { error: e.text }, e.status);
  }
  let data;
  try {
    data = await readBody(req);
  } catch (e) {
    return json(res, { error: e.message || "bad request" }, e.status || 400);
  }
  let webhookUrl = (data.webhook_url || "").trim();
  const messageId = (data.message_id || "").trim();
  if (!webhookUrl || !isValidWebhookUrl(webhookUrl)) {
    return json(res, { error: "invalid webhook url" }, 400);
  }
  // Validate embeds length etc.
  const rawEmbeds = Array.isArray(data.embeds) ? data.embeds : [];
  if (rawEmbeds.length > 10) return json(res, { error: "too many embeds (max 10)" }, 400);
  // Validate content length (Discord limits 2000)
  const contentLen = String(data.content || "").length;
  if (contentLen > 2000) return json(res, { error: "content too long (max 2000)" }, 400);
  let result;
  try {
    if (op === "send") {
      const embeds = embedsFromClient(data);
      const content = data.content || "";
      if (!(content.trim() || embeds.length)) {
        return json(res, { error: "empty message" }, 400);
      }
      const payload = { content: content || "", embeds, allowed_mentions: { parse: [] } };
      if (!payload.content.trim()) delete payload.content;
      if (!payload.embeds.length) delete payload.embeds;
      result = await webhookRequest("POST", webhookUrl + "?wait=true", payload);
    } else if (op === "fetch") {
      if (!messageId) return json(res, { error: "message_id required" }, 400);
      if (!/^\d{16,22}$/.test(messageId)) return json(res, { error: "invalid message_id" }, 400);
      result = await webhookRequest("GET", `${webhookUrl}/messages/${messageId}`);
    } else if (op === "edit") {
      if (!messageId) return json(res, { error: "message_id required" }, 400);
      if (!/^\d{16,22}$/.test(messageId)) return json(res, { error: "invalid message_id" }, 400);
      const embeds = embedsFromClient(data);
      const content = data.content || "";
      if (!(content.trim() || embeds.length)) {
        return json(res, { error: "empty message" }, 400);
      }
      const payload = { content: content || "", embeds, allowed_mentions: { parse: [] } };
      if (!payload.content.trim()) delete payload.content;
      if (!payload.embeds.length) delete payload.embeds;
      result = await webhookRequest("PATCH", `${webhookUrl}/messages/${messageId}`, payload);
    } else {
      return json(res, { error: "bad op" }, 400);
    }
  } catch (e) {
    return json(res, { error: String(e && e.message || e) }, 502);
  }
  if (result.status >= 400) {
    return json(res, { ok: false, status: result.status, data: result.body }, result.status);
  }
  return json(res, { ok: true, data: result.body });
}

function embedsFromClient(data) {
  const raw = data.embeds || [];
  const out = [];
  for (const e of raw.slice(0, 10)) {
    if (e && typeof e === "object" && (e.title || e.description || e.fields)) {
      const title = e.title ? String(e.title).slice(0, 256) : undefined;
      const description = e.description ? String(e.description).slice(0, 4000) : undefined;
      const emb = {};
      if (title !== undefined) emb.title = title;
      if (description !== undefined) emb.description = description;
      if (Array.isArray(e.fields)) emb.fields = e.fields.slice(0, 25).map(f => ({
        name: String(f.name || "").slice(0, 256),
        value: String(f.value || "").slice(0, 1024),
        inline: !!f.inline,
      }));
      if (e.author && typeof e.author === "object") {
        const an = e.author.name ? String(e.author.name).slice(0, 256) : undefined;
        if (an) {
          emb.author = { name: an };
          if (e.author.icon_url) emb.author.icon_url = String(e.author.icon_url).slice(0, 2048);
          if (e.author.url) emb.author.url = String(e.author.url).slice(0, 2048);
        }
      }
      if (e.footer && typeof e.footer === "object") {
        const ft = e.footer.text ? String(e.footer.text).slice(0, 2048) : undefined;
        if (ft) {
          emb.footer = { text: ft };
          if (e.footer.icon_url) emb.footer.icon_url = String(e.footer.icon_url).slice(0, 2048);
        }
      }
      if (e.thumbnail && typeof e.thumbnail === "object" && e.thumbnail.url) emb.thumbnail = { url: String(e.thumbnail.url).slice(0, 2048) };
      if (e.image && typeof e.image === "object" && e.image.url) emb.image = { url: String(e.image.url).slice(0, 2048) };
      if (e.url) emb.url = String(e.url).slice(0, 2048);
      if (e.timestamp) {
        const ts = Date.parse(String(e.timestamp));
        if (Number.isFinite(ts)) emb.timestamp = new Date(ts).toISOString();
      }
      if (e.color !== undefined || e.colour !== undefined) {
        const rawColor = e.color !== undefined ? e.color : e.colour;
        const c = Number(rawColor);
        if (Number.isInteger(c) && c >= 0 && c <= 0xFFFFFF) emb.color = c;
      }
      out.push(emb);
    }
  }
  return out;
}

function isChannelAllowed(channel) {
  if (!channel) return false;
  if (typeof channel.isDMBased === "function" && channel.isDMBased()) return false;
  if (channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM) return false;
  if (!channel.guildId && !channel.guild) return false;
  if (PANEL_GUILD_ID && PANEL_GUILD_ID !== "0") {
    const gid = String(channel.guildId || channel.guild?.id || "");
    if (gid !== String(PANEL_GUILD_ID)) return false;
  }
  const gidCheck = String(channel.guildId || channel.guild?.id || "");
  if (gidCheck && !/^\d{17,22}$/.test(gidCheck)) return false;
  return true;
}

async function handleBotSend(req, res) {
  try {
    requireToken(req);
  } catch (e) {
    return json(res, { error: e.text }, e.status);
  }
  let data;
  try {
    data = await readBody(req);
  } catch (e) {
    return json(res, { error: e.message || "bad request" }, e.status || 400);
  }
  if (data.guild_id) {
    const gid = String(data.guild_id);
    if (!/^\d{17,22}$/.test(gid)) return json(res, { error: "forbidden guild" }, 403);
    if (PANEL_GUILD_ID && PANEL_GUILD_ID !== "0" && gid !== String(PANEL_GUILD_ID)) {
      return json(res, { error: "forbidden guild" }, 403);
    }
    if ((!PANEL_GUILD_ID || PANEL_GUILD_ID === "0") && !bot.guilds.cache.has(gid)) {
      return json(res, { error: "guild not found" }, 404);
    }
  }
  const channel = bot.channels.cache.get(String(data.channel_id || ""));
  if (!channel) return json(res, { error: "channel not found" }, 404);
  if (!isChannelAllowed(channel)) return json(res, { error: "channel not in allowed guild" }, 403);
  const embeds = embedsFromClient(data);
  const content = data.content || "";
  if (!(content.trim() || embeds.length)) return json(res, { error: "empty message" }, 400);
  if (content.length > 2000) return json(res, { error: "content too long" }, 400);
  try {
    const msg = await channel.send({
      content: content.trim() ? content : undefined,
      embeds: embeds.length ? embeds : undefined,
      allowedMentions: { parse: [] },
    });
    return json(res, { ok: true, message_id: String(msg.id) });
  } catch (e) {
    return json(res, { error: String(e && e.message || e) }, 400);
  }
}

async function handleBotEdit(req, res) {
  try {
    requireToken(req);
  } catch (e) {
    return json(res, { error: e.text }, e.status);
  }
  let data;
  try {
    data = await readBody(req);
  } catch (e) {
    return json(res, { error: e.message || "bad request" }, e.status || 400);
  }
  if (data.guild_id) {
    const gid = String(data.guild_id);
    if (!/^\d{17,22}$/.test(gid)) return json(res, { error: "forbidden guild" }, 403);
    if (PANEL_GUILD_ID && PANEL_GUILD_ID !== "0" && gid !== String(PANEL_GUILD_ID)) {
      return json(res, { error: "forbidden guild" }, 403);
    }
    if ((!PANEL_GUILD_ID || PANEL_GUILD_ID === "0") && !bot.guilds.cache.has(gid)) {
      return json(res, { error: "guild not found" }, 404);
    }
  }
  const channel = bot.channels.cache.get(String(data.channel_id || ""));
  let messageId;
  try { messageId = BigInt(data.message_id || 0); } catch { return json(res, { error: "invalid message_id" }, 400); }
  if (!channel) return json(res, { error: "channel not found" }, 404);
  if (!isChannelAllowed(channel)) return json(res, { error: "channel not in allowed guild" }, 403);
  if (!messageId) return json(res, { error: "message_id required" }, 400);
  const embeds = embedsFromClient(data);
  const content = data.content || "";
  if (!(content.trim() || embeds.length)) return json(res, { error: "empty message" }, 400);
  if (content.length > 2000) return json(res, { error: "content too long" }, 400);
  try {
    const msg = await channel.messages.fetch(messageId);
    if (String(msg.channelId) !== String(channel.id)) return json(res, { error: "message not in channel" }, 403);
    await msg.edit({
      content: content.trim() ? content : undefined,
      embeds: embeds.length ? embeds : undefined,
      allowedMentions: { parse: [] },
    });
    return json(res, { ok: true, message_id: String(msg.id) });
  } catch (e) {
    return json(res, { error: String(e && e.message || e) }, 400);
  }
}

async function handleBotFetch(req, res) {
  try {
    requireToken(req);
  } catch (e) {
    return json(res, { error: e.text }, e.status);
  }
  let data;
  try {
    data = await readBody(req);
  } catch (e) {
    return json(res, { error: e.message || "bad request" }, e.status || 400);
  }
  if (data.guild_id) {
    const gid = String(data.guild_id);
    if (!/^\d{17,22}$/.test(gid)) return json(res, { error: "forbidden guild" }, 403);
    if (PANEL_GUILD_ID && PANEL_GUILD_ID !== "0" && gid !== String(PANEL_GUILD_ID)) {
      return json(res, { error: "forbidden guild" }, 403);
    }
    if ((!PANEL_GUILD_ID || PANEL_GUILD_ID === "0") && !bot.guilds.cache.has(gid)) {
      return json(res, { error: "guild not found" }, 404);
    }
  }
  const channel = bot.channels.cache.get(String(data.channel_id || ""));
  let messageId;
  try { messageId = BigInt(data.message_id || 0); } catch { return json(res, { error: "invalid message_id" }, 400); }
  if (!channel) return json(res, { error: "channel not found" }, 404);
  if (!isChannelAllowed(channel)) return json(res, { error: "channel not in allowed guild" }, 403);
  if (!messageId) return json(res, { error: "message_id required" }, 400);
  try {
    const msg = await channel.messages.fetch(messageId);
    if (String(msg.channelId) !== String(channel.id)) return json(res, { error: "message not in channel" }, 403);
    return json(res, {
      ok: true,
      data: {
        content: msg.content || "",
        embeds: msg.embeds.map((e) => e.toJSON()),
        message_id: String(msg.id),
      },
    });
  } catch (e) {
    return json(res, { error: String(e && e.message || e) }, 400);
  }
}

export async function start(botClient) {
  bot = botClient;
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const p = url.pathname;
        if (req.method === "GET" && (p === "/" || p === "/admin/embed-constructor")) {
          return handleIndex(req, res);
        }
        if (req.method === "POST" && p === "/api/login") {
          return await handleLogin(req, res);
        }
        if (req.method === "GET" && p === "/api/status") {
          return await handleStatus(req, res);
        }
        if (req.method === "GET" && p === "/api/bot/channels") {
          return await handleChannels(req, res);
        }
        if (req.method === "POST" && p === "/api/webhook/send") {
          return await handleWebhook(req, res, "send");
        }
        if (req.method === "POST" && p === "/api/webhook/edit") {
          return await handleWebhook(req, res, "edit");
        }
        if (req.method === "POST" && p === "/api/webhook/fetch") {
          return await handleWebhook(req, res, "fetch");
        }
        if (req.method === "POST" && p === "/api/bot/send") {
          return await handleBotSend(req, res);
        }
        if (req.method === "POST" && p === "/api/bot/edit") {
          return await handleBotEdit(req, res);
        }
        if (req.method === "POST" && p === "/api/bot/fetch") {
          return await handleBotFetch(req, res);
        }
        return json(res, { error: "not found" }, 404);
      } catch (e) {
        try {
          const status = e.status || 500;
          json(res, { error: String(e && e.message || e) }, status);
        } catch {}
      }
    });
    server.listen(PANEL_PORT, PANEL_HOST, () => {
      console.log(`[WEBPANEL] http://${PANEL_HOST}:${PANEL_PORT}/admin/embed-constructor`);
      resolve(server);
    });
    server.on("error", (e) => {
      console.error(`[WEBPANEL] Не удалось занять порт ${PANEL_PORT}: ${e.message}`);
      reject(e);
    });
  });
}

export function panelInfo() {
  return {
    host: PANEL_HOST,
    port: PANEL_PORT,
    publicUrl: PANEL_PUBLIC_URL,
    hasPassword: Boolean(PANEL_PASSWORD),
  };
}
