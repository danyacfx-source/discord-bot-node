import { PermissionFlagsBits } from "discord.js";
import { CONFIG, GUILD_ID } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.permissions || {};
const categories = cfg.categories || {};
const autoApply = cfg.auto_apply !== false;

function resolveRole(guild, name) {
  if (name === "@everyone") return guild.roles.everyone;
  return guild.roles.cache.find((r) => r.name === name) || null;
}

async function applyCategory(guild, catId, spec) {
  const category = guild.channels.cache.get(String(catId));
  if (!category || category.type !== 4) {
    return `❌ Категория ${catId} не найдена`;
  }
  try {
    for (const rule of spec.rules || []) {
      const role = resolveRole(guild, rule.role);
      if (!role) {
        return `❌ ${category.name}: роль «${rule.role}» не найдена`;
      }
      const perms = {};
      for (const [k, v] of Object.entries(rule)) {
        if (k === "role" || v == null) continue;
        perms[k] = !!v;
      }
      await category.permissionOverwrites.edit(role, perms, { reason: "Права категорий из конфига" });
    }
    return `✅ ${category.name}`;
  } catch (e) {
    if (e.httpStatus === 403) return `⛔ ${category.name}: у бота нет прав`;
    return `❌ ${category.name}: ${e.message}`;
  }
}

async function applyAll(guild) {
  const lines = [];
  for (const [catId, spec] of Object.entries(categories)) {
    lines.push(await applyCategory(guild, catId, spec));
  }
  return lines;
}

const cog = {
  name: "Permissions",
  async setup(registry) {
    registry.event("clientReady", async () => {
      if (!autoApply || !Object.keys(categories).length || !GUILD_ID) return;
      const guild = registry.client.guilds.cache.get(String(GUILD_ID));
      if (!guild) return;
      const lines = await applyAll(guild);
      for (const line of lines) {
        log.info("Permissions", `Права категорий ${guild.name}: ${line}`);
      }
    });

    registry.slash({
      name: "apply_permissions",
      description: "Применить права категорий из конфига",
      guildOnly: true,
      options: [],
      async run(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const lines = await applyAll(interaction.guild);
        await interaction.editReply({
          content: "**Права категорий:**\n" + lines.join("\n"),
        });
      },
    });
  },
};

export default cog;
