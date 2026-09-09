import { EmbedBuilder } from "discord.js";
import { CONFIG } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.youtube || {};
const API_KEY = cfg.api_key || process.env.YOUTUBE_API_KEY || "";
const API_BASE = "https://www.googleapis.com/youtube/v3";
const CHANNEL_HANDLE = cfg.channel || "Dendosich";

let bot = null;
let started = false;
let videoTimer = null;
let knownVideoIds = new Set();
let seeded = false;

function fmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

async function ytFetch(endpoint, params = {}) {
  if (!API_KEY) throw new Error("YouTube API key не задан (YOUTUBE_API_KEY)");
  const qs = new URLSearchParams({ ...params, key: API_KEY });
  const res = await fetch(`${API_BASE}${endpoint}?${qs}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || "";
    } catch {}
    throw new Error(`YouTube API ${res.status}: ${detail}`);
  }
  return res.json();
}

async function resolveChannelId(handle) {
  const data = await ytFetch("/channels", { part: "id", forHandle: handle });
  return data.items?.[0]?.id || null;
}

async function recentVideos(channelId, max = 10) {
  const data = await ytFetch("/search", {
    part: "id,snippet",
    channelId,
    order: "date",
    maxResults: max,
    type: "video",
  });
  return data.items || [];
}

async function checkNewVideos() {
  try {
    const channelId = await resolveChannelId(CHANNEL_HANDLE);
    if (!channelId) return;
    const videos = await recentVideos(channelId, 10);
    const notifyId = cfg.notify_channel_id;

    for (const video of videos) {
      const vid = video?.id?.videoId;
      const snippet = video?.snippet || {};
      if (!vid || snippet.liveBroadcastContent === "live") continue;

      if (!seeded) {
        knownVideoIds.add(vid);
        continue;
      }
      if (knownVideoIds.has(vid)) continue;
      knownVideoIds.add(vid);
      if (knownVideoIds.size > 200) {
        knownVideoIds.delete(knownVideoIds.values().next().value);
      }

      if (notifyId && knownVideoIds.size > 1) {
        const ch = bot.channels.cache.get(String(notifyId));
        if (!ch) continue;
        const embed = new EmbedBuilder()
          .setTitle(`📹 Новое видео: ${snippet.title || "?"}`)
          .setURL(`https://www.youtube.com/watch?v=${vid}`)
          .setColor(0xff0000);
        const thumb = snippet.thumbnails?.high?.url;
        if (thumb) embed.setThumbnail(thumb);
        try {
          await ch.send({ embeds: [embed] });
        } catch (e) {
          log.warn("YouTube", `Ошибка отправки уведомления о видео: ${e.message}`);
        }
      }
    }

    if (!seeded) {
      seeded = true;
      log.info("YouTube", `Инициализировано ${knownVideoIds.size} известных видео`);
    }
  } catch (e) {
    log.warn("YouTube", `Ошибка проверки новых видео: ${e.message}`);
  }
}

function startVideoLoop() {
  videoTimer = setInterval(() => {
    checkNewVideos().catch((e) => log.error("YouTube", `Ошибка проверки видео: ${e.message}`, e));
  }, Math.max(60, cfg.check_seconds || 300) * 1000);
}

async function ytStats(interaction) {
  await interaction.defer();
  if (cfg.enabled === false) {
    await interaction.editReply({ content: "YouTube-модуль отключён (youtube.enabled=false)." });
    return;
  }
  if (!API_KEY) {
    await interaction.editReply({ content: "YouTube-модуль отключён: не задан API ключ." });
    return;
  }

  let item;
  try {
    const channelId = await resolveChannelId(CHANNEL_HANDLE);
    if (!channelId) {
      await interaction.editReply({ content: "Канал не найден." });
      return;
    }
    const data = await ytFetch("/channels", { part: "snippet,statistics", id: channelId });
    item = data.items?.[0];
  } catch (e) {
    await interaction.editReply({ content: `Ошибка: ${e.message}` });
    return;
  }
  if (!item) {
    await interaction.editReply({ content: "Канал не найден." });
    return;
  }

  const snippet = item.snippet || {};
  const stats = item.statistics || {};
  const title = snippet.title || CHANNEL_HANDLE;
  const description = (snippet.description || "").slice(0, 200);
  const subs = Number(stats.subscriberCount || 0);
  const views = Number(stats.viewCount || 0);
  const videosCount = Number(stats.videoCount || 0);

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${title}`)
    .setDescription(description || "Нет описания")
    .setURL(`https://www.youtube.com/@${CHANNEL_HANDLE}`)
    .setColor(0xff0000)
    .addFields(
      { name: "Подписчики", value: fmtNum(subs), inline: true },
      { name: "Просмотры", value: fmtNum(views), inline: true },
      { name: "Видео", value: String(videosCount), inline: true }
    );
  const thumb = snippet.thumbnails?.high?.url;
  if (thumb) embed.setThumbnail(thumb);

  try {
    const videos = await recentVideos(item.id, 3);
    if (videos.length) {
      const lines = [];
      for (const v of videos) {
        const sn = v.snippet || {};
        if (sn.title) lines.push(`**${sn.title.slice(0, 40)}**\n<https://www.youtube.com/watch?v=${v.id?.videoId}>`);
      }
      if (lines.length) {
        embed.addFields({ name: "Последние видео", value: lines.join("\n\n"), inline: false });
      }
    }
  } catch {}

  const msk = new Date(Date.now() + 3 * 3600 * 1000);
  embed.setFooter({ text: `Обновлено ${msk.toISOString().slice(11, 19)} МСК` });
  await interaction.editReply({ embeds: [embed] });
}

function disabledReply(interaction) {
  return interaction.reply({
    content: "YouTube-модуль отключён (youtube.enabled=false).",
    ephemeral: true,
  });
}

const cog = {
  name: "YouTube",
  async setup(registry) {
    bot = registry.client;

    registry.slash({
      name: "yt_stats",
      description: "Статистика YouTube канала",
      guildOnly: true,
      options: [],
      async run(interaction) {
        if (cfg.enabled === false) return disabledReply(interaction);
        return ytStats(interaction);
      },
    });

    registry.event("clientReady", async () => {
      if (started) return;
      started = true;
      if (cfg.enabled === false) {
        log.info("YouTube", "YouTube-модуль отключён (youtube.enabled=false)");
        return;
      }
      if (!API_KEY) {
        log.error("YouTube", "Включён, но не задан YOUTUBE_API_KEY — цикл проверки видео не запущен");
        return;
      }
      await checkNewVideos().catch(() => {});
      startVideoLoop();
      log.info("YouTube", `YouTube-модуль запущен: @${CHANNEL_HANDLE}`);
    });
  },
};

export default cog;