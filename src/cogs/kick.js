import { EmbedBuilder } from "discord.js";
import * as db from "../db.js";
import { CONFIG } from "../config.js";
import { setStream, updatePresence, fmtNum } from "../stream_state.js";
import { log } from "../notify.js";

const cfg = CONFIG.kick || {};
const liveCfg = cfg.live || {};
const SLUG = liveCfg.channel || cfg.channel || "dendosich";
const POLL_MS = Math.max(30, liveCfg.poll_interval_seconds || 300) * 1000;
const LIVE_MSG_KEY = "kick_live_msg";
const URL = `https://kick.com/${SLUG}`;
const COLOR = 0xe74c3c;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function mskTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return pad2((d.getUTCHours() + 3) % 24) + ":" + pad2(d.getUTCMinutes()) + " МСК";
}

function durationHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}`;
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
    live: Boolean(live && live.is_live),
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
  _startedAt: null,
  _peak: 0,
  _last: null,

  async setup(registry) {
    if (!cfg.enabled) {
      log.info("Kick", "Kick-модуль отключён в конфиге (kick.enabled=false)");
      return;
    }

    registry.event("clientReady", async (client) => {
      if (cog._timer) return;
      cog.bot = client;
      const run = () => cog._check(client);
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
          .setColor(status.isLive ? COLOR : 0x2c2f33)
          .setURL(URL);
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
    setStream("kick", status);

    const nowLive = status.isLive;
    if (nowLive) cog._peak = Math.max(cog._peak, status.viewers || 0);

    if (cog._wasLive === null) {
      // Первый опрос: учим состояние. Если стрим уже идёт — размещаем эмбед без пинга
      cog._wasLive = nowLive;
      if (nowLive) {
        cog._startedAt = status.startedAt || cog._startedAt;
        await cog._ensureSticky(client, status, false);
      }
      updatePresence(client);
      return;
    }

    if (nowLive && !cog._wasLive) {
      // Стрим начался: эмбед + пинг роли
      cog._startedAt = status.startedAt || cog._startedAt;
      await cog._ensureSticky(client, status, true);
    } else if (nowLive) {
      // Обновление по ходу стрима: живые зрители/пик
      await cog._ensureSticky(client, status, false);
    } else if (!nowLive && cog._wasLive) {
      // Стрим завершился: превращаем эмбед в итоговый, след. стрим начнёт новое сообщение
      await cog._ensureSticky(
        client,
        { live: false, title: cog._last?.title || "", category: cog._last?.category || "" },
        false
      );
      db.kvDelete(LIVE_MSG_KEY);
      cog._peak = 0;
      cog._startedAt = null;
    }

    if (nowLive) cog._last = status;
    cog._wasLive = nowLive;
    updatePresence(client);
  },

  async _ensureSticky(client, status, withPing) {
    const channelId = liveCfg.channel_id;
    const channel = channelId ? client.channels.cache.get(String(channelId)) : null;
    if (!channel) {
      log.warn("Kick", `Канал для стрим-эмбеда не найден (kick.live.channel_id=${channelId})`);
      return;
    }

    let msg = null;
    const existingId = db.kvGet(LIVE_MSG_KEY);
    if (existingId) {
      try {
        msg = await channel.messages.fetch(existingId);
      } catch {}
    }

    const embed = cog._buildEmbed(status);
    if (msg) {
      await msg.edit({ embeds: [embed] }).catch((e) => log.warn("Kick", `Ошибка edit: ${e.message}`));
      log.info("Kick", `Стрим-эмбед обновлён (${msg.id})`);
      return;
    }

    const pingRole = liveCfg.ping_role_id;
    const content = withPing ? (pingRole ? `<@&${pingRole}>` : "@everyone") : undefined;
    const created = await channel.send({
      content,
      embeds: [embed],
      allowedMentions: content && pingRole ? { roles: [pingRole] } : undefined,
    });
    db.kvSet(LIVE_MSG_KEY, String(created.id));
    log.info("Kick", `Стрим-эмбед размещён в #${channel.name} (${created.id})`);
  },

  _buildEmbed(status) {
    const live = !!(status.isLive ?? status.live);
    if (live) {
      const embed = new EmbedBuilder()
        .setTitle("🔴 Мы в эфире!")
        .setDescription(`**${status.title || "Стрим начался"}**`)
        .setURL(URL)
        .setColor(COLOR)
        .addFields(
          { name: "Категория", value: status.category || "—", inline: true },
          { name: "Зрители", value: fmtNum(status.viewers || 0), inline: true },
          { name: "Пик зрителей", value: fmtNum(cog._peak), inline: true }
        );
      const t = cog._startedAt ? mskTime(cog._startedAt) : "";
      if (t) embed.addFields({ name: "В эфире с", value: t, inline: false });
      if (status.thumbnail) embed.setThumbnail(status.thumbnail);
      return embed;
    }

    const duration = cog._startedAt
      ? durationHMS(Date.now() - new Date(cog._startedAt).getTime())
      : "";
    const embed = new EmbedBuilder()
      .setTitle("⏹ Стрим завершён")
      .setDescription(status.title ? `**${status.title}**` : "Стрим окончен.")
      .setURL(URL)
      .setColor(0x2c2f33)
      .addFields(
        { name: "Категория", value: status.category || "—", inline: true },
        { name: "Пик зрителей", value: fmtNum(cog._peak), inline: true }
      );
    if (duration) embed.addFields({ name: "Длительность", value: duration, inline: false });
    return embed;
  },
};

export default cog;