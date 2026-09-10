import { EmbedBuilder } from "discord.js";
import * as db from "../db.js";
import { CONFIG } from "../config.js";
import { setStream, updatePresence, fmtNum } from "../stream_state.js";
import { log } from "../notify.js";

const cfg = CONFIG.twitch || {};
const liveCfg = cfg.live || {};
const CHANNEL = cfg.channel || "dendosicsh";
const CLIENT_ID = cfg.client_id || process.env.TWITCH_CLIENT_ID || "";
const CLIENT_SECRET = cfg.client_secret || process.env.TWITCH_CLIENT_SECRET || "";
const POLL_MS = Math.max(30, liveCfg.poll_interval_seconds || 300) * 1000;
const LIVE_MSG_KEY = "twitch_live_msg";
const GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const URL = `https://www.twitch.tv/${CHANNEL}`;
const COLOR = 0x9146ff;

let oauthToken = "";
let oauthExpires = 0;

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

async function getHelixToken() {
  if (Date.now() < oauthExpires) return oauthToken;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Twitch client_id/client_secret не заданы");
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Twitch oauth ${res.status}`);
  const data = await res.json();
  oauthToken = data.access_token || "";
  oauthExpires = Date.now() + Math.max(60, (data.expires_in || 3600) - 60) * 1000;
  return oauthToken;
}

async function fetchHelixStream() {
  if (!CLIENT_ID) throw new Error("Twitch client_id не задан");
  const token = await getHelixToken();
  const res = await fetch(
    `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(CHANNEL)}`,
    { headers: { "Client-ID": CLIENT_ID, Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Twitch Helix ${res.status}`);
  const data = await res.json();
  const s = data.data?.[0];
  return s && s.type === "live"
    ? {
        live: true,
        viewers: s.viewer_count ?? 0,
        title: s.title || "",
        category: s.game_name || "",
        thumbnail: (s.thumbnail_url || "").replace("{width}x{height}", "320x180"),
        startedAt: s.started_at || null,
      }
    : { live: false };
}

async function fetchGqlStream() {
  const res = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Id": GQL_CLIENT_ID },
    body: JSON.stringify([
      {
        query:
          "query Stream($login: String!) { user(login: $login) { stream { id title viewersCount createdAt game { name } previewImageURL } } }",
        variables: { login: CHANNEL },
      },
    ]),
  });
  if (!res.ok) throw new Error(`Twitch GQL ${res.status}`);
  const data = await res.json();
  const s = data?.[0]?.data?.user?.stream;
  return s
    ? {
        live: true,
        viewers: s.viewersCount ?? 0,
        title: s.title || "",
        category: s.game?.name || "",
        thumbnail: s.previewImageURL || "",
        startedAt: s.createdAt || null,
      }
    : { live: false };
}

async function fetchStatus() {
  try {
    return await fetchHelixStream();
  } catch (eHelix) {
    // fallback на анонимный GraphQL (для случаев без client_id)
    return await fetchGqlStream();
  }
}

const cog = {
  name: "Twitch",
  _wasLive: null,
  _timer: null,
  _startedAt: null,
  _peak: 0,
  _last: null,

  async setup(registry) {
    if (!cfg.enabled) {
      log.info("Twitch", "Twitch-модуль отключён в конфиге (twitch.enabled=false)");
      return;
    }

    registry.event("clientReady", async (client) => {
      if (cog._timer) return;
      const run = () => cog._check(client);
      run().catch((e) => log.error("Twitch", `Ошибка first poll: ${e.message}`, e));
      cog._timer = setInterval(run, POLL_MS);
      log.info("Twitch", `Следим за стримом twitch.tv/${CHANNEL} (${POLL_MS / 1000}с)`);
    });

    registry.slash({
      name: "twitch_status",
      description: "Текущий статус стрима на Twitch",
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
          .setTitle(status.live ? "🔴 Стрим идёт!" : "⚫ Стрим офлайн")
          .setDescription(status.live ? `**${status.title || "Без названия"}**` : "Стример сейчас не в эфире.")
          .setColor(status.live ? COLOR : 0x2c2f33)
          .setURL(URL);
        if (status.live) {
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
    if (!cfg.enabled) return;
    let status;
    try {
      status = await fetchStatus();
    } catch (e) {
      log.warn("Twitch", `Ошибка запроса статуса: ${e.message}`);
      return;
    }

    setStream("twitch", status);
    const nowLive = status.live;
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
      log.warn("Twitch", `Канал для стрим-эмбеда не найден (twitch.live.channel_id=${channelId})`);
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
      await msg.edit({ embeds: [embed] }).catch((e) => log.warn("Twitch", `Ошибка edit: ${e.message}`));
      log.info("Twitch", `Стрим-эмбед обновлён (${msg.id})`);
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
    log.info("Twitch", `Стрим-эмбед размещён в #${channel.name} (${created.id})`);
  },

  _buildEmbed(status) {
    const live = !!status.live;
    if (live) {
      const embed = new EmbedBuilder()
        .setTitle("🔴 Мы в эфире на Twitch!")
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