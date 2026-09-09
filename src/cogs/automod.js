import { CONFIG } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.discord_automod || {};

function matchBannedWord(content, bannedWords) {
  const lower = content.toLowerCase();
  for (const word of bannedWords) {
    if (lower.includes(word.toLowerCase())) return word;
  }
  return null;
}

function normalizedAllowedLinks(config) {
  return (config.allowed_links || []).map((l) => l.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, ""));
}

function checkLinks(content, allowedHosts, blockLinks) {
  if (!blockLinks) return null;
  const urlRe = /https?:\/\/[^\s]+/gi;
  let match;
  while ((match = urlRe.exec(content))) {
    const url = match[0].toLowerCase();
    const hostMatch = url.match(/\/\/(?:www\.)?([^/]+)/);
    if (!hostMatch) continue;
    const host = hostMatch[1];
    if (!allowedHosts.some((a) => host === a || host.endsWith("." + a))) {
      return host;
    }
  }
  return null;
}

function checkCaps(content, threshold, minLen) {
  if (content.length < minLen) return false;
  const alpha = content.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, "");
  if (alpha.length < minLen) return false;
  const upper = alpha.replace(/[^A-ZА-ЯЁ]/g, "").length;
  return upper / alpha.length >= threshold;
}

function checkStretch(content) {
  return /(.)\1{4,}/i.test(content);
}

const cog = {
  name: "DiscordAutomod",
  _messages: new Map(),
  _timeoutCounts: new Map(),
  _banWindow: 300,

  async setup(registry) {
    cog._banWindow = cfg.ban_window_seconds || 300;

    registry.event("messageCreate", async (message) => {
      if (!cfg.enabled) return;
      if (message.author.bot) return;
      if (!message.guild) return;
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      if (!member) return;
      if (cog._hasIgnoredRole(member)) return;
      if (member.permissions.has("ManageMessages")) return;
      const ignoredChannels = new Set(cfg.ignored_channels || []);
      if (ignoredChannels.has(message.channel.id)) return;

      const content = message.content || "";
      const reason = cog._analyze(member, content);
      if (!reason) return;

      try {
        await message.delete();
      } catch {}

      await cog._punish(member, reason);
      log.warn("Automod", `${member.user.tag} в #${message.channel.name}: ${reason}`);
    });
  },

  _hasIgnoredRole(member) {
    const ignored = new Set(cfg.ignore_roles || []);
    return member.roles.cache.some((r) => ignored.has(r.name));
  },

  _analyze(member, content) {
    cog._trackSpam(member);
    if (cog._isSpam(member)) return "спам";

    const word = matchBannedWord(content, cfg.banned_words || []);
    if (word) return `запрещённое слово: «${word}»`;

    if (cfg.block_links) {
      const allowed = normalizedAllowedLinks(cfg);
      const host = checkLinks(content, allowed, true);
      if (host) return `ссылка на неразрешённый домен: ${host}`;
    }

    if (checkCaps(content, cfg.caps_threshold || 0.8, cfg.caps_min_len || 12)) return "капс";

    if (checkStretch(content)) return "растянутый спам";

    return null;
  },

  _trackSpam(member) {
    const now = Date.now() / 1000;
    const window = 5.0;
    let q = cog._messages.get(member.id);
    if (!q) {
      q = [];
      cog._messages.set(member.id, q);
    }
    while (q.length && now - q[0] > window) q.shift();
    q.push(now);
    while (q.length > 20) q.shift();
  },

  _isSpam(member) {
    const maxInWindow = cfg.max_messages_in_window || 5;
    if (maxInWindow <= 0) return false;
    const q = cog._messages.get(member.id) || [];
    const now = Date.now() / 1000;
    const recent = q.filter((ts) => now - ts <= 5.0).length;
    return q.length > maxInWindow || recent > maxInWindow;
  },

  async _punish(member, reason) {
    const duration = cfg.timeout_duration || 300;
    if (duration > 0) {
      try {
        await member.timeout(duration * 1000, `Automod: ${reason}`);
      } catch {}
    }

    const banAfter = cfg.ban_after_timeouts || 0;
    if (banAfter > 0) {
      const now = Date.now() / 1000;
      const window = cog._banWindow;
      let stamps = cog._timeoutCounts.get(member.id);
      if (!stamps) {
        stamps = [];
        cog._timeoutCounts.set(member.id, stamps);
      }
      while (stamps.length && now - stamps[0] > window) stamps.shift();
      stamps.push(now);
      if (stamps.length >= banAfter) {
        try {
          await member.ban({ reason: `Automod: ${banAfter} нарушений за ${window}с` });
          log.warn("Automod", `Бан ${member.user.tag} (${reason})`);
        } catch {}
        stamps.length = 0;
      }
    }
  },
};

export default cog;
