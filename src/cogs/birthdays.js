import { EmbedBuilder } from "discord.js";
import * as db from "../db.js";
import { CONFIG, GUILD_ID } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.birthday || {};
let bot = null;
let started = false;
let intervalId = null;
let lastAnnouncedDay = "";

const DATE_RE = /^\s*(\d{1,2})[./\\-](\d{1,2})\s*$/;

function daysInMonth(month, year = 2000) {
  return new Date(year, month, 0).getDate();
}

function nextOccurrence(month, day, now) {
  const start = startOfDay(now);
  const lastDayOf = (m, year) => Math.min(day, daysInMonth(m, year));
  const thisYear = new Date(now.getFullYear(), month - 1, lastDayOf(month, now.getFullYear()));
  if (thisYear >= start) return thisYear;
  return new Date(now.getFullYear() + 1, month - 1, lastDayOf(month, now.getFullYear() + 1));
}

function startOfDay(now) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function fmtNum(n) {
  return String(n).padStart(2, "0");
}

async function announce() {
  const channelId = cfg.channel_id || 0;
  if (!channelId) return;
  const channel = bot.channels.cache.get(channelId);
  if (!channel) return;
  const guild = GUILD_ID ? bot.guilds.cache.get(GUILD_ID) : null;
  const now = new Date();
  const rows = db.birthdaysAll();
  const hits = rows.filter((r) => r.month === now.getMonth() + 1 && r.day === now.getDate());
  if (!hits.length) return;

  const lines = [];
  for (const row of hits) {
    let display = null;
    if (guild) {
      const member = guild.members.cache.get(String(row.user_id));
      if (member) display = member.displayName;
    }
    const mention = `<@${row.user_id}>`;
    const name = display || mention;
    lines.push(`🎂 **${name}** ${mention}`);
  }

  const embed = new EmbedBuilder()
    .setTitle("🎉 Сегодня день рождения!")
    .setDescription(lines.join("\n"))
    .setColor(0xff00ff);

  let content = "";
  const rolePing = cfg.role_ping || "";
  if (guild && rolePing) {
    const role = guild.roles.cache.find((r) => r.name === rolePing);
    if (role) content = role.toString();
  }

  try {
    await channel.send({ content: content || undefined, embeds: [embed] });
    log.info("Birthday", `Анонс отправлен (${lines.length} участников)`);
  } catch (e) {
    log.warn("Birthday", `Не удалось отправить анонс: ${e.message}`);
  }
}

function checkAnnounce() {
  const hour = Math.max(0, Math.min(23, cfg.announce_hour ?? 9));
  const now = new Date();
  const key = `${now.getFullYear()}-${fmtNum(now.getMonth() + 1)}-${fmtNum(now.getDate())}`;
  if (now.getHours() !== hour) return;
  if (lastAnnouncedDay === key) return;
  lastAnnouncedDay = key;
  announce().catch((e) => log.error("Birthday", `Ошибка анонса: ${e.message}`, e));
}

async function cmdSet(interaction) {
  const date = (interaction.options.getString("date", true) || "").trim();
  const m = DATE_RE.exec(date);
  if (!m) {
    await interaction.reply({
      content: "Неверный формат. Используй **дд.мм** (например `15.03`).",
      ephemeral: true,
    });
    return;
  }
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(month))) {
    await interaction.reply({ content: "Такая дата не существует.", ephemeral: true });
    return;
  }
  db.birthdaySet(Number(interaction.user.id), month, day);
  await interaction.reply({
    content: `Дата сохранена: **${fmtNum(day)}.${fmtNum(month)}**\nВ этот день бот поздравит тебя на сервере! 🎉`,
    ephemeral: true,
  });
}

async function cmdRemove(interaction) {
  const current = db.birthdayGet(Number(interaction.user.id));
  if (!current) {
    await interaction.reply({ content: "Дата не установлена.", ephemeral: true });
    return;
  }
  db.birthdayRemove(Number(interaction.user.id));
  await interaction.reply({ content: "Дата удалена.", ephemeral: true });
}

async function cmdList(interaction) {
  const rows = db.birthdaysAll();
  if (!rows.length) {
    await interaction.reply({ content: "Пока никто не указал дату.", ephemeral: true });
    return;
  }
  const now = new Date();
  const upcoming = rows
    .map((row) => {
      const next = nextOccurrence(row.month, row.day, now);
      const delta = Math.max(0, Math.round((next - startOfDay(now)) / 86400000));
      return { delta, uid: row.user_id, month: row.month, day: row.day };
    })
    .sort((a, b) => a.delta - b.delta);

  const guild = interaction.guild;
  const lines = [];
  for (const item of upcoming) {
    if (item.delta >= 365) continue;
    const member = guild?.members?.cache?.get(String(item.uid));
    const name = member ? member.displayName : `Пользователь ${item.uid}`;
    const when =
      item.delta === 0 ? "Сегодня! 🎉" : item.delta === 1 ? "Завтра" : `через ${item.delta} дн.`;
    lines.push(`**${name}** — ${fmtNum(item.day)}.${fmtNum(item.month)} (${when})`);
  }

  if (!lines.length) {
    await interaction.reply({ content: "Ближайших дней рождения нет.", ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("🎂 Ближайшие дни рождения")
    .setDescription(lines.slice(0, 25).join("\n"))
    .setColor(0xff00ff);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

const cog = {
  name: "Birthdays",
  async setup(registry) {
    bot = registry.client;

    registry.slash({
      name: "birthday",
      description: "Дни рождения участников",
      guildOnly: true,
      options: [
        {
          name: "set",
          description: "Указать свою дату рождения (дд.мм)",
          type: 1,
          options: [
            { name: "date", description: "Дата в формате дд.мм", type: 3, required: true },
          ],
        },
        { name: "remove", description: "Удалить свою дату рождения", type: 1 },
        { name: "list", description: "Ближайшие дни рождения", type: 1 },
      ],
      async run(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === "set") return cmdSet(interaction);
        if (sub === "remove") return cmdRemove(interaction);
        if (sub === "list") return cmdList(interaction);
      },
    });

    registry.event("ready", async () => {
      if (started) return;
      started = true;
      if (cfg.enabled === false) return;
      checkAnnounce();
      intervalId = setInterval(checkAnnounce, 3600000);
      log.info("Birthday", "Ежедневный анонс запущен");
    });
  },
};

export default cog;