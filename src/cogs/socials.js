import { EmbedBuilder } from "discord.js";
import { CONFIG } from "../config.js";

const DEFAULT_LINKS = {
  discord: "https://discord.gg/rEDcPBuk6c",
  site: "https://danyacfx-source.github.io/dendich/",
  youtube: "https://www.youtube.com/@Dendosich",
  donate: "https://donatty.com/dendich",
};

const ICONS = {
  discord: "💬",
  site: "🌐",
  youtube: "▶️",
  donate: "💝",
  twitch: "🎥",
  kick: "🎥",
};

const cog = {
  name: "Socials",

  async setup(registry) {
    registry.slash({
      name: "socials",
      description: "Все полезные ссылки",
      guildOnly: true,
      async run(interaction) {
        const socialsCfg = CONFIG.socials || {};
        const links = { ...DEFAULT_LINKS };
        for (const [k, v] of Object.entries(socialsCfg)) {
          if (typeof v === "string" && v) links[k] = v;
        }
        const embed = new EmbedBuilder()
          .setTitle("🔗 Наши ссылки")
          .setDescription("Подписывайся и приходи на стримы!")
          .setColor(0x2ecc71);
        for (const [key, url] of Object.entries(links)) {
          if (!url || !url.startsWith("http://") && !url.startsWith("https://")) continue;
          const icon = ICONS[key] || "•";
          embed.addFields({ name: `${icon} ${key.charAt(0).toUpperCase() + key.slice(1)}`, value: url, inline: false });
        }
        await interaction.reply({ embeds: [embed] });
      },
    });
  },
};

export default cog;
