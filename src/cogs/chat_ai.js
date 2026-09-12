import { CONFIG } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.ai || {};
const API_KEY = process.env.OPENROUTER_API_KEY || cfg.api_key || "";
const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = cfg.model || "meta-llama/llama-3.3-70b-instruct:free";
const COOLDOWN_MS = Math.max(5, cfg.cooldown_seconds || 45) * 1000;
const CHANNELS = new Set((cfg.channels || []).map(String));
const HISTORY_SIZE = Math.max(2, cfg.history_size || 12);
const MAX_TOKENS = cfg.max_tokens || 220;
const TIMEOUT_MS = Math.max(10, cfg.timeout_seconds || 45) * 1000;
const TEMPERATURE =
  typeof cfg.temperature === "number" ? cfg.temperature : 0.9;

const DEFAULT_PROMPT =
  "Ты — бот «Милый Килла» на сервере стримера и гильдии WARDOGS. " +
  "Отвечаешь кратко, живо и с юмором, как живой собеседник. " +
  "Пишешь на русском. Не перечисляй списки, не будь канцелярским. " +
  "Можешь мягко подкалывать, но оставайся дружелюбным и без мата.";

const SYSTEM_PROMPT = cfg.system_prompt || DEFAULT_PROMPT;

// Состояние кулдауна по каналам: channelId -> время последнего ответа
const lastReply = new Map();
const pendingTimers = new Map();

function inEnabledChannel(channelId) {
  return CHANNELS.has(String(channelId));
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(path, options, maxRetries = 2) {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(path, options);
      if (res.status === 429 && attempt < maxRetries) {
        const retry = Number(res.headers.get("retry-after")) || 5;
        log.warn("ChatAI", `Rate limit (429), повтор через ${retry}с`);
        await delay(retry * 1000);
        attempt++;
        continue;
      }
      return res;
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      log.warn("ChatAI", `Сеть: ${e.message}, повтор ${attempt + 1}/${maxRetries}`);
      attempt++;
      await delay(2 * Math.pow(2, attempt));
    }
  }
}

async function askAI(messages) {
  const res = await fetchWithRetry(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("Пустой ответ модели");
  return text.trim();
}

// Собираем последние сообщения канала перед текущим как контекст
async function buildContext(channel, currentId) {
  const messages = [];
  try {
    const fetched = await channel.messages.fetch({ limit: HISTORY_SIZE });
    const ordered = [...fetched.values()].reverse();
    for (const m of ordered) {
      if (m.id === currentId) continue;
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
  const channelId = message.channel.id;
  const base = [ { role: "system", content: SYSTEM_PROMPT } ];
  const context = await buildContext(message.channel, message.id);
  const userContent = (message.content || "").slice(0, 400);

  const messages = [...base, ...context, { role: "user", content: userContent }];

  try {
    const text = await askAI(messages);
    const chunked = text.match(/[\s\S]{1,1900}/g) || [text];
    await message.reply(chunked[0]);
    if (chunked.length > 1) {
      for (const part of chunked.slice(1)) {
        await message.channel.send(part);
      }
    }
    lastReply.set(channelId, Date.now());
    log.info("ChatAI", `Ответ в #${message.channel.name} (${text.length} символов)`);
  } catch (e) {
    log.error("ChatAI", `не удалось ответить: ${e.message}`, e);
    // Снимаем кулдаун на ошибке, чтобы следующее сообщение попробовало снова
    clearPending(channelId);
  }
}

function clearPending(channelId) {
  const t = pendingTimers.get(channelId);
  if (t) {
    clearTimeout(t);
    pendingTimers.delete(channelId);
  }
}

function schedule(channelId, message) {
  clearPending(channelId);
  const timer = setTimeout(() => {
    pendingTimers.delete(channelId);
    if (message.channel) void respond(message);
  }, COOLDOWN_MS);
  pendingTimers.set(channelId, timer);
}

async function handleMessage(message) {
  if (!cfg.enabled) return;
  if (!API_KEY) return;
  if (message.author?.bot) return;
  if (!message.guild) return;
  if (!inEnabledChannel(message.channel.id)) return;

  const content = (message.content || "").trim();
  if (!content) return;

  const last = lastReply.get(message.channel.id) || 0;
  const elapsed = Date.now() - last;

  if (elapsed >= COOLDOWN_MS) {
    void respond(message);
  } else {
    // Сообщение в кулдауне — отвечаем сразу после его окончания (на последнее пришёдшее)
    schedule(message.channel.id, message);
  }
}

const cog = {
  name: "ChatAI",

  async setup(registry) {
    if (!cfg.enabled) {
      log.info("ChatAI", "ИИ-ответы отключены в конфиге (ai.enabled=false)");
      return;
    }
    if (!CHANNELS.size) {
      log.warn("ChatAI", "ai.channels пуст — бот нигде не отвечает");
    }

    registry.event("messageCreate", handleMessage);

    registry.slash({
      name: "ai_status",
      description: "Статус ИИ-ответов в чате",
      guildOnly: true,
      options: [],
      async run(interaction) {
        const channels = CHANNELS.size
          ? [...CHANNELS].map((id) => `<#${id}>`).join(", ")
          : "не заданы";
        await interaction.reply({
          content: [
            `Модель: \`${MODEL}\``,
            `Кулдаун: ${COOLDOWN_MS / 1000}с`,
            `Ключ: ${API_KEY ? "есть" : "не задан (OPENROUTER_API_KEY)"}`,
            `Каналы: ${channels}`,
          ].join("\n"),
          ephemeral: true,
        });
      },
    });
  },
};

export default cog;