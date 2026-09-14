import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Events, PermissionFlagsBits } from "discord.js";
import { createClient, TOKEN } from "./client.js";
import { Registry } from "./registry.js";
import { configure, markReady, enqueueLog, sanitize, flushLogs, setClient } from "./notify.js";
import { CONFIG, GUILD_ID, LOG_CHANNEL_ID, PING_ROLES, BOT_NAME, PROXY_URL, BASE_DIR } from "./config.js";

const BOT_PREFIX = (CONFIG.youtube?.commands?.prefix || process.env.BOT_PREFIX || "!").trim() || "!";

function normalizePermission(p) {
  if (p == null) return null;
  if (typeof p === "bigint") return p;
  if (typeof p === "number" && Number.isFinite(p)) return BigInt(p);
  if (typeof p === "string") {
    const trimmed = p.trim();
    // numeric string bitfield
    if (/^\d+$/.test(trimmed)) {
      try { return BigInt(trimmed); } catch {}
    }
    // PermissionFlagsBits key e.g. "Administrator" or "MANAGE_MESSAGES"
    if (PermissionFlagsBits[trimmed] !== undefined) return PermissionFlagsBits[trimmed];
    // try uppercase snake variant
    const upper = trimmed.toUpperCase().replace(/[^A-Z_]/g, "_");
    // convert camelCase to SCREAMING_SNAKE
    const snake = trimmed.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
    if (PermissionFlagsBits[snake] !== undefined) return PermissionFlagsBits[snake];
    if (PermissionFlagsBits[upper] !== undefined) return PermissionFlagsBits[upper];
  }
  return null;
}
function normalizePermissions(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const p of arr) {
    const bit = normalizePermission(p);
    if (bit !== null) out.push(bit);
  }
  return out;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COGS_DIR = path.join(__dirname, "cogs");

// ---------- Логирование ----------
const logFile = path.join(BASE_DIR, "bot.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB — ротация
try {
  if (fs.existsSync(logFile)) {
    const st = fs.statSync(logFile);
    if (st.size > MAX_LOG_SIZE) {
      const rotated = logFile + ".1";
      try {
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(logFile, rotated);
      } catch {}
      // Если rename не сработал и файл всё ещё большой — усечь
      try {
        if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_SIZE) fs.truncateSync(logFile, 0);
      } catch {}
    }
  }
} catch {}
const logStream = fs.createWriteStream(logFile, { flags: "a", encoding: "utf-8" });
function fileLog(level, msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  try {
    if (!logStream.writableEnded) logStream.write(`[${ts}] [${level}] [BOT] ${msg}\n`);
  } catch {}
}
function closeLogStream() {
  try {
    if (!logStream.writableEnded) logStream.end();
  } catch {}
}

