import { ChannelType } from "discord.js";
import * as db from "../db.js";
import { CONFIG, LEVELS } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.voice_xp || {};
let bot = null;
let started = false;
let intervalId = null;

function roleForLevel(guild, levelIdx) {
  if (levelIdx < 0) return null;
  const name = LEVELS[levelIdx]?.role_name;
  if (!name) return null;
  return guild.roles.cache.find((r) => r.name === name) || null;
}

async function ensureLevelRole(member, points) {
  try {
    const idx = db.levelIndexFor(points);
    if (idx < 0) return;
    const target = roleForLevel(member.guild, idx);
    if (!target) return;
    if (member.roles.cache.has(target.id)) return;
    for (let i = 0; i < idx; i++) {
      const lower = roleForLevel(member.guild, i);
      if (lower && member.roles.cache.has(lower.id) && lower.id !== target.id) {
        await member.roles.remove(lower, "VoiceXP: повышение уровня");
      }
    }
    await member.roles.add(target, "VoiceXP: начисление за голос");
  } catch (e) {
    log.warn("VoiceXP", `Ошибка обновления роли уровня для ${member.user?.tag || member.id}: ${e.message}`);
  }
}

async function award() {
  const skipMuted = cfg.skip_muted === true;
  for (const guild of bot.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildVoice) continue;
      for (const member of channel.members.values()) {
        if (member.user.bot) continue;
        if (skipMuted) {
          const voice = member.voice;
          if (voice && (voice.selfMute || voice.selfDeaf)) continue;
        }
        const { points } = db.addMessage(guild.id, member.id);
        db.seasonAddMessage(guild.id, member.id);
        await ensureLevelRole(member, points);
      }
    }
  }
}

const cog = {
  name: "VoiceXP",
  async setup(registry) {
    bot = registry.client;

    registry.event("clientReady", async () => {
      if (started) return;
      started = true;
      if (cfg.enabled === false) return;
      const intervalMinutes = Math.max(3, Math.min(60, cfg.interval_minutes || 5));
      intervalId = setInterval(() => {
        award().catch((e) => log.error("VoiceXP", `Ошибка начисления очков: ${e.message}`, e));
      }, intervalMinutes * 60000);
      log.info("VoiceXP", "Награды за голосовые запущены");
    });
  },
};

export default cog;