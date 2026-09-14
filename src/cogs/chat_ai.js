import { CONFIG } from "../config.js";
import { log } from "../notify.js";
import { PermissionFlagsBits } from "discord.js";

const cfg = CONFIG.ai || {};
if (cfg.api_key && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  log.warn("ChatAI", "cfg.api_key игнорируется — используй GEMINI_API_KEY из окружения");
}
const API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
  process.env.OPENROUTER_API_KEY ||
  cfg.api_key ||
  "";
const MODEL = cfg.model || "gemini-3.6-flash";
const COOLDOWN_MS = Math.max(5, cfg.cooldown_seconds || 45) * 1000;
const CHANNELS = new Set((cfg.channels || []).map(String));
const HISTORY_SIZE = Math.max(2, cfg.history_size || 12);
const MAX_TOKENS = cfg.max_tokens || 220;
const TIMEOUT_MS = Math.max(10, cfg.timeout_seconds || 45) * 1000;
const TEMPERATURE = typeof cfg.temperature === "number" ? cfg.temperature : 0.9;

const DEFAULT_PROMPT =
  "Ты — бот «Милый Килла» на сервере стримера и гильдии WARDOGS. " +
  "Отвечаешь кратко, живо и с юмором, как живой собеседник. " +
  "Пишешь на русском. Не перечисляй списки, не будь канцелярским. " +
  "Можешь мягко подкалывать, но оставайся дружелюбным и без мата.";

const SYSTEM_PROMPT = cfg.system_prompt || DEFAULT_PROMPT;

const lastReply = new Map();
const pendingTimers = new Map();

function inEnabledChannel(channelId) {
  return CHANNELS.has(String(channelId));
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, options, maxRetries = 2) {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 && attempt < maxRetries) {
        const retry = Number(res.headers.get("retry-after")) || 5;
        log.warn("ChatAI", `Gemini rate limit (429), повтор через ${retry}с`);
        await delay(retry * 1000);
        attempt++;
        continue;
      }
      if (res.status >= 500 && res.status < 600 && attempt < maxRetries) {
        const backoff = 1000 * Math.pow(2, attempt + 1);
        log.warn("ChatAI", `Gemini server error ${res.status}, повтор через ${backoff / 1000}с`);
        await delay(backoff);
        attempt++;
        continue;
      }
      return res;
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      log.warn("ChatAI", `Сеть Gemini: ${e.message}, повтор ${attempt + 1}/${maxRetries}`);
      attempt++;
      await delay(1000 * Math.pow(2, attempt));
    }
  }
}

function toGeminiPayload(messages) {
  let systemText = "";
  const contents = [];
  for (const m of messages) {
    if (m.role === "system" && !systemText) {
      systemText = String(m.content || "");
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    const text = String(m.content || "").slice(0, 2000);
    if (!text.trim()) continue;
    contents.push({ role, parts: [{ text }] });
  }
  if (!contents.length) contents.push({ role: "user", parts: [{ text: "Привет" }] });
  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    },
  };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  return body;
}

