import { CONFIG } from "../config.js";
import { log } from "../notify.js";

const cog = {
  name: "Kick",
  async setup(registry) {
    const kickCfg = CONFIG.kick || {};
    if (!kickCfg.enabled) {
      log.info("Kick", "Kick-модуль отключён в конфиге (kick.enabled=false)");
      return;
    }

    const liveCfg = { ...(kickCfg.live || {}) };
    liveCfg.channel = liveCfg.channel || kickCfg.channel || "dendosich";

    // Kick API интеграция недоступна в Node.js без внешнего модуля — заглушка.
    log.info("Kick", "Kick-модуль загружен (API-интеграция требует внешнего модуля)");

    registry.slash({
      name: "kick_status",
      description: "Текущий статус стрима на Kick",
      guildOnly: false,
      options: [],
      async run(interaction) {
        await interaction.reply({
          content: "Kick-модуль загружен, но внешний API-клиент не подключён.",
          ephemeral: true,
        });
      },
    });
  },
};

export default cog;
