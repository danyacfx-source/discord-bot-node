import fs from "node:fs";
import path from "node:path";
import { EmbedBuilder } from "discord.js";
import { CONFIG, DATA_DIR } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.youtube || {};
const API_KEY = cfg.api_key || process.env.YOUTUBE_API_KEY || "";
const API_BASE = "https://www.googleapis.com/youtube/v3";
const CHANNEL_HANDLE = cfg.channel || "Dendosich";
const STATE_FILE = path.join(DATA_DIR, "youtube_growth_state.json");

let bot = null;
let started = false;
let loopTimer = null;
let state = loadState();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf-8");
  } catch {}
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

function parseDurationSeconds(duration) {
  let total = 0;
  const mh = /(\d+)H/.exec(duration);
  const mm = /(\d+)M/.exec(duration);
  const ms = /(\d+)S/.exec(duration);
  if (mh) total += Number(mh[1]) * 3600;
  if (mm) total += Number(mm[1]) * 60;
  if (ms) total += Number(ms[1]);
  return total;
}

function notifyChannel() {
  const id = cfg.notify_channel_id;
  if (!id) return null;
  return bot.channels.cache.get(id) || null;
}

async function checkShorts() {
  const channelId = await resolveChannelId(CHANNEL_HANDLE);
  if (!channelId) return;
  const data = await ytFetch("/search", {
    part: "id,snippet",
    channelId,
    order: "date",
    maxResults: 10,
    type: "video",
  });
  const ch = notifyChannel();
  if (!ch) return;

  for (const item of data.items || []) {
    const vid = item?.id?.videoId;
    if (!vid || (state.known_shorts || []).includes(vid)) continue;
    const vidData = await ytFetch("/videos", { part: "contentDetails,snippet", id: vid });
    const v = vidData.items?.[0];
    if (!v) continue;
    const duration = v.contentDetails?.duration || "";
    const snippet = v.snippet || {};
    if (!(duration.includes("PT") && parseDurationSeconds(duration) <= 60)) continue;

    state.known_shorts = [...(state.known_shorts || []), vid].slice(-200);
    const embed = new EmbedBuilder()
      .setTitle(`📱 Новый YouTube Short: ${snippet.title || "?"}`)
      .setURL(`https://www.youtube.com/shorts/${vid}`)
      .setColor(0xff0000);
    const thumb = snippet.thumbnails?.high?.url;
    if (thumb) embed.setThumbnail(thumb);
    embed.setFooter({ text: "YouTube Shorts" });
    try {
      await ch.send({ embeds: [embed] });
    } catch (e) {
      log.warn("YouTubeGrowth", `Ошибка публикации Short: ${e.message}`);
    }
  }
  saveState();
}

async function checkPremieres() {
  const channelId = await resolveChannelId(CHANNEL_HANDLE);
  if (!channelId) return;
  const data = await ytFetch("/search", {
    part: "id,snippet",
    channelId,
    order: "date",
    maxResults: 5,
    type: "video",
    eventType: "upcoming",
  });
  const ch = notifyChannel();
  if (!ch) return;

  for (const item of data.items || []) {
    const vid = item?.id?.videoId;
    const snippet = item?.snippet || {};
    if (!vid) continue;
    const key = `premiere:${vid}`;
    if (state[key]) continue;
    state[key] = true;
    const embed = new EmbedBuilder()
      .setTitle(`🎬 Премьера: ${snippet.title || "?"}`)
      .setDescription("Скоро на YouTube! Не пропусти.")
      .setURL(`https://www.youtube.com/watch?v=${vid}`)
      .setColor(0xff0000);
    if (snippet.publishedAt) {
      const ts = Date.parse(snippet.publishedAt);
      if (!Number.isNaN(ts)) {
        embed.addFields({ name: "Старт", value: `<t:${Math.floor(ts / 1000)}:R>` });
      }
    }
    embed.setFooter({ text: "Добавь в календарь!" });
    try {
      await ch.send({ embeds: [embed] });
    } catch (e) {
      log.warn("YouTubeGrowth", `Ошибка публикации премьеры: ${e.message}`);
    }
  }
  saveState();
}

