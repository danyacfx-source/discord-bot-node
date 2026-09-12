import WebSocket from "ws";
import { EmbedBuilder } from "discord.js";
import { CONFIG } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.kick_mod || {};
const TOKEN = process.env.KICK_ACCESS_TOKEN || cfg.access_token || "";
const KICK_API = "https://api.kick.com/public/v1";
const CHANNEL = cfg.channel || CONFIG.kick?.channel || "dendosich";
const ALLOWED_ROLES = new Set(cfg.allowed_roles || ["Owner", "Moderator"]);
const TIMEOUT_MAX = 10080; // неделя в минутах
const PUSHER_KEY = "32cbd69e4b950bf97679"; // публичный ключ Kick
const PUSHER_URL = `wss://ws-us2.pusher.com/app/${PUSHER_KEY}?protocol=7&client=js&version=8.4.0&flash=false`;
const BANNED_WORDS = (cfg.banned_words || []).map((w) => w.toLowerCase());
const DELETE_MESSAGES = cfg.delete_messages !== false && BANNED_WORDS.length > 0;

const COLOR = 0xe74c3c;
let broadcaster = null;
let chatroomId = null;
let ws = null;
let reconnectTimer = null;
let shuttingDown = false;

function matchBannedWord(content) {
  if (!BANNED_WORDS.length) return null;
  const lower = content.toLowerCase();
  return BANNED_WORDS.find((w) => lower.includes(w)) || null;
}

async function api(path, method = "GET", body) {
  if (!TOKEN) throw new Error("Kick Dev токен не настроен (KICK_ACCESS_TOKEN)");
  const res = await fetch(KICK_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.message || data?.data?.message || `Kick API ${res.status}`;
    throw new Error(msg);
  }
  return data?.data ?? data;
}

async function getBroadcaster() {
  if (broadcaster) return broadcaster;
  // Личный аккаунт: GET /public/v1/users без параметров возвращает текущего юзера
  const me = await api("/users");
  const u = Array.isArray(me) ? me[0] : me;
  if (!u?.user_id) throw new Error("Не удалось определить твой user_id — токен должен быть от личного аккаунта");
  broadcaster = { user_id: Number(u.user_id), name: u.name || u.username || "" };
  return broadcaster;
}

