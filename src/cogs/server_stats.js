import { CONFIG } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.server_stats || {};

const cog = {
  name: "ServerStats",
  _started: false,
  _interval: null,

  async setup(registry) {
    registry.event("clientReady", async (client) => {
      if (cog._started) return;
      cog._started = true;
      if (!cfg.enabled) return;

      const interval = Math.max(60, cfg.update_seconds || 300) * 1000;

      async function update() {
        for (const [, guild] of client.guilds.cache) {
          try {
            await cog._updateGuild(guild);
          } catch (e) {
            log.warn("ServerStats", `Не удалось обновить счётчики сервера ${guild.name}`);
          }
        }
      }

      await update();
      cog._interval = setInterval(() => {
        update().catch(() => {});
      }, interval);
    });
  },

  async _updateGuild(guild) {
    const channelsCfg = cfg.channels || [];
    if (!channelsCfg.length) return;
    const categoryName = cfg.category || "СТАТИСТИКА";
    let category = guild.channels.cache.find(
      (ch) => ch.type === 4 && ch.name === categoryName
    );
    if (!category) {
      try {
        category = await guild.channels.create({
          name: categoryName,
          type: 4,
          reason: "Счётчики сервера",
        });
      } catch {
        log.warn("ServerStats", `Нет прав создать категорию «${categoryName}» в ${guild.name}`);
        return;
      }
    }

    let members = 0;
    let online = 0;
    try {
      await guild.members.fetch();
    } catch {}
    for (const [, m] of guild.members.cache) {
      if (m.user.bot) continue;
      members++;
      if (m.presence && m.presence.status !== "offline") online++;
    }

    for (const spec of channelsCfg) {
      const kind = spec.type || "members";
      const value = kind === "online" ? online : members;
      const emoji = spec.emoji || "";
      const rawName = emoji ? `${emoji} ${value}` : String(value);
      const name = rawName.slice(0, 100);

      let channel;
      if (emoji) {
        channel = category.children.cache.find(
          (ch) => ch.type === 2 && ch.name.startsWith(emoji)
        );
      } else {
        channel = category.children.cache.find(
          (ch) => ch.type === 2 && ch.name === name
        );
      }

      if (!channel) {
        try {
          await guild.channels.create({
            name,
            type: 2,
            parent: category.id,
            reason: "Счётчик сервера",
          });
        } catch {
          log.warn("ServerStats", `Нет прав создать канал счётчика в ${guild.name}`);
        }
        continue;
      }

      if (channel.name !== name) {
        try {
          await channel.setName(name, "Обновление счётчика сервера");
        } catch {
          log.warn("ServerStats", `Нет прав переименовать канал в ${guild.name}`);
        }
      }
    }
  },
};

export default cog;
