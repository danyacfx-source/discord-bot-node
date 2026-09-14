import { CONFIG } from "./config.js";

function extractTwitchChannel(val) {
  if (!val) return "";
  const s = String(val).trim();
  // handle full URL or handle
  const m = s.match(/twitch\.tv\/([^/?#\s]+)/i);
  if (m) return m[1];
  return s.replace(/^@/, "");
}
export const CHANNELS = {
  twitch: CONFIG.twitch?.channel || extractTwitchChannel(CONFIG.socials?.twitch) || "",
  kick: (CONFIG.kick || {}).channel || (CONFIG.kick?.live?.channel ? String(CONFIG.kick.live.channel) : "") || "",
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

let _setStreamLock = Promise.resolve();
export function setStream(platform, data) {
  const s = streams[platform];
  if (!s) return;
  // serialize to avoid race where two polls interleave; surface errors via console
  const task = () => {
    s.live = !!data.live;
    s.viewers = Number.isFinite(data.viewers) ? data.viewers : 0;
    s.title = String(data.title || "").slice(0, 300);
    s.category = String(data.category || "").slice(0, 100);
    s.thumbnail = String(data.thumbnail || "").slice(0, 500);
    s.startedAt = data.startedAt || null;
    s.peak = s.live ? Math.max(s.peak, s.viewers) : 0;
    s.updatedAt = Date.now();
  };
  _setStreamLock = _setStreamLock.then(task).catch((e) => {
    console.error(`setStream ${platform} failed:`, e);
    // reset lock chain so next call isn't blocked
  });
  return _setStreamLock;
}

/** Активный стрим: приоритет live, если оба live — выбираем по viewers, tie по peak */
export function activeStream() {
  const t = streams.twitch, k = streams.kick;
  if (t.live && k.live) {
    if (t.viewers !== k.viewers) return t.viewers > k.viewers ? t : k;
    return t.peak >= k.peak ? t : k;
  }
  if (t.live) return t;
  if (k.live) return k;
  // если никто не live — возвращаем null чтобы presence показал офлайн, иначе last active
  if (k.url || t.url) {
    if (k.updatedAt && t.updatedAt) return k.updatedAt > t.updatedAt ? k : t;
    return k.url ? k : (t.url ? t : null);
  }
  return null;
}

export function fmtNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export async function updatePresence(client) {
  if (!client?.user) return;
  const live = activeStream();
  if (live?.live) {
    const title = String(live.title || live.platform).slice(0, 80);
    const watching = `🔴 ${title} · ${fmtNum(live.viewers)} зрит.`.slice(0, 128);
    try {
      await client.user.setPresence({ activities: [{ name: watching, type: 3 }], status: "online" });
    } catch {}
  } else {
    try {
      // No activity when offline — show idle without watching text
      await client.user.setPresence({ activities: [], status: "idle" });
    } catch {}
  }
}