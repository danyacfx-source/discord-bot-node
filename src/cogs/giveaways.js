import { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } from "discord.js";
import * as db from "../db.js";
import { log } from "../notify.js";

const cog = {
  name: "Giveaways",
  _nextId: 1,
  _started: false,
  active: new Map(),

  async setup(registry) {
    registry.event("ready", async (client) => {
      if (cog._started) return;
      cog._started = true;
      cog._nextId = db.giveawayNextId() + 1;
      const active = db.giveawaysLoadActive();
      for (const ga of active) {
        let participants;
        try {
          participants = new Set(JSON.parse(ga.participants || "[]"));
        } catch {
          participants = new Set();
        }
        ga.participants = participants;
        cog.active.set(ga.id, ga);
        cog._nextId = Math.max(cog._nextId, ga.id + 1);
        cog._spawnFinish(ga.id, client);
      }
    });

    registry.slash({
      name: "giveaway",
      description: "Запустить розыгрыш (только для админов)",
      guildOnly: true,
      options: [
        { name: "prize", description: "Что разыгрываем?", type: 3, required: true },
        { name: "duration", description: "Длительность в минутах (1-10080)", type: 4, required: true },
        { name: "description", description: "Описание (необязательно)", type: 3, required: false },
        { name: "winners", description: "Количество победителей (по умолчанию 1)", type: 4, required: false },
        { name: "min_days", description: "Мин. дней на сервере (по умолчанию 0)", type: 4, required: false },
      ],
      async run(interaction, _registry, client) {
        const prize = interaction.options.getString("prize");
        const duration = interaction.options.getInteger("duration");
        const description = interaction.options.getString("description") || "";
        const winners = Math.max(1, Math.min(20, interaction.options.getInteger("winners") || 1));
        const minDays = Math.max(0, interaction.options.getInteger("min_days") || 0);

        if (duration < 1 || duration > 10080) {
          await interaction.reply({ content: "Длительность: 1-10080 минут.", ephemeral: true });
          return;
        }

        const gaId = cog._nextId++;
        const endTime = Date.now() / 1000 + duration * 60;

        const ga = {
          id: gaId,
          title: `Giveaway: ${prize}`,
          prize,
          description,
          winner_count: winners,
          end_time: endTime,
          channel_id: interaction.channelId,
          guild_id: interaction.guildId,
          message_id: 0,
          author_id: interaction.user.id,
          min_days: minDays,
          participants: new Set(),
          participants_json: "[]",
          status: "active",
        };
        cog.active.set(gaId, ga);

        const embed = cog._buildEmbed(ga);
        const row = cog._buildRow(gaId);
        await interaction.reply({ embeds: [embed], components: [row] });
        const msg = await interaction.fetchReply();
        ga.message_id = msg.id;
        db.giveawaySave({ ...ga, participants_json: "[]" });
        cog._spawnFinish(gaId, client);
      },
    });

    registry.slash({
      name: "reroll",
      description: "Перевыбрать победителя розыгрыша",
      guildOnly: true,
      options: [
        { name: "message_link", description: "Ссылка на сообщение розыгрыша", type: 3, required: true },
        { name: "winners", description: "Сколько победителей", type: 4, required: false },
      ],
      async run(interaction) {
        const link = interaction.options.getString("message_link");
        const count = interaction.options.getInteger("winners") || 1;
        const messageId = cog._extractMessageId(link);
        if (!messageId) {
          await interaction.reply({ content: "Не удалось распознать ссылку.", ephemeral: true });
          return;
        }
        const ga = db.giveawaysFindByMessage(messageId);
        if (!ga || ga.status !== "finished") {
          await interaction.reply({ content: "Завершённый розыгрыш не найден.", ephemeral: true });
          return;
        }
        let participants;
        try {
          participants = JSON.parse(ga.participants || "[]");
        } catch {
          participants = [];
        }
        if (!participants.length) {
          await interaction.reply({ content: "Участников не было.", ephemeral: true });
          return;
        }
        const n = Math.min(Math.max(1, count), participants.length);
        const winnersList = cog._sample(participants, n);
        const mentions = winnersList.map((id) => `<@${id}>`).join(", ");
        const embed = new EmbedBuilder()
          .setTitle(`Реролл: ${ga.prize}`)
          .setDescription(`Новый победитель: ${mentions}\nПоздравляем! 🎉`)
          .setColor(0x2ecc71);
        await interaction.reply({ embeds: [embed] });
      },
    });

    registry.componentPrefix("gwa_", async (interaction, _registry, client) => {
      const customId = interaction.customId;
      if (!customId.startsWith("gwa_join:")) return;
      const parts = customId.split(":");
      const gaId = Number(parts[1]);
      const ga = cog.active.get(gaId);
      if (!ga) {
        await interaction.reply({ content: "Розыгрыш уже завершён.", ephemeral: true });
        return;
      }
      const uid = interaction.user.id;
      let member;
      try {
        member = await interaction.guild.members.fetch(uid);
      } catch {}

      if (ga.min_days && member) {
        const days = cog._memberDays(member);
        if (days < ga.min_days) {
          await interaction.reply({
            content: `Чтобы участвовать, нужно быть на сервере минимум **${ga.min_days} дн.** (ты здесь ${days} дн.).`,
            ephemeral: true,
          });
          return;
        }
      }

      if (ga.participants.has(uid)) {
        ga.participants.delete(uid);
        await interaction.reply({ content: "Ты покинул розыгрыш.", ephemeral: true });
      } else {
        ga.participants.add(uid);
        await interaction.reply({
          content: `Ты участвуешь! (${ga.participants.size} участ.)`,
          ephemeral: true,
        });
      }

      db.giveawaySetParticipants(gaId, [...ga.participants], ga.status);
      try {
        await interaction.message.edit({ embeds: [cog._buildEmbed(ga)] });
      } catch {}
    });
  },

  _spawnFinish(gaId, client) {
    const ga = cog.active.get(gaId);
    if (!ga) return;
    const delay = Math.max(1000, Math.round((ga.end_time - Date.now() / 1000) * 1000));
    setTimeout(() => cog._finishGiveaway(gaId, client), delay);
  },

  async _finishGiveaway(gaId, client) {
    const ga = cog.active.get(gaId);
    if (!ga) return;
    cog.active.delete(gaId);
    const participants = [...ga.participants];
    const count = Math.min(ga.winner_count, participants.length);

    let embed;
    if (count === 0) {
      embed = new EmbedBuilder()
        .setTitle(ga.title)
        .setDescription("Не было участников — розыгрыш отменён.")
        .setColor(0xe74c3c);
    } else {
      const winnersList = cog._sample(participants, count);
      const mentions = winnersList.map((id) => `<@${id}>`).join(", ");
      embed = new EmbedBuilder()
        .setTitle(`Розыгрыш завершён: ${ga.prize}`)
        .setDescription(`Победитель: ${mentions}\nПоздравляем! 🎉`)
        .setColor(0x2ecc71);
    }

    try {
      db.giveawaySetParticipants(gaId, participants, "finished");
    } catch (e) {
      log.error("Giveaways", "Не удалось сохранить итог", e);
    }

    const channel = client.channels.cache.get(String(ga.channel_id));
    if (!channel) return;
    try {
      if (ga.message_id) {
        const msg = await channel.messages.fetch(ga.message_id);
        await msg.edit({ embeds: [embed], components: [] });
      } else {
        await channel.send({ embeds: [embed] });
      }
    } catch (e) {
      log.error("Giveaways", "Не удалось опубликовать результаты", e);
    }
  },

  _buildEmbed(ga) {
    const remaining = Math.max(0, Math.round(ga.end_time - Date.now() / 1000));
    const s = remaining % 60;
    const m = Math.floor(remaining / 60) % 60;
    const h = Math.floor(remaining / 3600);
    const timeStr = h ? `${h}ч ${m}м ${s}с` : `${m}м ${s}с`;
    const embed = new EmbedBuilder()
      .setTitle(ga.title)
      .setDescription(ga.description || "Нажми кнопку, чтобы участвовать!")
      .setColor(0xf1c40f)
      .addFields(
        { name: "Приз", value: ga.prize, inline: true },
        { name: "Участников", value: String(ga.participants.size ?? ga.participants.length ?? 0), inline: true },
        { name: "Осталось", value: timeStr, inline: true }
      );
    if (ga.min_days) {
      embed.addFields({ name: "Условие", value: `От ${ga.min_days} дн. на сервере`, inline: false });
    }
    if ((ga.winner_count || 1) > 1) {
      embed.setFooter({ text: `Победителей: ${ga.winner_count}` });
    }
    return embed;
  },

  _buildRow(gaId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gwa_join:${gaId}`)
        .setLabel("Участвовать!")
        .setStyle(ButtonStyle.Success)
        .setEmoji("🎉")
    );
  },

  _memberDays(member) {
    if (!member || !member.joinedAt) return 0;
    return Math.floor((Date.now() - member.joinedAt.getTime()) / 86400000);
  },

  _sample(arr, n) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
  },

  _extractMessageId(link) {
    if (/^\d+$/.test(link)) return Number(link);
    const parts = link.split("/");
    const last = parts[parts.length - 1];
    return /^\d+$/.test(last) ? Number(last) : null;
  },
};

export default cog;
