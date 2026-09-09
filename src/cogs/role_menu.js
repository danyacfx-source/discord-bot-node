import {
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
} from "discord.js";
import { CONFIG } from "../config.js";
import { log } from "../notify.js";

const PANEL_FOOTER = "Роли через меню выбора";
const cfg = CONFIG.role_menu || {};

function buildRows(roleNames, maxValues) {
  const maxV = Math.min(Math.max(1, maxValues || 10), roleNames.length);
  const options = roleNames.map((name) =>
    new StringSelectMenuOptionBuilder().setLabel(name).setValue(name).setDescription(`Роль «${name}»`)
  );
  const addRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("role_menu_add")
      .setPlaceholder("Получить роль…")
      .setMinValues(0)
      .setMaxValues(maxV)
      .addOptions(options)
  );
  const removeRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("role_menu_remove")
      .setPlaceholder("Снять роль…")
      .setMinValues(0)
      .setMaxValues(maxV)
      .addOptions(options)
  );
  return [addRow, removeRow];
}

async function applyRoles(interaction, add) {
  const selected = interaction.values || [];
  const member = interaction.member;
  const guild = interaction.guild;
  let changes = 0;
  for (const name of selected) {
    const role = guild.roles.cache.find((r) => r.name === name);
    if (!role) continue;
    try {
      if (add && !member.roles.cache.has(role.id)) {
        await member.roles.add(role, "Выбор роли в меню");
        changes++;
      } else if (!add && member.roles.cache.has(role.id)) {
        await member.roles.remove(role, "Снятие роли в меню");
        changes++;
      }
    } catch (e) {
      log.warn("RoleMenu", `Нет прав изменить роль ${role.name} у ${member.id}`);
    }
  }
  const verb = add ? "добавлены" : "сняты";
  await interaction.reply({ content: `Роли ${verb} (${changes} изменений).`, ephemeral: true });
}

async function ensurePanel(client) {
  const channel = client.channels.cache.get(String(cfg.channel_id || ""));
  if (!channel) return;
  let roleNames = cfg.roles || [];
  if (!roleNames.length) return;
  const existing = roleNames.filter((name) => channel.guild.roles.cache.some((r) => r.name === name));
  if (existing.length) roleNames = existing;

  const desc =
    "Первое меню — получить роль, второе — снять.\n\n" +
    roleNames.map((name) => `• **${name}**`).join("\n");
  const embed = new EmbedBuilder()
    .setTitle(cfg.message || "Выбери уведомления")
    .setDescription(desc)
    .setColor(0x9b59b6)
    .setFooter({ text: PANEL_FOOTER });
  const rows = buildRows(roleNames, cfg.max_values);

  if (channel.isTextBased?.() && channel.messages) {
    try {
      const messages = await channel.messages.fetch({ limit: 30 });
      for (const msg of messages.values()) {
        if (msg.author?.id !== client.user.id || !msg.embeds?.length) continue;
        const footer = (msg.embeds[0].footer?.text || "").trim();
        if (footer !== PANEL_FOOTER) continue;
        await msg.edit({ embeds: [embed], components: rows });
        log.info("RoleMenu", `Панель обновлена в #${channel.name || cfg.channel_id}`);
        return;
      }
    } catch {}
  }

  try {
    await channel.send({ embeds: [embed], components: rows });
    log.info("RoleMenu", `Панель создана в #${channel.name || cfg.channel_id}`);
  } catch (e) {
    log.warn("RoleMenu", `Не удалось создать панель в #${channel.name || cfg.channel_id}: ${e.message}`);
  }
}

const cog = {
  name: "RoleMenu",
  async setup(registry) {
    registry.component("role_menu_add", (interaction) => applyRoles(interaction, true));
    registry.component("role_menu_remove", (interaction) => applyRoles(interaction, false));

    registry.event("ready", async () => {
      if (cfg.enabled === false) return;
      await ensurePanel(registry.client);
    });
  },
};

export default cog;