let startupDone = false;
let logChannelId = null;
let pingRoleNames = [];
let guildId = 0;

const DEDUP_SECONDS = 45;
const recentLogs = new Map();
const queue = [];
let draining = false;

const SENSITIVE_RE =
  /(token|oauth|secret|password|api_key|authorization)[:\s]*[=:]\s*["']?(\S{8,})/i;
const BEARER_RE = /(Bearer\s+)(\S{8,})/i;
const OAUTH_URL_RE = /(:\/\/[^:]+:)(\S{8,})(@)/;
const RAW_TOKEN_RE = /\b(oauth:\S{8,})\b/i;

function mask(val) {
  return val.length <= 8 ? "***" : `${val.slice(0, 4)}...${val.slice(-4)}`;
}

export function sanitize(text) {
  if (!text) return text;
  return String(text)
    .replace(SENSITIVE_RE, (m, k, v) => `${k}=${mask(v)}`)
    .replace(BEARER_RE, (m, p, v) => `${p}${mask(v)}`)
    .replace(OAUTH_URL_RE, (m, b, v, a) => `${b}${mask(v)}${a}`)
    .replace(RAW_TOKEN_RE, "oauth:***");
}

function isDuplicate(key) {
  const now = Date.now() / 1000;
  const last = recentLogs.get(key);
  if (last && last > now - DEDUP_SECONDS) return true;
  if (recentLogs.size > 200) {
    const cutoff = now - DEDUP_SECONDS;
    for (const [k, v] of recentLogs) if (v < cutoff) recentLogs.delete(k);
  }
  recentLogs.set(key, now);
  return false;
}

export function configure(options) {
  logChannelId = options.logChannelId || null;
  pingRoleNames = options.pingRoles || [];
  guildId = options.guildId || 0;
}

export function markReady() {
  startupDone = true;
}

/** Единая точка входа ошибок/логов из всех модулей.
 *  entry: { level: 'error'|'warn'|'info', logger, fn, line, message, error } */
export function enqueueLog(entry) {
  if (!startupDone) return;
  const levelNum = entry.level === "error" ? 40 : entry.level === "warn" ? 30 : 20;
  const key = `${entry.logger}|${entry.fn}|${entry.line}|${entry.message}`;
  if (isDuplicate(key)) return;
  queue.push({ ...entry, levelNum });
  if (!draining) void drain();
}

async function drain() {
  draining = true;
  while (queue.length) {
    const entry = queue.shift();
    try {
      if (logChannelId && entry.levelNum >= 30) {
        const { client } = await import("./client.js");
        await postToDiscord(client, entry);
      }
    } catch (e) {
      console.error("Не удалось отправить лог в Discord:", e);
    }
  }
  draining = false;
}

async function postToDiscord(bot, entry) {
  const channel = bot.channels.cache.get(String(logChannelId));
  if (!channel) return;
  let msg = sanitize(String(entry.message || ""));
  if (msg.length > 900) msg = msg.slice(0, 900) + "…";

  let trace = "";
  if (entry.error && entry.error.stack) {
    trace = sanitize(entry.error.stack).split("\n").slice(0, 12).join("\n") + " …";
    if (trace.length > 1000) trace = trace.slice(0, 1000) + " …";
  }
  const isError = entry.levelNum >= 40;
  const fields = [
    { name: "Модуль", value: `\`${entry.logger || "?"}\``, inline: true },
    { name: "Функция", value: `\`${entry.fn || "?"}():${entry.line || 0}\``, inline: true },
    { name: "Ошибка", value: `\`\`\`\n${msg}\n\`\`\`` },
  ];
  if (trace) fields.push({ name: "Traceback", value: `\`\`\`\n${trace}\n\`\`\`` });
  const embed = {
    title: isError ? "⚠️ Ошибка" : "ℹ️ Лог",
    color: isError ? 0xe74c3c : 0x5865f2,
    fields,
    timestamp: new Date().toISOString(),
  };
  let content;
  if (isError && guildId) {
    const guild = bot.guilds.cache.get(guildId);
    if (guild) {
      const mentions = pingRoleNames
        .map((n) => guild.roles.cache.find((r) => r.name === n))
        .filter(Boolean)
        .map((r) => r.toString());
      if (mentions.length) content = mentions.join(" ");
    }
  }
  await channel.send({ content, embeds: [embed] });
}

/** Логлайнер — используем как обычный console-лог, но с уровнем.
 *  Перехватывается в main.js для отправки в Discord. */
export const log = {
  error: (logger, message, error) =>
    safeLog({ level: "error", logger, fn: caller(), message, error }),
  warn: (logger, message, meta) =>
    safeLog({ level: "warn", logger, fn: caller(), message, ...meta }),
  info: (logger, message, meta) =>
    safeLog({ level: "info", logger, fn: caller(), message, ...meta }),
};

function safeLog(entry) {
  console[entry.level === "info" ? "log" : entry.level](
    `[${entry.level.toUpperCase()}] ${entry.logger}: ${entry.message}`
  );
  enqueueLog(entry);
}

function caller() {
  const stack = new Error().stack.split("\n").slice(3, 4)[0] || "";
  const m = stack.match(/at\s+(\w+)/);
  return m ? m[1] : "?";
}

export function handlerFor() {
  return { enqueueLog: (e) => enqueueLog(e), sanitize };
}