// ---------- Single-instance mutex ----------
let lockFd = null;
let lockPath = path.join(BASE_DIR, ".bot.lock");
let lockCleanupRegistered = false;
function cleanupLock() {
  try {
    if (lockFd !== null) {
      fs.closeSync(lockFd);
      lockFd = null;
    }
  } catch {}
  try {
    fs.unlinkSync(lockPath);
  } catch {}
}
function registerLockCleanup() {
  if (lockCleanupRegistered) return;
  lockCleanupRegistered = true;
  process.on("exit", () => {
    try {
      cleanupLock();
    } catch {}
    closeLogStream();
  });
  const sigHandler = (sig) => {
    try {
      cleanupLock();
    } catch {}
    closeLogStream();
    // Даём время flush'у логов перед выходом
    setTimeout(() => process.exit(0), 100);
  };
  process.on("SIGINT", () => sigHandler("SIGINT"));
  process.on("SIGTERM", () => sigHandler("SIGTERM"));
}
function acquireSingleInstance() {
  lockPath = path.join(BASE_DIR, ".bot.lock");
  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // "wx" — эксклюзивное создание, падает с EEXIST если файл уже есть (атомарно)
      lockFd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(lockFd, String(process.pid));
      } catch {}
      registerLockCleanup();
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") {
        console.error("Ошибка блокировки single-instance:", e);
        return false;
      }
      // Файл уже существует — проверяем stale lock
      let otherStr = "";
      try {
        otherStr = fs.readFileSync(lockPath, "utf-8").trim();
      } catch {
        // Не прочитали — пробуем удалить и ретрай
        try {
          fs.unlinkSync(lockPath);
        } catch {}
        continue;
      }
      const otherPid = Number(otherStr);
      if (!otherStr || !Number.isFinite(otherPid) || otherPid <= 0) {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
        continue;
      }
      // Docker PID=1 коллизия: если в файле тот же PID что и у нас, но wx упал —
      // значит файл не от текущего процесса, а от предыдущего инкарнации контейнера (volume).
      // Считаем stale и удаляем.
      if (otherPid === process.pid) {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
        continue;
      }
      try {
        process.kill(otherPid, 0);
        // Процесс жив (EPERM тоже считается живым) — не можем захватить
        return false;
      } catch (killErr) {
        if (killErr.code === "ESRCH") {
          // PID мёртв — TOCTOU: удаляем и ретрай один раз
          try {
            fs.unlinkSync(lockPath);
          } catch {}
          continue;
        }
        // EPERM или иное — процесс существует, но нет прав на сигнал
        return false;
      }
    }
  }
  console.error("Не удалось захватить lock после проверки stale PID");
  return false;
}

