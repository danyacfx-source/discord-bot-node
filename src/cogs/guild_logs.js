import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { EmbedBuilder } from "discord.js";
import { CONFIG } from "../config.js";
import { log } from "../notify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, "..");

const cfg = CONFIG.guild_logs || {};
let bot = null;

const messages = new Map();
const removals = new Map();
let readyAt = 0;
let startupPosted = false;
let lastSend = 0;
let sendChain = Promise.resolve();

function trunc(text, limit) {
  let t = (text ?? "").trim() || "∅";
  if (t.length > limit) t = t.slice(0, limit - 1) + "…";
  return t;
}

function code(text, limit) {
  let t = (text ?? "").trim() || "∅";
  t = t.replace(/```/g, "‛‛‛");
  if (t.length > limit) t = t.slice(0, limit - 1) + "…";
  return t;
}

function cid(key) {
  return cfg[key] || 0;
}

function cnl(key) {
  const id = cid(key);
  if (!id || !bot) return null;
  return bot.channels.cache.get(String(id)) || null;
}

function enabled() {
  return cfg.enabled !== false;
}

function ignoredChannel(channel) {
  if (!channel) return true;
  const cats = new Set((cfg.ignore_category_ids || []).map((x) => String(x)));
  const chs = new Set((cfg.ignore_channel_ids || []).map((x) => String(x)));
  return chs.has(String(channel.id)) || cats.has(String(channel.parentId));
}

function ignoredAuthor(author) {
  if (!author) return true;
  if (cfg.ignore_bots !== false && author.bot) return true;
  return false;
}

function avatarUrl(obj) {
  if (!obj) return null;
  return obj.displayAvatarURL?.({ size: 256 }) || null;
}

function sendThrottled(channel, embed) {
  const task = sendChain.then(async () => {
    const now = Date.now();
    const wait = 800 - (now - lastSend);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    await channel.send({ embeds: [embed] });
    lastSend = Date.now();
  });
  sendChain = task.catch(() => {});
  return task;
}

function gitRevParse(args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", REPO_DIR, ...args], { timeout: 10000 }, (err, stdout) => {
      resolve((stdout || "").toString().trim() || "?");
    });
  });
}

async function previousDeployCommit(ch) {
  try {
    const fetched = await ch.messages.fetch({ limit: 5 });
    for (const msg of fetched.values()) {
      if (!msg.author || msg.author.id !== bot.user.id) continue;
      for (const emb of msg.embeds) {
        const field = emb.fields?.find((f) => f.name === "Версия (commit)");
        if (field) return String(field.value || "").replace(/`/g, "");
      }
    }
  } catch {}
  return "";
}

async function postDeployLog() {
  const ch = cnl("deploy_log_channel_id");
  if (!ch) return;
  try {
    const commit = await gitRevParse(["rev-parse", "--short", "HEAD"]);
    const branch = await gitRevParse(["rev-parse", "--abbrev-ref", "HEAD"]);
    const prev = await previousDeployCommit(ch);
    const title =
      prev && prev === commit ? `🔄 Перезапуск: \`${commit}\`` : `🚀 Деплой: \`${commit}\``;
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(0x2ecc71)
      .setTimestamp()
      .addFields(
        { name: "Бот", value: `<@${bot.user.id}>`, inline: true },
        { name: "Версия (commit)", value: `\`${commit}\``, inline: true },
        { name: "Ветка", value: `\`${branch}\``, inline: true },
        { name: "PID", value: `\`${process.pid}\``, inline: true }
      );
    await ch.send({ embeds: [embed] });
  } catch (e) {
    log.warn("GuildLogs", `Не удалось отправить лог деплоя: ${e.message}`);
  }
}

