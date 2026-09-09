import fs from "node:fs";
import path from "node:path";
import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from "discord.js";
import { CONFIG, DATA_DIR } from "../config.js";
import { log } from "../notify.js";

const SCHEDULE_FILE = path.join(DATA_DIR, "schedule.json");
const cfg = CONFIG.schedule || {};
let bot = null;
let started = false;
let intervalId = null;

const MSK_OFFSET = 3 * 3600 * 1000;
const DAY_JS_TO_PY = [6, 0, 1, 2, 3, 4, 5];
const WEEKDAY_RU = { 0: "пн", 1: "вт", 2: "ср", 3: "чт", 4: "пт", 5: "сб", 6: "вс" };
const DAY_NAMES_RU = {
  0: "Понедельник",
  1: "Вторник",
  2: "Среда",
  3: "Четверг",
  4: "Пятница",
  5: "Суббота",
  6: "Воскресенье",
};

const data = load();

function load() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf-8"));
    }
  } catch (e) {
    log.warn("Schedule", `Ошибка чтения ${SCHEDULE_FILE}: ${e.message}`);
  }
  return { entries: [], reminder_minutes: 30, notified: {} };
}

function save() {
  try {
    fs.mkdirSync(path.dirname(SCHEDULE_FILE), { recursive: true });
    const tmp = SCHEDULE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, SCHEDULE_FILE);
  } catch (e) {
    log.warn("Schedule", `Ошибка записи ${SCHEDULE_FILE}: ${e.message}`);
  }
}

function nowMsk() {
  return new Date(Date.now() + MSK_OFFSET);
}

function pyWeekday(msk) {
  return DAY_JS_TO_PY[msk.getUTCDay()];
}

function nextOccurrence(entry, now) {
  const hour = entry.hour;
  const minute = entry.minute;
  for (let i = 0; i < 8; i++) {
    const target = new Date(now);
    target.setUTCDate(now.getUTCDate() + i);
    target.setUTCHours(hour, minute, 0, 0);
    if (entry.days.includes(pyWeekday(target)) && target > now) {
      return target;
    }
  }
  return null;
}