async function postAnalytics() {
  const now = Date.now();
  if (now - (state.last_analytics_post || 0) < 7 * 86400000) return;
  const channelId = await resolveChannelId(CHANNEL_HANDLE);
  if (!channelId) return;
  const data = await ytFetch("/channels", { part: "statistics,snippet", id: channelId });
  const item = data.items?.[0];
  if (!item) return;
  const channel = notifyChannel();
  if (!channel) return;

  const stats = item.statistics || {};
  const snippet = item.snippet || {};
  const subs = Number(stats.subscriberCount || 0);
  const views = Number(stats.viewCount || 0);
  const videos = Number(stats.videoCount || 0);

  const embed = new EmbedBuilder()
    .setTitle(`📈 YouTube аналитика: ${snippet.title || "?"}`)
    .setColor(0xff0000)
    .addFields(
      { name: "Подписчики", value: String(subs).replace(/\B(?=(\d{3})+(?!\d))/g, " "), inline: true },
      { name: "Просмотры", value: String(views).replace(/\B(?=(\d{3})+(?!\d))/g, " "), inline: true },
      { name: "Видео", value: String(videos), inline: true }
    );

  try {
    const search = await ytFetch("/search", {
      part: "id,snippet",
      channelId,
      order: "date",
      maxResults: 5,
      type: "video",
    });
    const ids = (search.items || [])
      .map((v) => v?.id?.videoId)
      .filter(Boolean)
      .slice(0, 5);
    if (ids.length) {
      const vidData = await ytFetch("/videos", { part: "statistics,snippet", id: ids.join(",") });
      const lines = (vidData.items || []).map((v) => {
        const s = v.statistics || {};
        const n = (v.snippet?.title || "?").slice(0, 40);
        const vc = Number(s.viewCount || 0);
        const lk = Number(s.likeCount || 0);
        return `**${n}** — 👁 ${String(vc).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} · 👍 ${String(lk).replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`;
      });
      if (lines.length) {
        embed.addFields({ name: "Последние видео", value: lines.join("\n"), inline: false });
      }
    }
  } catch {}

  const msk = new Date(Date.now() + 3 * 3600 * 1000);
  embed.setFooter({ text: `Обновлено ${msk.toISOString().slice(0, 16).replace("T", " ")} МСК` });

  try {
    await channel.send({ embeds: [embed] });
    state.last_analytics_post = now;
    saveState();
  } catch (e) {
    log.warn("YouTubeGrowth", `Ошибка публикации аналитики: ${e.message}`);
  }
}

async function growthLoop() {
  const interval = Math.max(60, cfg.growth_check_seconds || 600) * 1000;
  await new Promise((resolve) => setTimeout(resolve, 30000));
  while (true) {
    try {
      await checkShorts();
      await new Promise((resolve) => setTimeout(resolve, 10000));
      await checkPremieres();
      await new Promise((resolve) => setTimeout(resolve, 10000));
      await postAnalytics();
    } catch (e) {
      log.error("YouTubeGrowth", `Ошибка цикла: ${e.message}`, e);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function statusReply(interaction, extra) {
  return interaction.reply({
    content: extra || "YouTubeGrowth: модуль отключён (youtube.enabled=false).",
    ephemeral: true,
  });
}

const cog = {
  name: "YouTubeGrowth",
  async setup(registry) {
    bot = registry.client;

    registry.slash({
      name: "yt_growth",
      description: "Статус YouTube-Growth модуля",
      guildOnly: true,
      options: [],
      async run(interaction) {
        if (cfg.enabled === false) {
          return statusReply(interaction, "YouTubeGrowth: модуль отключён (youtube.enabled=false).");
        }
        if (!API_KEY) {
          return statusReply(interaction, "YouTubeGrowth: отключён — не задан YOUTUBE_API_KEY.");
        }
        const knownShorts = (state.known_shorts || []).length;
        return interactWithStatus(interaction, knownShorts);
      },
    });

    registry.event("ready", async () => {
      if (started) return;
      started = true;
      if (cfg.enabled === false) {
        log.info("YouTubeGrowth", "Модуль отключён (youtube.enabled=false)");
        return;
      }
      if (!API_KEY) {
        log.error("YouTubeGrowth", "Включён, но не задан YOUTUBE_API_KEY — циклы не запущены");
        return;
      }
      void growthLoop().catch((e) => log.error("YouTubeGrowth", `Ошибка цикла: ${e.message}`, e));
      log.info("YouTubeGrowth", `Модуль запущен: @${CHANNEL_HANDLE}`);
    });
  },
};

async function interactWithStatus(interaction, knownShorts) {
  const embed = new EmbedBuilder()
    .setTitle("📈 YouTube Growth")
    .setDescription(
      `Модуль работает в режиме **API-ключа** (только чтение).\n` +
        `Канал: @${CHANNEL_HANDLE}\n` +
        `Известно Shorts: ${knownShorts}\n` +
        `Функции: уведомления о Shorts, премьеры, еженедельная аналитика.`
    )
    .setColor(0xff0000);
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

export default cog;