async function onReady(client) {
  bot = client;
  readyAt = Date.now();
  if (startupPosted || cfg.startup_notify === false) return;
  startupPosted = true;
  await postDeployLog();
  const ch = cnl("bot_log_channel_id");
  if (!ch) return;
  try {
    const embed = new EmbedBuilder()
      .setTitle("🚀 Бот запущен и готов к работе")
      .setColor(0x5865f2)
      .setTimestamp()
      .addFields(
        { name: "Бот", value: `<@${bot.user?.id}>`, inline: true },
        { name: "Серверов", value: String(bot.guilds.cache.size), inline: true }
      );
    await ch.send({ embeds: [embed] });
  } catch (e) {
    log.warn("GuildLogs", `Не удалось отправить сообщение о запуске: ${e.message}`);
  }
}

async function onMemberJoin(member) {
  if (!enabled() || ignoredAuthor(member)) return;
  const ch = cnl("member_log_channel_id");
  if (!ch) return;
  const now = Date.now() / 1000;
  const since = now - (removals.get(member.id) ?? 0);
  removals.delete(member.id);
  const windowSec = Math.max(60, (cfg.rejoin_window_minutes || 30) * 60);
  const rejoin = since > 0 && since < windowSec;

  const embed = new EmbedBuilder()
    .setTitle("Вступил на сервер")
    .setDescription(`<@${member.id}>\n**${member.displayName}**`)
    .setColor(0x2ecc71)
    .setTimestamp();
  const avatar = avatarUrl(member);
  if (avatar) embed.setAuthor({ name: member.displayName, iconURL: avatar });
  embed.addFields(
    { name: "ID", value: `\`${member.id}\``, inline: true },
    { name: "Всего участников", value: String(member.guild.memberCount), inline: true },
    {
      name: "Аккаунт создан",
      value: `<t:${Math.floor((member.user.createdTimestamp || Date.now()) / 1000)}:R>`,
      inline: true,
    }
  );
  if (rejoin) {
    embed.addFields({
      name: "Повторный вход",
      value: `~${Math.floor(since / 60)} мин назад`,
      inline: true,
    });
  }
  try {
    await ch.send({ embeds: [embed] });
  } catch (e) {
    log.warn("GuildLogs", `Ошибка лога вступления: ${e.message}`);
  }
}

async function onMemberRemove(member) {
  if (!enabled() || ignoredAuthor(member)) return;
  removals.set(member.id, Date.now() / 1000);
  const ch = cnl("member_log_channel_id");
  if (!ch) return;

  const embed = new EmbedBuilder()
    .setTitle("Вышел с сервера")
    .setDescription(`<@${member.id}>\n**${member.displayName}**`)
    .setColor(0x992d22)
    .setTimestamp();
  const avatar = avatarUrl(member);
  if (avatar) embed.setAuthor({ name: member.displayName, iconURL: avatar });
  embed.addFields(
    { name: "ID", value: `\`${member.id}\``, inline: true },
    { name: "Всего участников", value: String(member.guild.memberCount), inline: true }
  );
  if (member.joinedTimestamp) {
    embed.addFields({
      name: "Пробыл на сервере",
      value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`,
      inline: true,
    });
  }
  try {
    await ch.send({ embeds: [embed] });
  } catch (e) {
    log.warn("GuildLogs", `Ошибка лога выхода: ${e.message}`);
  }
}

function onMessage(message) {
  if (!enabled()) return;
  if (!message.guild || ignoredChannel(message.channel) || ignoredAuthor(message.author)) return;
  messages.set(message.id, {
    authorId: message.author.id,
    author: message.member?.displayName || message.author.username || "?",
    channelId: message.channel.id,
    content: message.content || "",
    attachments: message.attachments.size,
  });
  if (messages.size > 1200) {
    const firstKey = messages.keys().next().value;
    messages.delete(firstKey);
  }
}

async function onMessageDelete(message) {
  if (!enabled()) return;
  if (!message.guild || ignoredChannel(message.channel)) return;
  const ch = cnl("message_log_channel_id");
  if (!ch) return;
  const snap = messages.get(message.id);
  messages.delete(message.id);

  const embed = new EmbedBuilder().setTitle("🗑 Удалено сообщение").setColor(0xf39c12).setTimestamp();

  if (snap) {
    const authorMember = message.guild?.members?.cache?.get(snap.authorId);
    const icon = authorMember?.displayAvatarURL?.({ size: 256 });
    embed.setAuthor({ name: snap.author, iconURL: icon });
    const chan = bot?.channels?.cache?.get(snap.channelId);
    embed.addFields(
      { name: "Автор", value: `<@${snap.authorId}>`, inline: true },
      { name: "Канал", value: chan ? chan.toString() : `\`${snap.channelId}\``, inline: true },
      { name: "Вложений", value: String(snap.attachments), inline: true },
      { name: "Содержимое", value: `\`\`\`\n${code(snap.content, 1000)}\n\`\`\``, inline: false }
    );
  } else {
    const author = message.author;
    const name = author?.displayName ?? author?.username ?? "?";
    const uid = author?.id ?? "?";
    embed.setAuthor({ name });
    embed.addFields(
      { name: "Автор", value: `<@${uid}>`, inline: true },
      {
        name: "Канал",
        value: message.channel ? message.channel.toString() : "?",
        inline: true,
      },
      { name: "Содержимое", value: "Не закешировано", inline: false }
    );
  }

  try {
    await sendThrottled(ch, embed);
  } catch (e) {
    log.warn("GuildLogs", `Ошибка лога удаления: ${e.message}`);
  }
}

