import { EmbedBuilder } from "discord.js";
import { CONFIG } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.kick || {};
const liveCfg = cfg.live || {};
const SLUG = liveCfg.channel || cfg.channel || "dendosich";
const POLL_MS = Math.max(30, liveCfg.poll_interval_seconds || 300) * 1000;

function fmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

async function fetchStatus() {
  const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(SLUG)}`, {
    headers: { Accept: "application/json", "User-Agent": "DiscordBot/1.0" },
  });
  if (!res.ok) throw new Error(`Kick API ${res.status}`);
  const data = await res.json();
  const live = data.livestream || null;
  return {
    isLive: Boolean(live && live.is_live),
    title: live?.session_title || "",
    viewers: live?.viewer_count ?? 0,
    category: live?.categories?.[0]?.name || "",
    thumbnail: live?.thumbnail?.url || "",
    startedAt: live?.created_at || null,
  };
}

const cog = {
  name: "Kick",
  _wasLive: null,
  _timer: null,

  async setup(registry) {
    if (!cfg.enabled) {
      log.info("Kick", "Kick-модуль отключён в конфиге (kick.enabled=false)");
      return;
    }

    registry.event("clientReady", async (client) => {
      if (cog._timer) return;
      cog.bot = client;
      const run = () => cog._check(client);
      // Первый опрос — сразу (без поста), потом по интервалу
      run().catch((e) => log.error("Kick", `Ошибка first poll: ${e.message}`, e));
      cog._timer = setInterval(run, POLL_MS);
      log.info("Kick", `Следим за стримом kick.com/${SLUG} (${POLL_MS / 1000}с)`);
    });

    registry.slash({
      name: "kick_status",
      description: "Текущий статус стрима на Kick",
      guildOnly: true,
      options: [],
      async run(interaction) {
        await interaction.deferReply();
        let status;
        try {
          status = await fetchStatus();
        } catch (e) {
          await interaction.editReply({ content: `Не удалось получить статус: ${e.message}` });
          return;
        }
        const embed = new EmbedBuilder()
          .setTitle(status.isLive ? "🔴 Стрим идёт!" : "⚫ Стрим офлайн")
          .setDescription(status.isLive
            ? `**${status.title || "Без названия"}**`
            : "Стример сейчас не в эфире.")
          .setColor(status.isLive ? 0xe74c3c : 0x2c2f33)
          .setURL(`https://kick.com/${SLUG}`);
        if (status.isLive) {
          embed.addFields(
            { name: "Категория", value: status.category || "—", inline: true },
            { name: "Зрители", value: fmtNum(status.viewers), inline: true }
          );
          if (status.thumbnail) embed.setThumbnail(status.thumbnail);
        }
        await interaction.editReply({ embeds: [embed] });
      },
    });
  },

  async _check(client) {
    if (!cfg.enabled || !liveCfg.enabled) return;
    let status;
    try {
      status = await fetchStatus();
    } catch (e) {
      log.warn("Kick", `Ошибка запроса статуса: ${e.message}`);
      return;
    }
    const nowLive = status.isLive;
    if (cog._wasLive === null) {
      // Первый опрос — только учим текущее состояние, не постим
      cog._wasLive = nowLive;
      return;
    }
    if (nowLive && !cog._wasLive) {
      await cog._notifyLive(client, status).catch((e) =>
        log.error("Kick", `Ошибка уведомления о стриме: ${e.message}`, e)
      );
    }
    cog._wasLive = nowLive;
  },

  async _notifyLive(client, status) {
    const channelId = liveCfg.channel_id;
    const channel = channelId ? client.channels.cache.get(String(channelId)) : null;
    if (!channel) {
      log.warn("Kick", `Канал для уведомлений не найден (kick.live.channel_id=${channelId})`);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("🔴 Мы в эфире!")
      .setDescription(`**${status.title || "Стрим начался"}**`)
      .setURL(`https://kick.com/${SLUG}`)
      .setColor(0xe74c3c)
      .addFields(
        { name: "Категория", value: status.category || "—", inline: true },
        { name: "Зрители", value: fmtNum(status.viewers), inline: true }
      );
    if (status.thumbnail) embed.setThumbnail(status.thumbnail);

    const pingRole = liveCfg.ping_role_id;
    const content = pingRole ? `<@&${pingRole}>` : "@everyone";
    const msg = await channel.send({ content, embeds: [embed] });
    log.info("Kick", `Отправлено уведомление о стриме в #${channel.name} (${msg.id})`);
  },
};

export default cog;