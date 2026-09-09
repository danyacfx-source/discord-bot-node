import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(BASE_DIR, "webpanel", "index.html");

const PANEL_HOST = process.env.PANEL_HOST || "0.0.0.0";
const PANEL_PORT = Number(process.env.PORT || process.env.PANEL_PORT || "17890");
const PANEL_PASSWORD = (process.env.PANEL_PASSWORD || "").trim();
const PANEL_PUBLIC_URL = (process.env.PANEL_PUBLIC_URL || "").trim().replace(/\/+$/, "");
const ALLOWED_ORIGINS = new Set([
  `http://${PANEL_HOST}:${PANEL_PORT}`,
  `http://localhost:${PANEL_PORT}`,
]);
if (PANEL_PUBLIC_URL) ALLOWED_ORIGINS.add(PANEL_PUBLIC_URL);
const TOKEN = randomBytes(32).toString("base64url");

export const COLOR_NAMES = {
  red: 0xe74c3c, orange: 0xe67e22, yellow: 0xf1c40f,
  green: 0x2ecc71, teal: 0x1abc9c, blue: 0x3498db,
  darkblue: 0x206694, purple: 0x9b59b6, pink: 0xe91e63,
  white: 0xffffff, gray: 0x95a5a6, dark: 0x2c2f33,
};

let bot = null;

function mainGuild() {
  for (const g of bot.guilds.cache.values()) return g;
  return null;
}

function requireToken(req) {
  const origin = req.headers.origin;
  if (origin) {
    const hostHeader = (req.headers.host || "");
    const oh = origin.split("://")[1]?.split("/")[0]?.split(":")[0]?.toLowerCase() || origin.toLowerCase();
    const host = hostHeader.split(":")[0]?.toLowerCase() || hostHeader.toLowerCase();
    if (oh !== host && !ALLOWED_ORIGINS.has(origin)) {
      throw { status: 403, text: "bad origin" };
    }
  }
  if (req.headers["x-panel-token"] !== TOKEN) {
    throw { status: 401, text: "bad token" };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 10 * 1024 * 1024) {
        req.destroy();
        reject(new Error("payload too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
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

function handleIndex(req, res) {
  let html = fs.readFileSync(INDEX_PATH, "utf-8");
  if (PANEL_PASSWORD) {
    html = html.replaceAll("__PANEL_TOKEN__", "");
    html = html.replaceAll("__PANEL_LOGIN__", "true");
  } else {
    html = html.replaceAll("__PANEL_TOKEN__", TOKEN);
    html = html.replaceAll("__PANEL_LOGIN__", "false");
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

async function handleLogin(req, res) {
  const data = await readBody(req);
  const password = data.password || "";
  if (PANEL_PASSWORD && password === PANEL_PASSWORD) {
    return json(res, { token: TOKEN });
  }
  return json(res, { error: "wrong password" }, 401);
}

async function handleStatus(req, res) {
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
  const guildId = url.searchParams.get("guild_id");
  const guild = bot.guilds.cache.get(guildId ? BigInt(guildId) : null) || mainGuild();
  if (!guild) return json(res, { error: "guild not found" }, 404);
  const me = guild.members.me;
  const channels = [];
  for (const c of guild.channels.cache.values()) {
    if (c.type !== 0) continue; // С‚РµРєСЃС‚
    if (!me?.permissionsIn(c).has(0x800)) continue; // SendMessages
    channels.push({
      id: String(c.id),
      name: c.name,
      category: c.parent ? c.parent.name : null,
      nsfw: c.nsfw,
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
  const data = await readBody(req);
  let webhookUrl = (data.webhook_url || "").trim();
  const messageId = (data.message_id || "").trim();
  if (!webhookUrl.startsWith("https://discord.com/api/webhooks/")) {
    return json(res, { error: "invalid webhook url" }, 400);
  }
  let result;
  try {
    if (op === "send") {
      const payload = { content: data.content || "", embeds: data.embeds || [] };
      if (!(payload.content.trim() || payload.embeds.length)) {
        return json(res, { error: "empty message" }, 400);
      }
      result = await webhookRequest("POST", webhookUrl + "?wait=true", payload);
    } else if (op === "fetch") {
      if (!messageId) return json(res, { error: "message_id required" }, 400);
      result = await webhookRequest("GET", `${webhookUrl}/messages/${messageId}`);
    } else if (op === "edit") {
      if (!messageId) return json(res, { error: "message_id required" }, 400);
      const payload = { content: data.content || "", embeds: data.embeds || [] };
      if (!(payload.content.trim() || payload.embeds.length)) {
        return json(res, { error: "empty message" }, 400);
      }
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
      out.push(e);
    }
  }
  return out;
}

async function handleBotSend(req, res) {
  try {
    requireToken(req);
  } catch (e) {
    return json(res, { error: e.text }, e.status);
  }
  const data = await readBody(req);
  const channel = bot.channels.cache.get(String(data.channel_id || ""));
  if (!channel) return json(res, { error: "channel not found" }, 404);
  const embeds = embedsFromClient(data);
  const content = data.content || "";
  if (!(content.trim() || embeds.length)) return json(res, { error: "empty message" }, 400);
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
  const data = await readBody(req);
  const channel = bot.channels.cache.get(String(data.channel_id || ""));
  const messageId = BigInt(data.message_id || 0);
  if (!channel) return json(res, { error: "channel not found" }, 404);
  if (!messageId) return json(res, { error: "message_id required" }, 400);
  const embeds = embedsFromClient(data);
  const content = data.content || "";
  if (!(content.trim() || embeds.length)) return json(res, { error: "empty message" }, 400);
  try {
    const msg = await channel.messages.fetch(messageId);
    await msg.edit({
      content: content.trim() ? content : undefined,
      embeds: embeds.length ? embeds : undefined,
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
  const data = await readBody(req);
  const channel = bot.channels.cache.get(String(data.channel_id || ""));
  const messageId = BigInt(data.message_id || 0);
  if (!channel) return json(res, { error: "channel not found" }, 404);
  if (!messageId) return json(res, { error: "message_id required" }, 400);
  try {
    const msg = await channel.messages.fetch(messageId);
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
  return new Promise((resolve) => {
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
          json(res, { error: String(e && e.message || e) }, 500);
        } catch {}
      }
    });
    server.listen(PANEL_PORT, PANEL_HOST, () => {
      console.log(`[WEBPANEL] http://${PANEL_HOST}:${PANEL_PORT}/admin/embed-constructor`);
      resolve(server);
    });
    server.on("error", (e) => {
      console.error(`[WEBPANEL] РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РЅСЏС‚СЊ РїРѕСЂС‚ ${PANEL_PORT}: ${e.message}`);
      resolve(server);
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