async function askAI(messages) {
  if (!API_KEY) throw new Error("GEMINI_API_KEY не задан (укажи в .env)");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(API_KEY)}`;
  const body = toGeminiPayload(messages);
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string" || !text.trim()) {
    const block = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
    throw new Error(block ? `Заблокировано: ${block}` : "Пустой ответ Gemini");
  }
  return text.trim();
}

function canBotSendInChannel(channel) {
  try {
    if (!channel || !channel.guild) return false;
    const me = channel.guild.members.me;
    if (!me) return true;
    const perms = channel.permissionsFor(me);
    if (!perms) return true;
    if (channel.isThread?.()) {
      if (!perms.has(PermissionFlagsBits.SendMessagesInThreads)) return false;
      if (!perms.has(PermissionFlagsBits.ViewChannel)) return false;
    } else {
      if (!perms.has(PermissionFlagsBits.SendMessages)) return false;
      if (!perms.has(PermissionFlagsBits.ViewChannel)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

async function buildContext(channel, currentId) {
  const messages = [];
  try {
    if (!canBotSendInChannel(channel)) return messages;
    if (channel.isThread?.() && !channel.permissionsFor?.(channel.guild.members.me)?.has(PermissionFlagsBits.ReadMessageHistory)) {
      return messages;
    }
    const fetched = await channel.messages.fetch({ limit: HISTORY_SIZE });
    const ordered = [...fetched.values()].reverse();
    for (const m of ordered) {
      if (String(m.id) === String(currentId)) continue;
      if (m.author?.bot) continue;
      const name = m.member?.displayName || m.author?.username || "User";
      const content = (m.content || "").slice(0, 400);
      if (!content.trim()) continue;
      messages.push({ role: "user", content: `${name}: ${content}` });
    }
  } catch (e) {
    log.warn("ChatAI", `Контекст не получен: ${e.message}`);
  }
  return messages;
}

async function respond(message) {
  if (!canBotSendInChannel(message.channel)) {
    log.warn("ChatAI", `Нет прав для отправки в #${message.channel?.name || message.channel.id}`);
    clearPending(String(message.channel.id));
    return;
  }
  const channelId = String(message.channel.id);
  const base = [{ role: "system", content: SYSTEM_PROMPT }];
  const context = await buildContext(message.channel, message.id);
  const userContent = (message.content || "").slice(0, 400);
  const messages = [...base, ...context, { role: "user", content: userContent }];
  try {
    const text = await askAI(messages);
    const chunked = text.match(/[\s\S]{1,1900}/g) || [text];
    await message.reply(chunked[0]);
    if (chunked.length > 1) {
      for (const part of chunked.slice(1)) await message.channel.send(part);
    }
    lastReply.set(channelId, Date.now());
    log.info("ChatAI", `Gemini ответ в #${message.channel.name} (${text.length} символов)`);
  } catch (e) {
    log.error("ChatAI", `Gemini не удалось ответить: ${e.message}`, e);
    clearPending(channelId);
  }
}

function clearPending(channelId) {
  const key = String(channelId);
  const t = pendingTimers.get(key);
  if (t) {
    clearTimeout(t);
    pendingTimers.delete(key);
  }
}

function schedule(channelId, message) {
  clearPending(channelId);
  const key = String(channelId);
  const timer = setTimeout(() => {
    pendingTimers.delete(key);
    if (message.channel) void respond(message);
  }, COOLDOWN_MS);
  pendingTimers.set(key, timer);
}

async function handleMessage(message) {
  if (!cfg.enabled) return;
  if (!API_KEY) return;
  if (message.author?.bot) return;
  if (!message.guild) return;
  const channelId = String(message.channel.id);
  const parentId = message.channel.isThread?.() ? String(message.channel.parentId) : null;
  if (!inEnabledChannel(channelId) && !(parentId && inEnabledChannel(parentId))) return;
  if (!canBotSendInChannel(message.channel)) return;
  const content = (message.content || "").trim();
  if (!content) return;
  const last = lastReply.get(channelId) || 0;
  const elapsed = Date.now() - last;
  if (elapsed >= COOLDOWN_MS) void respond(message);
  else schedule(channelId, message);
}

const cog = {
  name: "ChatAI",
  async setup(registry) {
    if (!cfg.enabled) {
      log.info("ChatAI", "Gemini-ответы отключены в конфиге (ai.enabled=false)");
      return;
    }
    if (!CHANNELS.size) log.warn("ChatAI", "ai.channels пуст — бот нигде не отвечает");
    if (!API_KEY) log.warn("ChatAI", "GEMINI_API_KEY не задан — Gemini-ответы отключены (укажи GEMINI_API_KEY в .env)");

    registry.event("messageCreate", handleMessage);
    registry.slash({
      name: "ai_status",
      description: "Статус Gemini-ответов в чате",
      guildOnly: true,
      options: [],
      async run(interaction) {
        const channels = CHANNELS.size ? [...CHANNELS].map((id) => `<#${id}>`).join(", ") : "не заданы";
        await interaction.reply({
          content: [`Провайдер: Gemini AI`, `Модель: \`${MODEL}\``, `Кулдаун: ${COOLDOWN_MS / 1000}с`, `Ключ: ${API_KEY ? "есть (env GEMINI_API_KEY)" : "не задан"}`, `Каналы: ${channels}`].join("\n"),
          ephemeral: true,
        });
      },
    });
  },
};

export default cog;