async function resolveUser(username) {
  const clean = String(username || "").replace(/^@/, "").trim().toLowerCase();
  if (!clean) throw new Error("Укажи ник пользователя");
  // Официальная API резолвит только по id, по нику идём через публичный api/v1/users
  const res = await fetch(`https://kick.com/api/v1/users/${encodeURIComponent(clean)}`, {
    headers: { Accept: "application/json", "User-Agent": "DiscordBot/1.0" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Пользователь «${clean}» не найден на Kick`);
  const u = await res.json();
  if (!u?.id) throw new Error(`Не удалось получить user_id для «${clean}»`);
  return { user_id: Number(u.id), username: u.username || clean };
}

const mod = (interaction) => {
  const member = interaction.member;
  if (!member) return false;
  if (!cfg.allowed_roles?.length) return true; // список пустой — доступно всем
  return member.roles.cache.some((r) => ALLOWED_ROLES.has(r.name));
};

const denied = (interaction) => {
  const roles = [...ALLOWED_ROLES].join(", ");
  return interaction.reply({
    content: `⛔ У тебя нет прав (нужна роль: ${roles})`,
    ephemeral: true,
  });
};

const done = (interaction, title, desc, extra = []) =>
  interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(title)
        .setDescription(desc)
        .setColor(COLOR)
        .addFields(extra)
        .setFooter({ text: `Канал: ${CHANNEL}` })
        .setTimestamp(),
    ],
  });

// ---------- Pusher WS: чтение чата + автоделит запретных слов ----------

async function ensureChatroomId() {
  if (chatroomId) return chatroomId;
  const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(CHANNEL)}/chatroom`, {
    headers: { Accept: "application/json", "User-Agent": "DiscordBot/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Не удалось получить chatroom (HTTP ${res.status})`);
  const data = await res.json();
  chatroomId = data.id;
  return chatroomId;
}

async function deleteMessage(messageId) {
  const res = await fetch(`${KICK_API}/chat/${encodeURIComponent(messageId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok && res.status !== 204) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message || `HTTP ${res.status}`);
  }
}

async function handleChatEvent(payload) {
  if (!TOKEN || !DELETE_MESSAGES) return;
  const data = payload?.data;
  if (!data) return;
  const msg = typeof data === "string" ? JSON.parse(data) : data;
  const content = msg?.content || "";
  const banned = matchBannedWord(content);
  if (!banned) return;
  const messageId = msg?.id || msg?.message_id;
  if (!messageId) return;
  const sender = msg?.sender?.username || "?";
  try {
    await deleteMessage(messageId);
    log.info("KickMod", `Автоделит: ${sender}: «${content.slice(0, 80)}» (слово «${banned}»)`);
  } catch (e) {
    log.error("KickMod", `Не удалось удалить сообщение ${messageId} (${sender}): ${e.message}`);
  }
}

function connectPusher() {
  if (!chatroomId) return;
  try {
    ws = new WebSocket(PUSHER_URL);
    const channel = `chatrooms.${chatroomId}.v2`;
    let established = false;

    ws.on("open", () => {
      ws.send(JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel } }));
    });

    ws.on("message", (raw) => {
      const text = raw.toString();
      if (text.includes("pusher:connection_established")) {
        established = true;
        return;
      }
      if (text.includes("pusher_internal:subscription_succeeded")) {
        log.info("KickMod", `Подключено к чату kick.com/${CHANNEL} (${channel})${TOKEN && DELETE_MESSAGES ? " · автоделит вкл" : " · только чтение"}`);
        return;
      }
      try {
        const j = JSON.parse(text);
        if (j.event === "App\\Events\\ChatMessageEvent") handleChatEvent(j).catch(() => {});
      } catch {}
    });

    ws.on("error", (e) => {
      log.error("KickMod", `WebSocket error: ${e.message}`);
    });

    ws.on("close", () => {
      if (shuttingDown) return;
      if (!reconnectTimer) reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        log.info("KickMod", "Переподключение к чату…");
        connectPusher();
      }, 5000);
    });
  } catch (e) {
    log.error("KickMod", `Не удалось подключиться к чату: ${e.message}`);
  }
}

function stopPusher() {
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    try { ws.terminate(); } catch {}
    ws = null;
  }
}

const cog = {
  name: "KickMod",

  async setup(registry) {
    if (!cfg.enabled) {
      log.info("KickMod", "Kick-модерация отключена в конфиге (kick_mod.enabled=false)");
      return;
    }

    registry.event("clientReady", async () => {
      try {
        await ensureChatroomId();
        connectPusher();
      } catch (e) {
        log.error("KickMod", `Pusher: ${e.message}`);
      }
    });

    process.on("exit", stopPusher);
    process.on("SIGINT", () => { stopPusher(); process.exit(0); });
    process.on("SIGTERM", () => { stopPusher(); process.exit(0); });

    // ---- Бан (навсегда) ----
    registry.slash({
      name: "kick_ban",
      description: "Забанить пользователя в чате Kick навсегда",
      guildOnly: true,
      options: [
        { name: "username", description: "Ник на Kick", type: 3, required: true },
        { name: "reason", description: "Причина (до 100 символов)", type: 3, required: false },
      ],
      async run(interaction) {
        if (!mod(interaction)) return denied(interaction);
        const username = interaction.options.getString("username", true);
        const reason = interaction.options.getString("reason") || "";
        await interaction.deferReply();
        try {
          const bc = await getBroadcaster();
          const user = await resolveUser(username);
          await api("/moderation/bans", "POST", {
            broadcaster_user_id: bc.user_id,
            user_id: user.user_id,
            reason: reason.slice(0, 100),
          });
          log.info("KickMod", `Бан ${user.username} (${user.user_id}) в ${CHANNEL} (${reason})`);
          await done(interaction, "🔨 Пользователь забанен", `**${user.username}** забанен в чате ${CHANNEL} навсегда.`, [
            { name: "Причина", value: reason.slice(0, 100) || "не указана", inline: false },
          ]);
        } catch (e) {
          await interaction.editReply({ content: `❌ Ошибка: ${e.message}` });
        }
      },
    });

    // ---- Таймаут (мут) ----
    registry.slash({
      name: "kick_timeout",
      description: "Таймаут пользователя в чате Kick (1–10080 минут)",
      guildOnly: true,
      options: [
        { name: "username", description: "Ник на Kick", type: 3, required: true },
        { name: "minutes", description: "Минуты (1–10080)", type: 4, required: true },
        { name: "reason", description: "Причина (до 100 символов)", type: 3, required: false },
      ],
      async run(interaction) {
        if (!mod(interaction)) return denied(interaction);
        const username = interaction.options.getString("username", true);
        const minutes = interaction.options.getInteger("minutes", true);
        const reason = interaction.options.getString("reason") || "";
        const mins = Math.max(1, Math.min(TIMEOUT_MAX, minutes));
        await interaction.deferReply();
        try {
          const bc = await getBroadcaster();
          const user = await resolveUser(username);
          await api("/moderation/bans", "POST", {
            broadcaster_user_id: bc.user_id,
            user_id: user.user_id,
            duration: mins,
            reason: reason.slice(0, 100),
          });
          log.info("KickMod", `Таймаут ${user.username} (${user.user_id}) ${mins} мин в ${CHANNEL} (${reason})`);
          const h = mins >= 60 ? `${(mins / 60).toFixed(mins % 60 ? 1 : 0)} ч ` : "";
          await done(interaction, "⏱️ Таймаут применён", `**${user.username}** в муте в чате ${CHANNEL}.`, [
            { name: "Длительность", value: `${mins} мин${h ? ` (${h})` : ""}`, inline: true },
            { name: "Причина", value: reason.slice(0, 100) || "не указана", inline: true },
          ]);
        } catch (e) {
          await interaction.editReply({ content: `❌ Ошибка: ${e.message}` });
        }
      },
    });

    // ---- Разбан ----
    registry.slash({
      name: "kick_unban",
      description: "Разбанить / снять таймаут с пользователя в чате Kick",
      guildOnly: true,
      options: [
        { name: "username", description: "Ник на Kick", type: 3, required: true },
      ],
      async run(interaction) {
        if (!mod(interaction)) return denied(interaction);
        const username = interaction.options.getString("username", true);
        await interaction.deferReply();
        try {
          const bc = await getBroadcaster();
          const user = await resolveUser(username);
          await api("/moderation/bans", "DELETE", {
            broadcaster_user_id: bc.user_id,
            user_id: user.user_id,
          });
          log.info("KickMod", `Разбан ${user.username} (${user.user_id}) в ${CHANNEL}`);
          await done(interaction, "✅ Снято ограничение", `С **${user.username}** снят бан/таймаут в чате ${CHANNEL}.`);
        } catch (e) {
          await interaction.editReply({ content: `❌ Ошибка: ${e.message}` });
        }
      },
    });
  },
};

export default cog;