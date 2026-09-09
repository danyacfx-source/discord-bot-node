import { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } from "discord.js";
import * as db from "../db.js";
import { CONFIG } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.sponsor || {};
const donateUrl = CONFIG.socials?.donate || "";

const cog = {
  name: "Sponsor",
  async setup(registry) {
    registry.event("clientReady", async (client) => {
      if (!cfg.enabled) return;
      if (!cfg.channel_id) {
        log.info("Sponsor", "Канал не задан (sponsor.channel_id) — модуль пропущен");
        return;
      }
      if (!donateUrl) {
        log.info("Sponsor", "Ссылка на донат пуста (socials.donate) — модуль пропущен");
        return;
      }
      try {
        await cog._ensureMessage(client);
      } catch (e) {
        log.error("Sponsor", `Ошибка создания кнопки: ${e.message}`, e);
      }
    });
  },

  async _ensureMessage(client) {
    const channel = client.channels.cache.get(String(cfg.channel_id));
    if (!channel) {
      log.warn("Sponsor", `Канал ${cfg.channel_id} не найден`);
      return;
    }

    // Идемпотентность: если сообщение уже есть — не дублируем
    const existing = db.kvGet("sponsor_message_id");
    if (existing) {
      try {
        const msg = await channel.messages.fetch(existing);
        if (msg) {
          const hasLink = msg.components?.[0]?.components?.some(
            (c) => c.type === 2 && c.style === 5 && c.url === donateUrl
          );
          if (hasLink) return;
          await msg.edit({ embeds: [cog._buildEmbed()], components: [cog._buildRow()] });
          return;
        }
      } catch {
        // сообщение удалено — создаём новое
      }
    }

    const msg = await channel.send({ embeds: [cog._buildEmbed()], components: [cog._buildRow()] });
    db.kvSet("sponsor_message_id", msg.id);
    log.info("Sponsor", `Кнопка «Стать спонсором» размещена в #${channel.name} (${msg.id})`);
  },

  _buildEmbed() {
    return new EmbedBuilder()
      .setTitle("⭐ Поддержать стрим")
      .setDescription(
        cfg.message ||
          "Поддержи стрим и получай бонусы! Нажми на кнопку ниже, чтобы оформить спонсорство."
      )
      .setColor(0xf1c40f)
      .setFooter({ text: "Спасибо за поддержку! ❤️" });
  },

  _buildRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Стать спонсором ⭐")
        .setStyle(ButtonStyle.Link)
        .setURL(donateUrl)
    );
  },
};

export default cog;