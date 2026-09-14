import { EmbedBuilder } from "discord.js";
import { CONFIG, GUILD_ID } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.welcome || {};

function buildEmbed(member) {
  const guild = member.guild;
  const descriptions = cfg.channel_descriptions || {};
  const voiceDescriptions = cfg.voice_descriptions || {};
  const hiddenVoice = new Set(cfg.hidden_voice || []);

  // Pre-group channels by parent to avoid O(n²) filtering per category
  const allChannels = [...guild.channels.cache.values()];
  const byParent = new Map();
  for (const c of allChannels) {
    const pid = c.parentId || "__root__";
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(c);
  }
  const categories = allChannels.filter((c) => c.type === 4).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const me = guild.members.me;
  const lines = [];
  for (const cat of categories) {
    const children = byParent.get(cat.id) || [];
    const textChannels = children
      .filter((c) => {
        if (c.type !== 0) return false;
        try {
          const perms = c.permissionsFor(guild.roles.everyone);
          return perms && perms.has("ViewChannel");
        } catch { return false; }
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    if (textChannels.length > 0) {
      const catLines = textChannels.map((c) => {
        const desc = descriptions[c.name] || "Общение в канале";
        return `• **<#${c.id}>** — ${desc}`;
      });
      lines.push(`**${cat.name}**`);
      lines.push(...catLines);
      lines.push("");
    }
  }

  const voiceLines = [];
  for (const vc of allChannels.filter((c) => c.type === 2)) {
    if (hiddenVoice.has(vc.name)) continue;
    try {
      if (!vc.permissionsFor(guild.roles.everyone).has("Connect")) continue;
    } catch { continue; }
    const desc = voiceDescriptions[vc.name] || "Голосовой канал";
    voiceLines.push(`• **${vc.name}** — ${desc}`);
  }
  if (voiceLines.length > 0) {
    lines.push("**Голосовые каналы**");
    lines.push(...voiceLines);
  }

  const intro =
    cfg.intro || "Рады видеть тебя на сервере! Загляни в чаты и приходи на стримы.";
  const embed = new EmbedBuilder()
    .setTitle(cfg.title || "Добро пожаловать!")
    .setDescription(intro)
    .setColor(0x9b59b6);

  if (lines.length > 0) {
    let channelText = lines.join("\n").trim();
    if (channelText.length > 1024) channelText = channelText.slice(0, 1020) + "\n…";
    embed.addFields({ name: "📂 Наши каналы", value: channelText, inline: false });
  }

  if (GUILD_ID && guild.rulesChannelId) {
    embed.addFields({
      name: "📜 Правила",
      value: `Ознакомься с правилами сервера: <#${guild.rulesChannelId}>`,
      inline: false,
    });
  }

  embed.setFooter({ text: cfg.footer || "Приятного времяпрепровождения!" });
  return embed;
}

const cog = {
  name: "Welcome",
  async setup(registry) {
    registry.event("guildMemberAdd", async (member) => {
      if (member.user.bot) return;
      if (!cfg.enabled && cfg.enabled !== undefined) return;

      if (cfg.send_dm !== false) {
        try {
          let embed = buildEmbed(member);
          if (embed.data.description && embed.data.description.length > 4096 || (embed.data.fields && JSON.stringify(embed.data).length > 6000)) {
            embed = new EmbedBuilder()
              .setTitle(cfg.title || "Добро пожаловать!")
              .setDescription(
                (cfg.intro || "Рады видеть тебя на сервере! Загляни в чаты и приходи на стримы.").slice(0, 4096)
              )
              .setColor(0x9b59b6);
          }
          await member.send({ embeds: [embed] });
          log.info("Welcome", `Приветствие отправлено ${member.user.tag}`);
        } catch (e) {
          if (e.code === 50007 || e.httpStatus === 403) {
            log.info("Welcome", `Нельзя отправить ЛС ${member.user.tag}`);
          } else {
            log.warn("Welcome", `Ошибка отправки ЛС ${member.user.tag}`);
          }
        }
      }

      // Публичный пост — вход
      const enabledKey = "welcome_channel_enabled";
      if (cfg[enabledKey] === false) return;
      const cid = cfg.welcome_channel_id;
      if (!cid) return;
      const channel = member.guild.channels.cache.get(String(cid));
      if (!channel) return;

      try {
        const embed = new EmbedBuilder()
          .setDescription(`**${member.displayName}** зашёл на сервер! Поздороваемся вместе? 👋`)
          .setColor(0x2ecc71);
        if (member.displayAvatarURL()) {
          embed.setAuthor({ name: "Новый участник", iconURL: member.displayAvatarURL({ extension: "png", size: 256 }) });
        }
        embed.addFields({ name: "Участников на сервере", value: String(member.guild.memberCount), inline: true });
        embed.setFooter({ text: `ID: ${member.id}` });
        await channel.send({ embeds: [embed] });
        log.info("Welcome", `Вступил ${member.user.tag} (${member.id})`);
      } catch (e) {
        log.warn("Welcome", `Ошибка отправки в канал ${channel.name || cid}`);
      }
    });

    registry.event("guildMemberRemove", async (member) => {
      if (member.user.bot) return;
      if (!cfg.enabled && cfg.enabled !== undefined) return;

      const enabledKey = "leave_channel_enabled";
      if (cfg[enabledKey] === false) return;
      const cid = cfg.leave_channel_id;
      if (!cid) return;
      const channel = member.guild.channels.cache.get(String(cid));
      if (!channel) return;

      try {
        const embed = new EmbedBuilder()
          .setDescription(`**${member.displayName}** покинул сервер. До встречи! 👋`)
          .setColor(0x2c2f33);
        if (member.displayAvatarURL()) {
          embed.setAuthor({ name: "Участник вышел", iconURL: member.displayAvatarURL({ extension: "png", size: 256 }) });
        }
        embed.setFooter({ text: `ID: ${member.id}` });
        await channel.send({ embeds: [embed] });
        log.info("Welcome", `Вышел ${member.user.tag} (${member.id})`);
      } catch (e) {
        log.warn("Welcome", `Ошибка отправки в канал ${channel.name || cid}`);
      }
    });
  },
};

export default cog;