async function onMessageUpdate(oldMsg, newMsg) {
  if (!enabled()) return;
  if (!newMsg.guild || ignoredChannel(newMsg.channel) || ignoredAuthor(newMsg.author)) return;
  if ((oldMsg.content || "") === (newMsg.content || "")) return;
  const ch = cnl("message_log_channel_id");
  if (!ch) return;

  const snap = messages.get(newMsg.id);
  const prev = snap ? snap.content : oldMsg.content || "";
  const next = newMsg.content || "";
  if (snap) snap.content = next;

  const author = newMsg.author;
  const embed = new EmbedBuilder()
    .setTitle("✏️ Изменено сообщение")
    .setColor(0x5865f2)
    .setTimestamp();
  if (author?.displayAvatarURL?.()) {
    embed.setAuthor({ name: author.displayName || author.username, iconURL: author.displayAvatarURL({ size: 256 }) });
  } else {
    embed.setAuthor({ name: author?.displayName ?? author?.username ?? "?" });
  }
  embed.addFields(
    { name: "Автор", value: `<@${author.id}>`, inline: true },
    { name: "Канал", value: newMsg.channel.toString(), inline: true }
  );
  if (newMsg.url) {
    embed.addFields({ name: "Перейти", value: `[Открыть](${newMsg.url})`, inline: true });
  }
  embed.addFields(
    { name: "Было", value: `\`\`\`\n${code(prev, 900)}\n\`\`\``, inline: false },
    { name: "Стало", value: `\`\`\`\n${code(next, 900)}\n\`\`\``, inline: false }
  );

  try {
    await sendThrottled(ch, embed);
  } catch (e) {
    log.warn("GuildLogs", `Ошибка лога изменения: ${e.message}`);
  }
}