function parseDays(text) {
  const normalized = String(text || "").toLowerCase().replace(/ /g, "");
  const parts = normalized.replace(/,/g, "-").split("-");
  const days = new Set();
  for (let p of parts) {
    p = p.trim();
    if (p in WEEKDAY_RU) {
      days.add(WEEKDAY_RU[p]);
      continue;
    }
    for (const [short, num] of Object.entries(WEEKDAY_RU)) {
      if (short.startsWith(p.slice(0, 2))) {
        days.add(num);
        break;
      }
    }
  }
  return [...days].sort((a, b) => a - b);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtDuration(minutes) {
  if (minutes < 60) return `через ${minutes} мин`;
  if (minutes < 1440) return `через ${Math.floor(minutes / 60)}ч ${minutes % 60}м`;
  return "";
}

async function sendReminder(channel, entry, startMsk, now) {
  const title = entry.title || "Стрим";
  const duration = entry.duration_minutes || 120;
  const timeStr = `${pad2(startMsk.getUTCHours())}:${pad2(startMsk.getUTCMinutes())}`;
  const days = entry.days.map((d) => DAY_NAMES_RU[d] || d).join(", ");
  const deltaMin = Math.round((startMsk - now) / 60000);

  const embed = new EmbedBuilder()
    .setTitle("🎬 Скоро стрим!")
    .setDescription(`**${title}** начинается в **${timeStr} МСК**`)
    .setColor(0x53fc18)
    .addFields(
      { name: "День", value: days, inline: true },
      { name: "Время", value: `${timeStr} МСК`, inline: true },
      { name: "Длительность", value: `~${duration} мин`, inline: true }
    )
    .setFooter({ text: `Начало через ${deltaMin} мин · kick.com/dendosich` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Открыть Kick")
      .setStyle(ButtonStyle.Link)
      .setURL("https://kick.com/dendosich")
  );

  try {
    await channel.send({ embeds: [embed], components: [row] });
    log.info("Schedule", `Напоминание '${title}' в ${timeStr}`);
  } catch (e) {
    log.warn("Schedule", `Ошибка отправки напоминания: ${e.message}`);
  }
}

async function checkOnce() {
  const now = nowMsk();
  const todayKey = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
  const channelId = cfg.channel_id;
  if (!channelId) return;
  const channel = bot.channels.cache.get(channelId);
  if (!channel) return;

  const reminderMin = data.reminder_minutes ?? 30;
  const notifiedToday = data.notified?.[todayKey] ?? [];
  const newNotified = [...notifiedToday];
  let changed = false;

  for (const entry of data.entries ?? []) {
    const entryId = entry.id ?? 0;
    if (notifiedToday.includes(entryId)) continue;
    const nxt = nextOccurrence(entry, now);
    if (!nxt) continue;
    const delta = (nxt - now) / 60000;
    if (delta > 0 && delta <= reminderMin) {
      await sendReminder(channel, entry, nxt, now);
      newNotified.push(entryId);
      changed = true;
    }
  }

  if (changed) {
    if (!data.notified) data.notified = {};
    data.notified[todayKey] = newNotified;
    save();
  }
}

async function cmdView(interaction) {
  const entries = data.entries || [];
  if (!entries.length) {
    await interaction.reply({
      content: "Расписание пустое. Добавь стрим: `/schedule add`",
      ephemeral: true,
    });
    return;
  }
  const now = nowMsk();
  const lines = entries
    .slice()
    .sort((a, b) => (a.hour || 0) - (b.hour || 0) || (a.minute || 0) - (b.minute || 0))
    .map((e) => {
      const daysStr = (e.days || []).map((d) => WEEKDAY_RU[d] || d).join(" ");
      const timeStr = `${pad2(e.hour)}:${pad2(e.minute)}`;
      let nextStr = "";
      const nxt = nextOccurrence(e, now);
      if (nxt) {
        const delta = Math.round((nxt - now) / 60000);
        if (delta < 60) nextStr = ` — через ${delta} мин`;
        else if (delta < 1440) nextStr = ` — ${fmtDuration(delta)}`;
        else nextStr = ` — ${pad2(nxt.getUTCDate())}.${pad2(nxt.getUTCMonth() + 1)}`;
      }
      const title = e.title || "Стрим";
      return `**#${e.id}** \`${daysStr}\` ${timeStr} МСК — ${title}${nextStr}`;
    });

  const embed = new EmbedBuilder()
    .setTitle("📅 Расписание стримов")
    .setDescription(lines.join("\n"))
    .setColor(0x53fc18)
    .setFooter({ text: `Напоминание за ${data.reminder_minutes ?? 30} мин до старта` });
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function cmdAdd(interaction) {
  const daysRaw = interaction.options.getString("days");
  const timeRaw = interaction.options.getString("time");
  if (!daysRaw || !timeRaw) {
    await interaction.reply({
      content: "Укажи **days** (пн,ср,пт) и **time** (20:00). Пример: `/schedule add days=пн,ср,пт time=20:00 title=Tarkov`",
      ephemeral: true,
    });
    return;
  }

  const parsedDays = parseDays(daysRaw);
  if (!parsedDays.length) {
    await interaction.reply({
      content: "Не удалось распознать дни. Используй: пн, вт, ср, чт, пт, сб, вс",
      ephemeral: true,
    });
    return;
  }

  let hour = 0;
  let minute = 0;
  const timeStr = timeRaw.trim();
  if (!timeStr.includes(":")) {
    await interaction.reply({ content: "Формат времени: ЧЧ:ММ (например, 20:00)", ephemeral: true });
    return;
  }
  const parts = timeStr.split(":");
  hour = Number(parts[0]);
  minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    await interaction.reply({ content: "Неверное время. Формат: ЧЧ:ММ (например, 20:00)", ephemeral: true });
    return;
  }

  const entries = data.entries || [];
  const nextId = entries.reduce((max, e) => Math.max(max, e.id || 0), 0) + 1;
  const entry = {
    id: nextId,
    days: parsedDays,
    hour,
    minute,
    title: interaction.options.getString("title") || "Стрим",
    duration_minutes: interaction.options.getInteger("duration") || 120,
  };
  entries.push(entry);
  data.entries = entries;
  save();

  const daysStr = parsedDays.map((d) => DAY_NAMES_RU[d] || d).join(", ");
  await interaction.reply({
    content:
      `✅ Стрим #${nextId} добавлен:\n` +
      `📅 ${daysStr}\n` +
      `🕐 ${pad2(hour)}:${pad2(minute)} МСК\n` +
      `🎮 ${entry.title}\n` +
      `⏱ ${entry.duration_minutes} мин`,
    ephemeral: true,
  });
}

async function cmdRemove(interaction) {
  const entryId = interaction.options.getInteger("entry_id");
  if (entryId === null || entryId === undefined) {
    await interaction.reply({ content: "Укажи ID записи. Посмотри: `/schedule view`", ephemeral: true });
    return;
  }
  const entries = data.entries || [];
  const before = entries.length;
  const filtered = entries.filter((e) => (e.id || 0) !== entryId);
  if (filtered.length === before) {
    await interaction.reply({ content: `Запись #${entryId} не найдена.`, ephemeral: true });
    return;
  }
  data.entries = filtered;
  save();
  await interaction.reply({ content: `✅ Стрим #${entryId} удалён.`, ephemeral: true });
}

async function cmdClear(interaction) {
  data.entries = [];
  data.notified = {};
  save();
  await interaction.reply({ content: "✅ Расписание очищено.", ephemeral: true });
}

const cog = {
  name: "Schedule",
  async setup(registry) {
    bot = registry.client;

    registry.slash({
      name: "schedule",
      description: "Расписание стримов",
      guildOnly: true,
      options: [
        {
          name: "action",
          description: "Что сделать",
          type: 3,
          required: true,
          choices: [
            { name: "Показать расписание", value: "view" },
            { name: "Добавить стрим", value: "add" },
            { name: "Удалить стрим", value: "remove" },
            { name: "Очистить всё", value: "clear" },
          ],
        },
        { name: "days", description: "Дни недели: пн,ср,пт", type: 3, required: false },
        { name: "time", description: "Время старта (ЧЧ:ММ, МСК)", type: 3, required: false },
        { name: "title", description: "Название стрима", type: 3, required: false },
        { name: "duration", description: "Длительность в минутах", type: 4, required: false },
        { name: "entry_id", description: "ID записи (для удаления)", type: 4, required: false },
      ],
      async run(interaction) {
        const action = interaction.options.getString("action", true);
        if (action === "view") return cmdView(interaction);
        if (action === "add") return cmdAdd(interaction);
        if (action === "remove") return cmdRemove(interaction);
        if (action === "clear") return cmdClear(interaction);
      },
    });

    registry.event("ready", async () => {
      if (started) return;
      started = true;
      if (cfg.enabled === false) return;
      intervalId = setInterval(() => {
        checkOnce().catch((e) => log.error("Schedule", `Ошибка цикла: ${e.message}`, e));
      }, 60000);
      log.info("Schedule", "Проверка напоминаний запущена");
    });
  },
};

export default cog;