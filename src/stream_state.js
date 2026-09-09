import { CONFIG } from "./config.js";

export const CHANNELS = {
  twitch: CONFIG.twitch?.channel || CONFIG.socials?.twitch?.replace("https://www.twitch.tv/", "") || "",
  kick: (CONFIG.kick || {}).channel || "",
};

export const streams = {
  twitch: {
    platform: "twitch",
    live: false,
    viewers: 0,
    peak: 0,
    title: "",
    category: "",
    thumbnail: "",
    startedAt: null,
    url: CHANNELS.twitch ? `https://www.twitch.tv/${CHANNELS.twitch}` : "",
  },
  kick: {
    platform: "kick",
    live: false,
    viewers: 0,
    peak: 0,
    title: "",
    category: "",
    thumbnail: "",
    startedAt: null,
    url: CHANNELS.kick ? `https://kick.com/${CHANNELS.kick}` : "",
  },
};

export function setStream(platform, data) {
  const s = streams[platform];
  if (!s) return;
  s.live = !!data.live;
  s.viewers = data.viewers || 0;
  s.title = data.title || "";
  s.category = data.category || "";
  s.thumbnail = data.thumbnail || "";
  s.startedAt = data.startedAt || null;
  s.peak = s.live ? Math.max(s.peak, s.viewers) : 0;
  s.updatedAt = Date.now();
}

/** Активный стрим: live если есть, иначе тот, что хотя бы опрашивается */
export function activeStream() {
  if (streams.twitch.live) return streams.twitch;
  if (streams.kick.live) return streams.kick;
  return streams.kick.url ? streams.kick : null;
}

export function fmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export async function updatePresence(client) {
  if (!client?.user) return;
  const live = activeStream();
  const watching = live?.live
    ? `🔴 ${live.title || live.platform} · ${fmtNum(live.viewers)} зрит.`
    : "🔴 стрим офлайн";
  try {
    await client.user.setActivity({ name: watching, type: 3 });
  } catch {}
}