// ---------- Приложение ----------
async function main() {
  configure({
    logChannelId: LOG_CHANNEL_ID,
    pingRoles: PING_ROLES,
    guildId: GUILD_ID,
  });

  const client = createClient();
  setClient(client);
  const registry = new Registry(client);

  // Загрузка когов — с явным порядком и устойчивостью к ошибкам
  // Сортировка обеспечивает детерминизм; при наличии cog.dependencies — topological sort
  let files = fs
    .readdirSync(COGS_DIR)
    .filter((f) => f.endsWith(".js") && !f.startsWith("_"));
  files.sort();
  // Предзагрузка dependencies без двойного импорта: парсим файл через fs (singleton сохраняется)
  const fileModulesPre = new Map();
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(COGS_DIR, f), "utf-8");
      // Ищем dependencies: [ "cog1", "cog2" ] или dependencies: [...]
      const m = raw.match(/dependencies\s*:\s*\[([^\]]*)\]/);
      if (m) {
        const deps = [];
        const inner = m[1];
        const depRe = /["']([^"']+)["']/g;
        let dm;
        while ((dm = depRe.exec(inner))) deps.push(dm[1]);
        if (deps.length) fileModulesPre.set(f, deps);
      }
    } catch {}
  }
  if (fileModulesPre.size) {
    const sorted = [];
    const visited = new Set();
    const visiting = new Set();
    const nameToFile = new Map();
    function normKey(s) {
      return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
    }
    for (const f of files) {
      const base = f.replace(/\.js$/, "");
      nameToFile.set(f, f);
      nameToFile.set(base, f);
      nameToFile.set(normKey(base), f);
      nameToFile.set(base.toLowerCase(), f);
    }
    function visit(f) {
      if (visited.has(f)) return;
      if (visiting.has(f)) {
        fileLog("WARN", `Циклическая зависимость когов вокруг ${f} — порядок сохранён как есть`);
        return;
      }
      visiting.add(f);
      const deps = fileModulesPre.get(f) || [];
      for (const dep of deps) {
        const candidates = [
          dep,
          dep + ".js",
          normKey(dep),
          String(dep).toLowerCase(),
          String(dep).toLowerCase().replace(/[^a-z0-9]/g, ""),
        ];
        let depFile = null;
        for (const c of candidates) {
          depFile = nameToFile.get(c);
          if (depFile) break;
        }
        // fallback: try normalized comparison across all files
        if (!depFile) {
          const nd = normKey(dep);
          for (const file of files) {
            if (normKey(file.replace(/\.js$/, "")) === nd) { depFile = file; break; }
          }
        }
        if (depFile && files.includes(depFile)) visit(depFile);
      }
      visiting.delete(f);
      visited.add(f);
      sorted.push(f);
    }
    for (const f of files) visit(f);
    for (const f of files) if (!sorted.includes(f)) sorted.push(f);
    files = sorted;
  }
  const loaded = [];
  const failed = [];
  for (const f of files) {
    const started = Date.now();
    try {
      // Bust cache для пре-лоада выше не нужен, но если уже загружен — переиспользуем импорт
      const mod = await import(pathToFileURL(path.join(COGS_DIR, f)).href);
      const cog = mod.default;
      if (!cog || typeof cog.setup !== "function") {
        fileLog("WARN", `Ког ${f}: нет default-экспорта с setup() — пропущен`);
        failed.push(f);
        continue;
      }
      await cog.setup(registry);
      loaded.push(cog.name || f);
      fileLog("INFO", `Ког загружен: ${cog.name || f} (${Date.now() - started}ms)`);
    } catch (e) {
      const msg = `Ошибка загрузки кога ${f}: ${e.stack || e}`;
      fileLog("ERROR", msg);
      console.error(msg);
      enqueueLog({ level: "error", logger: "main", fn: "loadCogs", message: `Ошибка загрузки кога ${f}: ${e.message}`, error: e });
      failed.push(f);
      // Продолжаем загрузку остальных когов — изолированная ошибка не валит весь бот
    }
  }
  if (failed.length) {
    fileLog("WARN", `Когов с ошибками: ${failed.join(", ")} — продолжаем работу с ${loaded.length} успешными`);
  }
  fileLog("INFO", `Загрузка когов завершена: успешно ${loaded.length}/${files.length}`);

  // ---------- Веб-панель — стартует независимо от Discord ----------
  // Запускаем сразу, не дожидаясь clientReady, но await чтобы поймать EADDRINUSE
  try {
    const { start: startPanel } = await import("./webpanel.js");
    await startPanel(client);
    fileLog("INFO", "Веб-панель запущена (независимо от Discord).");
  } catch (e) {
    fileLog("ERROR", `Ошибка запуска веб-панели: ${e.stack || e}`);
    if (e && e.code === "EADDRINUSE") {
      fileLog("ERROR", "Веб-панель не смогла занять порт — проверьте PANEL_PORT/PANEL_HOST");
    }
  }

  // ---------- Глобальные обработчики ----------
  const readyEventName = Events.ClientReady || "clientReady";
  const onReady = async () => {
    fileLog("INFO", `Бот запущен: ${client.user?.tag} (ID: ${client.user?.id})`);
    for (const g of client.guilds.cache.values()) {
      fileLog("INFO", `СЕРВЕР: ${g.name} | ID: ${g.id}`);
    }

    // Регистрация slash-команд — только глобально, без слепой зачистки гильд-команд
    try {
      const payload = registry.getSlashPayload();
      const app = client.application;
      if (!app) {
        fileLog("WARN", "client.application не готов — пропускаем синхронизацию команд");
      } else {
        // Деструктивная зачистка гильд-команд только по явному флагу окружения
        if (process.env.WIPE_GUILD_COMMANDS === "1" && GUILD_ID) {
          const g = client.guilds.cache.get(String(GUILD_ID));
          if (g) {
            try {
              const guildCmds = await g.commands.fetch();
              if (guildCmds.size) {
                await g.commands.set([]);
                fileLog("INFO", `WIPE_GUILD_COMMANDS=1 — очищено ${guildCmds.size} guild-команд в ${g.name}`);
              }
            } catch (e) {
              // Missing Access / прав нет — логируем, но не падаем
              if (e.code === 50001 || e.httpStatus === 403 || String(e.message).includes("Missing Access")) {
                fileLog("WARN", `Нет прав на очистку guild-команд в ${g.name}: ${e.message}`);
              } else {
                fileLog("ERROR", `Ошибка очистки guild-команд: ${e.stack || e}`);
              }
            }
          }
        } else if (GUILD_ID) {
          fileLog("INFO", "Пропуск очистки guild-команд (установите WIPE_GUILD_COMMANDS=1 для зачистки)");
        }
        try {
          await app.commands.set(payload);
          fileLog("INFO", `Синхронизировано глобальных команд: ${payload.length}`);
        } catch (e) {
          if (e.code === 50001 || e.httpStatus === 403) {
            fileLog("ERROR", `Missing Access при синхронизации глобальных команд: ${e.message}`);
          } else {
            fileLog("ERROR", `Ошибка синхронизации команд: ${e.stack || e}`);
          }
        }
      }
    } catch (e) {
      fileLog("ERROR", `Ошибка синхронизации команд: ${e.stack || e}`);
    }

    markReady();
    fileLog("INFO", "Бот готов к работе.");
  };
  // Корректное имя события в discord.js v14 — Events.ClientReady === "clientReady"
  // Слушаем только один раз чтобы избежать двойного markReady / синхронизации команд
  client.once(readyEventName, onReady);

  client.on("interactionCreate", async (interaction) => {
    try {
      // Удалено deprecated isCommand() — используем isChatInputCommand()
      if (interaction.isChatInputCommand()) {
        const spec = registry.findSlash(interaction.commandName);
        if (!spec) {
          await interaction.reply({ content: "Неизвестная команда", ephemeral: true });
          return;
        }
        // guildOnly проверка
        if (spec.guildOnly && !interaction.inGuild()) {
          await interaction.reply({ content: "Эта команда только на сервере.", ephemeral: true });
          return;
        }
        // Делегированная проверка прав кога
        if (typeof spec.checkPermissions === "function") {
          try {
            const allowed = await spec.checkPermissions(interaction, registry, client);
            if (allowed === false) {
              await interaction.reply({ content: "Недостаточно прав.", ephemeral: true });
              return;
            }
          } catch (permErr) {
            fileLog("WARN", `checkPermissions для /${spec.name} бросил: ${permErr.message}`);
            await interaction.reply({ content: "Ошибка проверки прав.", ephemeral: true });
            return;
          }
        } else if (typeof spec.permissionCheck === "function") {
          try {
            const allowed = await spec.permissionCheck(interaction, registry, client);
            if (allowed === false) {
              await interaction.reply({ content: "Недостаточно прав.", ephemeral: true });
              return;
            }
          } catch (permErr) {
            fileLog("WARN", `permissionCheck для /${spec.name} бросил: ${permErr.message}`);
            await interaction.reply({ content: "Ошибка проверки прав.", ephemeral: true });
            return;
          }
        } else if (Array.isArray(spec.permissions) && spec.permissions.length) {
          try {
            const member = interaction.member;
            if (member && typeof member.permissions?.has === "function") {
              const normalized = normalizePermissions(spec.permissions);
              if (normalized.length) {
                const missing = normalized.filter((p) => !member.permissions.has(p));
                if (missing.length) {
                  await interaction.reply({ content: "Недостаточно прав для этой команды.", ephemeral: true });
                  return;
                }
              } else {
                fileLog("WARN", `spec.permissions для /${spec.name} содержит неизвестные биты: ${JSON.stringify(spec.permissions)}`);
              }
            }
          } catch {}
        } else if (Array.isArray(spec.allowedRoles) && spec.allowedRoles.length) {
          const memberRoles = interaction.member?.roles?.cache;
          if (memberRoles && !spec.allowedRoles.some((r) => memberRoles.has(String(r)) || [...memberRoles.values()].some((x) => x.name === r))) {
            await interaction.reply({ content: "Недостаточно прав (роль).", ephemeral: true });
            return;
          }
        }
        await spec.run(interaction, registry, client);
        return;
      }

      const c = registry.matchComponent(interaction);
      if (c) {
        await c.fn(interaction, registry, client);
        return;
      }

      if (interaction.isModalSubmit()) {
        // модалки c динамическими id обрабатываются через matchComponent выше
      }
    } catch (e) {
      fileLog("ERROR", `Ошибка обработки interaction: ${e.stack || e}`);
      enqueueLog({ level: "error", logger: "main", fn: "interactionCreate", message: `interaction: ${e.message}`, error: e });
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: "Произошла ошибка.", ephemeral: true });
        } else {
          await interaction.reply({ content: "Произошла ошибка.", ephemeral: true });
        }
      } catch {}
    }
  });

  client.on("messageCreate", async (message) => {
    if (!registry.prefixMap.size) return;
    try {
      if (message.author.bot || !message.guild) return;
      if (!message.content.startsWith(BOT_PREFIX)) return;
      const body = message.content.slice(BOT_PREFIX.length).trim();
      if (!body) return;
      const [cmd, ...args] = body.split(/\s+/);
      const spec = registry.prefixMap.get(cmd.toLowerCase());
      if (!spec) return;
      await spec.run(message, args, registry, client);
    } catch (e) {
      fileLog("ERROR", `Ошибка префиксной команды: ${e.stack || e}`);
    }
  });

  // ---------- События из когов ----------
  for (const [eventName] of registry.eventsMap) {
    let discordEvent = eventName;
    if (eventName === "ClientReady" || eventName === "ready") discordEvent = Events.ClientReady || "clientReady";
    client.on(discordEvent, (...args) => registry.emit(eventName, ...args));
  }

  // Привязка глобального обработчика ошибок
  client.on("error", (e) => {
    fileLog("ERROR", `Клиент: ${e.stack || e.message}`);
    enqueueLog({ level: "error", logger: "client", fn: "error", message: e.message, error: e });
  });

  client.on("warn", (info) => {
    fileLog("WARN", `Клиент: ${info}`);
  });

  process.on("unhandledRejection", async (reason) => {
    const e = reason instanceof Error ? reason : new Error(String(reason));
    fileLog("ERROR", `unhandledRejection: ${e.stack}`);
    enqueueLog({ level: "error", logger: "process", fn: "unhandledRejection", message: e.message, error: e });
    // Даем шанс drain завершиться, учитывая sendThrottled задержку
    try {
      await flushLogs(2000);
    } catch {}
  });

  process.on("uncaughtException", async (e) => {
    fileLog("ERROR", `uncaughtException: ${e.stack}`);
    enqueueLog({ level: "error", logger: "process", fn: "uncaughtException", message: e.message, error: e });
    try {
      await flushLogs(2000);
    } catch {}
    // Увеличенный таймаут чтобы drain + sendThrottled успели
    setTimeout(() => {
      closeLogStream();
      cleanupLock();
      process.exit(1);
    }, 2000);
  });

  const proxyOpts = {};
  if (PROXY_URL) proxyOpts.proxy = PROXY_URL;

  // Режим проверки загрузки без соединения с Discord
  if (process.env.BOT_DRYRUN === "1") {
    console.log("DRYRUN: коги загружены:", loaded.length);
    for (const name of loaded) console.log("  -", name);
    closeLogStream();
    cleanupLock();
    process.exit(0);
  }

  try {
    await client.login(TOKEN);
  } catch (e) {
    fileLog("ERROR", `Ошибка логина: ${e.stack || e.message}`);
    console.error("Ошибка логина:", e.message);
    try {
      await flushLogs(2000);
    } catch {}
    closeLogStream();
    cleanupLock();
    process.exit(1);
  }
}

if (!acquireSingleInstance()) {
  console.error("Уже запущен другой экземпляр бота — выход.");
  try {
    closeLogStream();
  } catch {}
  process.exit(0);
}

main().catch(async (e) => {
  console.error("Фатальная ошибка:", e);
  try {
    fileLog("ERROR", `Фатальная ошибка: ${e.stack || e}`);
  } catch {}
  try {
    // flushLogs доступен через динамический импорт если статичный импорт уже не сработал
    const { flushLogs: fl } = await import("./notify.js");
    await fl(2000);
  } catch {}
  try {
    closeLogStream();
  } catch {}
  try {
    cleanupLock();
  } catch {}
  process.exit(1);
});