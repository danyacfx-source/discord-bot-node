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
      if (WHITELIST_CHANNELS.size > 0 && !WHITELIST_CHANNELS.has(message.channel.id)) return;
      if (EXCLUDE_ROLES.size > 0 && message.member.roles.cache.some((r) => EXCLUDE_ROLES.has(r.name))) return;
      db.seasonAddMessage(message.guild.id, message.author.id);
    });

    registry.event("clientReady", async () => {
      if (timerId) return;
      const client = registry.client;
      timerId = setInterval(() => {
        for (const guild of client.guilds.cache.values()) {
          for (const channel of guild.channels.cache.values()) {
            if (channel.type !== ChannelType.GuildVoice) continue;
            for (const member of channel.members.values()) {
              if (member.user.bot) continue;
              db.seasonAddMessage(guild.id, member.id);
            }
          }
        }
      }, VOICE_INTERVAL_MINUTES * 60000);
      log.info("Activity", `Сезонная активность: сообщения + голос каждые ${VOICE_INTERVAL_MINUTES} мин`);
    });
  },
};

export default cog;