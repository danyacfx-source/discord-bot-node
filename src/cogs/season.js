import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { SEASON } from "../config.js";
import * as db from "../db.js";
import { log } from "../notify.js";

const MEDALS = ["🥇", "🥈", "🥉"];

const cog = {
  name: "Season",

  async setup(registry) {
    registry.slash({
      name: "season_top",
      description: "Топ активности за текущий сезон",
      guildOnly: true,
      async run(interaction, _registry, client) {
        const rows = db.getSeasonLeaderboard(String(interaction.guildId), 10);
        if (!rows.length) {
          await interaction.reply("Сезон только начался — данных пока нет.");
          return;
        }
        await interaction.deferReply();
        const lines = [];
        for (let i = 0; i < rows.length; i++) {
          const { user_id, points } = rows[i];
          const pos = i + 1;
          let name = `Пользователь ${String(user_id)}`;
          try {
            const member = await interaction.guild.members.fetch(String(user_id));
            name = member.displayName ?? member.user.username;
          } catch {}
          const medal = pos <= 3 ? MEDALS[pos - 1] : `**${pos}.**`;
          lines.push(`${medal} ${name} — ${points} сообщений`);
        }
        const embed = new EmbedBuilder()
          .setTitle("🏆 Сезонный топ")
          .setDescription(lines.join("\n"))
          .setColor(0xf1c40f);
        await interaction.followUp({ embeds: [embed] });
      },
    });

    registry.slash({
      name: "season_end",
      description: "Подвести итоги сезона: наградить топ-3 и сбросить счётчики",
      guildOnly: true,
      async run(interaction, _registry, client) {
        // Permission check: only Administrator or ManageGuild can wipe season
        const perms = interaction.memberPermissions;
        if (!perms?.has(PermissionFlagsBits.Administrator) && !perms?.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({ content: "Недостаточно прав. Требуется **Administrator** или **Manage Guild**.", ephemeral: true });
          return;
        }
        if (!SEASON.enabled) {
          await interaction.reply({ content: "Сезонный модуль отключён в конфиге.", ephemeral: true });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        const rewardNamesRaw = SEASON.reward_roles || [];
        // Validate rewardRoles: must be array of 3 non-empty unique strings and roles must exist
        if (!Array.isArray(rewardNamesRaw) || rewardNamesRaw.length < 3) {
          await interaction.followUp({ content: "В конфиге меньше 3 ролей наград.", ephemeral: true });
          return;
        }
        const rewardNames = rewardNamesRaw.map((r) => String(r).trim()).filter(Boolean);
        if (rewardNames.length < 3) {
          await interaction.followUp({ content: "Некорректные роли наград в конфиге (пустые имена).", ephemeral: true });
          return;
        }
        // Check duplicates (case-insensitive)
        const lower = rewardNames.map((n) => n.toLowerCase());
        if (new Set(lower).size !== lower.length) {
          await interaction.followUp({ content: "В конфиге дублируются роли наград.", ephemeral: true });
          return;
        }
        // Ensure roles exist in guild
        const missingRoles = rewardNames.filter((name) => !guild.roles.cache.find((r) => r.name === name));
        if (missingRoles.length) {
          await interaction.followUp({ content: `Роли не найдены на сервере: ${missingRoles.join(", ")}`, ephemeral: true });
          return;
        }
        const rows = db.getSeasonLeaderboard(String(guild.id), 3);
        if (!rows.length) {
          await interaction.followUp({ content: "Нет данных за сезон — награждать некого.", ephemeral: true });
          return;
        }
        const awarded = [];
        for (let i = 0; i < rows.length; i++) {
          const { user_id, points } = rows[i];
          const pos = i + 1;
          let member;
          try {
            member = await guild.members.fetch(String(user_id));
          } catch {}
          const role = guild.roles.cache.find((r) => r.name === rewardNames[i]);
          if (!member || !role) {
            awarded.push(`${MEDALS[i]} ${String(user_id)}: пропущен (нет участника/роли)`);
            continue;
          }
          for (const oldName of rewardNames) {
            const oldRole = guild.roles.cache.find((r) => r.name === oldName);
            if (oldRole && member.roles.cache.has(oldRole.id)) {
              try {
                await member.roles.remove(oldRole, "Награды нового сезона");
              } catch {}
            }
          }
          try {
            await member.roles.add(role, "Награда за сезон");
            awarded.push(`${MEDALS[i]} **${member.displayName}** + ${role} (${points} сообщений)`);
          } catch {
            awarded.push(`${MEDALS[i]} ${member.displayName}: нет прав на выдачу`);
          }
        }

        db.seasonReset(String(guild.id));

        const summary = awarded.join("\n");
        const announceId = SEASON.announce_channel_id || 0;
        if (announceId) {
          const channel = guild.channels.cache.get(String(announceId));
          if (channel) {
            const embed = new EmbedBuilder()
              .setTitle("🏆 Итоги сезона!")
              .setDescription(summary)
              .setColor(0xf1c40f)
              .setFooter({ text: `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC` });
            try {
              await channel.send({ embeds: [embed] });
            } catch (e) {
              log.error("Season", "Ошибка анонса итогов сезона", e);
            }
          }
        }
        await interaction.followUp({ content: `**Итоги сезона:**\n${summary}`, ephemeral: true });
      },
    });
  },
};

export default cog;
