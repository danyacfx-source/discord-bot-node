import { EmbedBuilder } from "discord.js";
import * as db from "../db.js";
import { EXCLUDE_ROLES, WHITELIST_CHANNELS } from "../config.js";
import { log } from "../notify.js";

const XP_COOLDOWN_SECONDS = 30;
const MAX_COOLDOWN_ENTRIES = 10000;
const _xpCooldowns = new Map();

const cog = {
  name: "Leveling",
  async setup(registry) {
    registry.event("messageCreate", async (message) => {
      if (message.author.bot) return;
      if (!message.guild) return;
      if (WHITELIST_CHANNELS.size > 0 && !WHITELIST_CHANNELS.has(message.channel.id)) return;
      if (EXCLUDE_ROLES.size > 0 && message.member.roles.cache.some((r) => EXCLUDE_ROLES.has(r.name))) return;

      const uid = message.author.id;
      const now = Date.now() / 1000;

      if (_xpCooldowns.size > MAX_COOLDOWN_ENTRIES) {
        for (const [k, v] of _xpCooldowns) {
          if (now - v > 300) _xpCooldowns.delete(k);
        }
      }

      const last = _xpCooldowns.get(uid) || 0;
      if (now - last < XP_COOLDOWN_SECONDS) return;
      _xpCooldowns.set(uid, now);

      db.addMessage(message.guild.id, message.author.id);
      db.seasonAddMessage(message.guild.id, message.author.id);
    });

    registry.slash({
      name: "level",
      description: "Показать свой текущий уровень и XP",
      guildOnly: true,
      options: [],
      async run(interaction) {
        const stats = db.getStats(interaction.guildId, interaction.user.id);
        const points = stats ? stats.points : 0;
        const xp = stats ? stats.xp : 0;
        const level = db.levelForXp(xp);
        const nextXp = db.totalXpFor(level + 1);
        const currentXp = db.xpInLevel(xp, level);
        const need = db.xpToNextLevel(level);
        const filled = need ? Math.round((currentXp / need) * 10) : 0;
        const bar = "█".repeat(filled) + "░".repeat(10 - filled);

        const embed = new EmbedBuilder()
          .setTitle(`Уровень ${interaction.user.displayName}`)
          .setColor(0x3498db)
          .addFields(
            { name: "Уровень", value: `**${level}**`, inline: false },
            { name: "XP", value: `${currentXp} / ${need}  \`${bar}\``, inline: false },
            { name: "Сообщений", value: String(points), inline: false }
          );

        if (nextXp > xp) {
          embed.addFields({ name: "До следующего уровня", value: `ещё **${nextXp - xp}** XP`, inline: false });
        } else {
          embed.addFields({ name: "Максимальный уровень", value: "Молодец!", inline: false });
        }

        await interaction.reply({ embeds: [embed] });
      },
    });

    registry.slash({
      name: "top",
      description: "Топ пользователей по активности",
      guildOnly: true,
      options: [],
      async run(interaction) {
        const rows = db.getLeaderboard(interaction.guildId, 10);
        if (!rows || rows.length === 0) {
          await interaction.reply({ content: "Пока нет данных об активности." });
          return;
        }
        const lines = rows.map((row, idx) => {
          const member = interaction.guild.members.cache.get(row.user_id);
          const name = member ? member.displayName : `Пользователь ${row.user_id}`;
          return `**${idx + 1}.** ${name} — ${row.points} сообщений`;
        });
        const embed = new EmbedBuilder()
          .setTitle("🏆 Топ активности")
          .setDescription(lines.join("\n"))
          .setColor(0xf1c40f);
        await interaction.reply({ embeds: [embed] });
      },
    });
  },
};

export default cog;
