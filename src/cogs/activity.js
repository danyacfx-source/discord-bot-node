import { ChannelType } from "discord.js";
import * as db from "../db.js";
import { EXCLUDE_ROLES, WHITELIST_CHANNELS } from "../config.js";
import { log } from "../notify.js";

const VOICE_INTERVAL_MINUTES = 5;
let timerId = null;

const cog = {
  name: "Activity",
  async setup(registry) {
    registry.event("messageCreate", async (message) => {
      if (message.author.bot) return;
      if (!message.guild) return;
      // handle threads: use parentId for whitelist check
      const chanId = message.channel?.id;
      const parentId = message.channel?.isThread?.() ? message.channel.parentId : null;
      if (WHITELIST_CHANNELS.size > 0 && !WHITELIST_CHANNELS.has(chanId) && !(parentId && WHITELIST_CHANNELS.has(parentId))) return;
      // message.member may be null (uncached) — fallback to guild members cache
      let member = message.member;
      if (!member) {
        try { member = await message.guild.members.fetch(message.author.id).catch(() => null); } catch { member = null; }
        if (!member) member = message.guild.members.cache.get(String(message.author.id)) || null;
      }
      if (EXCLUDE_ROLES.size > 0 && member && member.roles.cache.some((r) => EXCLUDE_ROLES.has(r.name))) return;
      db.seasonAddMessage(message.guild.id, message.author.id);
    });

    registry.event("clientReady", async () => {
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
      const client = registry.client;
      timerId = setInterval(async () => {
        for (const guild of client.guilds.cache.values()) {
          try {
            if (guild.channels.cache.size < 5) await guild.channels.fetch().catch(() => {});
          } catch {}
          const membersToCredit = [];
          for (const channel of guild.channels.cache.values()) {
            if (channel.type !== ChannelType.GuildVoice) continue;
            for (const member of channel.members.values()) {
              if (member.user.bot) continue;
              membersToCredit.push(member.id);
            }
          }
          if (!membersToCredit.length) continue;
          // батч в транзакции чтобы снизить нагрузку SQLite (ранее 1000 отдельных INSERT)
          try {
            if (typeof db.seasonAddMessagesBatch === "function") {
              db.seasonAddMessagesBatch(guild.id, membersToCredit);
            } else {
              for (const uid of membersToCredit) {
                try { db.seasonAddMessage(guild.id, uid); } catch {}
              }
            }
          } catch {}
        }
      }, VOICE_INTERVAL_MINUTES * 60000);
      if (timerId.unref) timerId.unref();
      log.info("Activity", `Сезонная активность: сообщения + голос каждые ${VOICE_INTERVAL_MINUTES} мин`);
    });
  },
};

export default cog;