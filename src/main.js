import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient, TOKEN } from "./client.js";
import { Registry } from "./registry.js";
import { configure, markReady, enqueueLog, sanitize } from "./notify.js";
import { CONFIG, GUILD_ID, LOG_CHANNEL_ID, PING_ROLES, BOT_NAME, PROXY_URL, BASE_DIR } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COGS_DIR = path.join(__dirname, "cogs");

// ---------- Логирование ----------
const logFile = path.join(BASE_DIR, "bot.log");
const logStream = fs.createWriteStream(logFile, { flags: "a", encoding: "utf-8" });
function fileLog(level, msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  logStream.write(`[${ts}] [${level}] [BOT] ${msg}\n`);
}

// ---------- Single-instance mutex ----------
function acquireSingleInstance() {
  try {
    const lockPath = path.join(BASE_DIR, ".bot.lock");
    const fh = fs.openSync(lockPath, "w");
    try {
      fs.writeSync(fh, String(process.pid));
    } catch {}
    // Храним pid в файле; эксклюзивность: destructive create — уже открыт у нас.
    // Для надёжности проверяем предыдущий pid:
    const other = fs.readFileSync(lockPath, "utf-8").trim();
    if (other && other !== String(process.pid)) {
      try {
        process.kill(Number(other), 0);
        fs.closeSync(fh);
        return false; // другой процесс жив
      } catch {
        fs.closeSync(fh);
        fs.writeFileSync(lockPath, String(process.pid));
      }
    }
    process.on("exit", () => {
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    });
    return true;
  } catch (e) {
    console.error("Ошибка блокировки single-instance:", e);
    return false;
  }
}

// ---------- Приложение ----------
async function main() {
  configure({
    logChannelId: LOG_CHANNEL_ID,
    pingRoles: PING_ROLES,
    guildId: GUILD_ID,
  });

  const client = createClient();
  const registry = new Registry(client);

  // Загрузка когов
  const files = fs
    .readdirSync(COGS_DIR)
    .filter((f) => f.endsWith(".js") && !f.startsWith("_"));
  files.sort();
  const loaded = [];
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(path.join(COGS_DIR, f)).href);
      const cog = mod.default;
      if (!cog || typeof cog.setup !== "function") {
        fileLog("WARN", `Ког ${f}: нет default-экспорта с setup() — пропущен`);
        continue;
      }
      await cog.setup(registry);
      loaded.push(cog.name || f);
      fileLog("INFO", `Ког загружен: ${cog.name || f}`);
    } catch (e) {
      const msg = `Ошибка загрузки кога ${f}: ${e.stack || e}`;
      fileLog("ERROR", msg);
      if (process.env.BOT_DRYRUN === "1") console.error(msg);
      enqueueLog({ level: "error", logger: "main", fn: "loadCogs", message: `Ошибка загрузки кога ${f}: ${e.message}`, error: e });
    }
  }

  // ---------- Глобальные обработчики ----------
  client.once("ready", async () => {
    fileLog("INFO", `Бот запущен: ${client.user?.tag} (ID: ${client.user?.id})`);
    for (const g of client.guilds.cache.values()) {
      fileLog("INFO", `СЕРВЕР: ${g.name} | ID: ${g.id}`);
    }

    // Регистрация slash-команд
    try {
      const payload = registry.getSlashPayload();
      const app = client.application;
      await app.commands.set(payload);
      if (GUILD_ID) {
        const g = client.guilds.cache.get(GUILD_ID);
        if (g) await g.commands.set(payload);
      }
      fileLog("INFO", `Синхронизировано команд: ${payload.length}`);
    } catch (e) {
      fileLog("ERROR", `Ошибка синхронизации команд: ${e.stack || e}`);
    }

    markReady();
    fileLog("INFO", "Бот готов к работе.");

    // Веб-панель
    try {
      const { start: startPanel } = await import("./webpanel.js");
      await startPanel(client);
      fileLog("INFO", "Веб-панель запущена.");
    } catch (e) {
      fileLog("ERROR", `Ошибка запуска веб-панели: ${e.stack || e}`);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand() || interaction.isCommand()) {
        const spec = registry.findSlash(interaction.commandName);
        if (spec) {
          await spec.run(interaction, registry, client);
          return;
        }
        await interaction.reply({ content: "Неизвестная команда", ephemeral: true });
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
      const prefix = message.content.startsWith("!") ? "!" : null;
      if (!prefix) return;
      const body = message.content.slice(prefix.length).trim();
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
    client.on(eventName, (...args) => registry.emit(eventName, ...args));
  }

  // Привязка глобального обработчика ошибок
  client.on("error", (e) => {
    fileLog("ERROR", `Клиент: ${e.stack || e.message}`);
  });

  client.on("warn", (info) => {
    fileLog("WARN", `Клиент: ${info}`);
  });

  process.on("unhandledRejection", (reason) => {
    const e = reason instanceof Error ? reason : new Error(String(reason));
    fileLog("ERROR", `unhandledRejection: ${e.stack}`);
    enqueueLog({ level: "error", logger: "process", fn: "unhandledRejection", message: e.message, error: e });
  });

  process.on("uncaughtException", (e) => {
    fileLog("ERROR", `uncaughtException: ${e.stack}`);
    enqueueLog({ level: "error", logger: "process", fn: "uncaughtException", message: e.message, error: e });
    setTimeout(() => process.exit(1), 500);
  });

  const proxyOpts = {};
  if (PROXY_URL) proxyOpts.proxy = PROXY_URL;

  // Режим проверки загрузки без соединения с Discord
  if (process.env.BOT_DRYRUN === "1") {
    console.log("DRYRUN: коги загружены:", loaded.length);
    for (const name of loaded) console.log("  -", name);
    process.exit(0);
  }

  try {
    await client.login(TOKEN);
  } catch (e) {
    fileLog("ERROR", `Ошибка логина: ${e.stack || e.message}`);
    console.error("Ошибка логина:", e.message);
    process.exit(1);
  }
}

if (!acquireSingleInstance()) {
  console.error("Уже запущен другой экземпляр бота — выход.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Фатальная ошибка:", e);
  fileLog("ERROR", `Фатальная ошибка: ${e.stack || e}`);
  process.exit(1);
});