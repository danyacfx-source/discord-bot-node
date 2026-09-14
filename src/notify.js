let startupDone = false;
let logChannelId = null;
let pingRoleNames = [];
let guildId = 0;

const DEDUP_SECONDS = 45;
const recentLogs = new Map();
const queue = [];
const startupBuffer = [];
let draining = false;

const SENSITIVE_RE =
  /(token|oauth|secret|password|api_key|authorization|client_secret|refresh_token|access_token|discord_token|bot_token)[^\S\r\n]*[=:][^\S\r\n]*["']?(\S{8,})/i;
const BEARER_RE = /(Bearer\s+)(\S{8,})/i;
const OAUTH_URL_RE = /(:\/\/[^:]+:)(\S{8,})(@)/;
const RAW_TOKEN_RE = /\b(oauth:\S{8,})\b/i;
const DISCORD_TOKEN_RE = /\b[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}\b/;
const GENERIC_SECRET_RE = /\b(DISCORD_TOKEN|TWITCH_OAUTH|YOUTUBE_CLIENT_SECRET|OVERLAY_TOKEN)\b\s*[=:]\s*["']?(\S{8,})/i;

function mask(_val) {
  return "***";
}

export function sanitize(text) {
  if (!text) return text;
  return String(text)
    .replace(GENERIC_SECRET_RE, (m, k, v) => `${k}=${mask(v)}`)
    .replace(SENSITIVE_RE, (m, k, v) => `${k}=${mask(v)}`)
    .replace(BEARER_RE, (m, p, v) => `${p}${mask(v)}`)
    .replace(OAUTH_URL_RE, (m, b, v, a) => `${b}${mask(v)}${a}`)
    .replace(RAW_TOKEN_RE, "oauth:***")
    .replace(DISCORD_TOKEN_RE, "***");
}

function isDuplicate(key) {
  const now = Date.now() / 1000;
  const last = recentLogs.get(key);
  if (last && last > now - DEDUP_SECONDS) return true;
  // TTL cleanup every call + hard cap to prevent leak
  const cutoff = now - DEDUP_SECONDS;
  for (const [k, v] of recentLogs) if (v < cutoff) recentLogs.delete(k);
  if (recentLogs.size > 500) {
    // evict oldest 100
    const iter = recentLogs.keys();
    for (let i = 0; i < 100; i++) {
      const k = iter.next().value;
      if (k === undefined) break;
      recentLogs.delete(k);
    }
  }
  recentLogs.set(key, now);
  return false;
}

export function configure(options) {
  logChannelId = options.logChannelId || null;
  pingRoleNames = options.pingRoles || [];
  guildId = options.guildId || 0;
  if (options.client) _cachedClient = options.client;
}

export function setClient(c) {
  _cachedClient = c;
}

export function markReady() {
  startupDone = true;
  // flush buffered logs that arrived before ready
  if (startupBuffer.length) {
    for (const e of startupBuffer.splice(0)) queue.push(e);
    if (!draining) void drain();
  }
}

/** Единая точка входа ошибок/логов из всех модулей.
 *  entry: { level: 'error'|'warn'|'info', logger, fn, line, message, error } */
export function enqueueLog(entry) {
  const levelNum = entry.level === "error" ? 40 : entry.level === "warn" ? 30 : 20;
  const key = `${entry.logger}|${entry.fn}|${entry.line}|${entry.message}`;
  if (isDuplicate(key)) return;
  const item = { ...entry, levelNum };
  if (!startupDone) {
    // buffer instead of dropping; cap to prevent leak
    if (startupBuffer.length < 200) startupBuffer.push(item);
    else startupBuffer.shift(), startupBuffer.push(item);
    return;
  }
  queue.push(item);
  if (!draining) void drain();
}

let _cachedClient = null;
async function getClient() {
  if (_cachedClient) return _cachedClient;
  try {
    const mod = await import("./client.js");
    if (mod.client) {
      _cachedClient = mod.client;
      return _cachedClient;
    }
  } catch {}
  // fallback: try to get from global if client.js not ready (avoid cycle)
  return _cachedClient;
}
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const entry = queue.shift();
      try {
        if (logChannelId && entry.levelNum >= 30) {
          const c = await getClient();
          if (!c) {
            // client not ready yet, requeue and wait
            queue.unshift(entry);
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          await postToDiscord(c, entry);
          // Throttle: 400ms between logs instead of 600 to make flushLogs(2000) feasible
          if (queue.length) await new Promise((r) => setTimeout(r, 400));
        }
      } catch (e) {
        // Rate limit handling: если Discord вернул retry_after — ждём
        const retryAfter = e?.retry_after || e?.retryAfter || e?.data?.retry_after;
        if (retryAfter) {
          const delay = Math.min(Number(retryAfter) * 1000 || 2000, 5000);
          await new Promise((r) => setTimeout(r, delay));
          // requeue failed entry for retry once
          if (queue.length < 500) queue.push(entry);
        } else if (e?.code === 50013 || e?.httpStatus === 429) {
          await new Promise((r) => setTimeout(r, 1500));
          if (queue.length < 500) queue.push(entry);
        }
        console.error("Не удалось отправить лог в Discord:", e);
      }
    }
  } finally {
    draining = false;
  }
}

// Ожидает опустошения очереди с учётом throttle-задержки (до 2000ms по умолчанию)
export async function flushLogs(timeoutMs = 2000) {
  const start = Date.now();
  // drained startup buffer first
  if (!startupDone && startupBuffer.length) {
    // flush startup buffer without Discord? just drain to queue for later
  }
  if ((queue.length || startupBuffer.length) && !draining) void drain();
  while ((queue.length > 0 || draining || startupBuffer.length > 0) && Date.now() - start < timeoutMs) {
    if (!draining && (queue.length || startupBuffer.length)) void drain();
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function drainAndFlush(timeoutMs = 2000) {
  return flushLogs(timeoutMs);
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
  const stack = new Error().stack.split("\n");
  // find first frame outside notify.js
  for (let i = 2; i < stack.length; i++) {
    const line = stack[i] || "";
    if (line.includes("notify.js")) continue;
    const m = line.match(/at\s+([^\s(]+)/);
    if (m) return m[1].split(".").pop() || m[1];
    const m2 = line.match(/at\s+.*\((.*):\d+:\d+\)/);
    if (m2) return m2[1].split("/").pop() || "?";
  }
  return "?";
}

export function handlerFor() {
  return { enqueueLog: (e) => enqueueLog(e), sanitize };
}