async function onVoiceStateUpdate(oldState, newState) {
  if (!enabled()) return;
  const member = newState.member || oldState.member;
  if (!member || ignoredAuthor(member)) return;
  const b = oldState.channel;
  const a = newState.channel;
  if (b === a) return;
  if (readyAt && Date.now() - readyAt < 20000) return;
  const ch = cnl("voice_log_channel_id");
  if (!ch) return;

  let title, color, target;
  if (!b) {
    title = "🎙 Вошёл в голосовой";
    color = 0x2ecc71;
    target = a;
  } else if (!a) {
    title = "🚪 Вышел из голосового";
    color = 0xf39c12;
    target = b;
  } else {
    title = "↔️ Перешёл в голосовом";
    color = 0x5865f2;
    target = a;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(`<@${member.id}>`)
    .setColor(color)
    .setTimestamp();
  const avatar = avatarUrl(member);
  if (avatar) embed.setAuthor({ name: member.displayName, iconURL: avatar });
  embed.addFields(
    { name: "ID", value: `\`${member.id}\``, inline: true },
    { name: "Канал", value: `\`${target?.name || "?"}\` (\`${target?.id || "?"}\`)`, inline: true }
  );
  if (b && a && b !== a) {
    embed.addFields({ name: "Было", value: `\`${b.name}\``, inline: true });
  }

  try {
    await sendThrottled(ch, embed);
  } catch (e) {
    log.warn("GuildLogs", `Ошибка лога голосового канала: ${e.message}`);
  }
}

async function onGuildBanAdd(ban) {
  if (!enabled()) return;
  const ch = cnl("mod_log_channel_id");
  if (!ch) return;
  const user = ban.user;
  const embed = new EmbedBuilder().setTitle("🛡 Забанен участник").setColor(0xe74c3c).setTimestamp();
  if (user?.displayAvatarURL?.()) {
    embed.setAuthor({ name: user.username, iconURL: user.displayAvatarURL({ size: 256 }) });
  }
  embed.addFields({ name: "Пользователь", value: `${user ? `<@${user.id}>` : "?"} (\`${user?.id || "?"}\`)`, inline: false });
  if (ban.reason) {
    embed.addFields({ name: "Причина", value: trunc(ban.reason, 400), inline: false });
  }
  try {
    await sendThrottled(ch, embed);
  } catch (e) {
    log.warn("GuildLogs", `Ошибка лога бана: ${e.message}`);
  }
}

async function onMemberUpdate(oldMember, newMember) {
  if (!enabled() || ignoredAuthor(newMember)) return;
  const ch = cnl("mod_log_channel_id");
  if (!ch) return;

  const changes = [];

  if (
    !oldMember ||
    (oldMember.communicationDisabledUntilTimestamp || 0) !== newMember.communicationDisabledUntilTimestamp
  ) {
    if (newMember.communicationDisabledUntilTimestamp) {
      changes.push(`⏱ Тайм-аут до <t:${Math.floor(newMember.communicationDisabledUntilTimestamp / 1000)}:R>`);
    } else if (oldMember?.communicationDisabledUntilTimestamp) {
      changes.push("⏱ Тайм-аут снят");
    }
  }

  const anyoneId = newMember.guild.roles.everyone.id;
  const oldRoles = new Set(oldMember ? oldMember.roles.cache.keys() : []);
  const newRoles = new Set(newMember.roles.cache.keys());
  const added = [...newRoles].filter((id) => id !== anyoneId && !oldRoles.has(id));
  const removed = [...oldRoles].filter((id) => id !== anyoneId && !newRoles.has(id));
  if (added.length) changes.push(`➕ Роли: ${added.map((id) => `<@&${id}>`).join(" ")}`);
  if (removed.length) changes.push(`➖ Роли: ${removed.map((id) => `<@&${id}>`).join(" ")}`);

  if (!changes.length) return;

  const embed = new EmbedBuilder()
    .setTitle("🛡 Изменён участник")
    .setDescription(changes.join("\n"))
    .setColor(0x34495e)
    .setTimestamp();
  embed.addFields({ name: "Участник", value: `<@${newMember.id}> (\`${newMember.id}\`)`, inline: false });
  try {
    await sendThrottled(ch, embed);
  } catch (e) {
    log.warn("GuildLogs", `Ошибка лога изменения участника: ${e.message}`);
  }
}

const cog = {
  name: "GuildLogs",
  async setup(registry) {
    registry.event("clientReady", onReady);
    registry.event("guildMemberAdd", onMemberJoin);
    registry.event("guildMemberRemove", onMemberRemove);
    registry.event("messageCreate", onMessage);
    registry.event("messageDelete", onMessageDelete);
    registry.event("messageUpdate", onMessageUpdate);
    registry.event("voiceStateUpdate", onVoiceStateUpdate);
    registry.event("guildBanAdd", onGuildBanAdd);
    registry.event("guildMemberUpdate", onMemberUpdate);
  },
};

export default cog;