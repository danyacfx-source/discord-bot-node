import { PermissionFlagsBits } from "discord.js";
import { CHANNELS, EXTRA_ROLES, GUILD_ID, ROLE_SETTINGS, LEVELS } from "../config.js";
import { log } from "../notify.js";

function norm(name) {
  return name.toLowerCase().replace(/\s+/g, "-");
}

function findChannel(channels, name) {
  const n = norm(name);
  for (const ch of channels.values()) {
    if (norm(ch.name) === n) return ch;
  }
  return null;
}

function parseColor(value) {
  if (typeof value === "number") return value;
  const str = String(value).trim();
  const m = str.match(HEX_RE);
  if (m) return parseInt(m[1], 16);
  return parseInt(str, 16);
}

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

function applyPerms(permObj, specPerms) {
  if (!specPerms || !Array.isArray(specPerms)) return permObj;
  for (const p of specPerms) {
    if (typeof p === "string") {
      if (p in PermissionFlagsBits) permObj.add(PermissionFlagsBits[p]);
    } else if (p && typeof p === "object") {
      const name = p.name;
      const allowed = p.allowed !== false;
      if (name && name in PermissionFlagsBits) {
        if (allowed) permObj.add(PermissionFlagsBits[name]);
        else permObj.remove(PermissionFlagsBits[name]);
      }
    }
  }
  return permObj;
}

const cog = {
  name: "Setup",
  async setup(registry) {
    // on_ready — автонастройка ролей
    registry.event("ready", async () => {
      if (!ROLE_SETTINGS || !GUILD_ID) return;
      const guild = (await registry.client.guilds.fetch(String(GUILD_ID))).catch?.(null) || registry.client.guilds.cache.get(String(GUILD_ID));
      if (!guild) return;
      const botMember = await guild.members.fetchMe().catch(() => null);
      if (!botMember) return;
      try {
        const reports = await applyRoleSettings(guild, botMember.roles.highest, guild.roles);
        for (const line of reports) {
          if (line.includes("❌") || line.includes("⛔")) {
            log.info("Setup", `Роли ${guild.name}: ${line}`);
          }
        }
      } catch (e) {
        log.info("Setup", `Роли ${guild.name}: ошибка автонастройки: ${e.message}`);
      }
    });

    registry.slash({
      name: "setup_roles",
      description: "Создать все роли из конфига и настроить их",
      guildOnly: true,
      options: [],
      async run(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        const botMember = await guild.members.fetchMe().catch(() => null);
        if (!botMember) {
          await interaction.editReply({ content: "Бот не найден на сервере." });
          return;
        }
        const botTop = botMember.roles.highest;

        const allRoles = [...(LEVELS || []).map((l) => l.role_name), ...EXTRA_ROLES];
        const created = [];
        const existing = [];

        for (const name of allRoles) {
          const role = guild.roles.cache.find((r) => r.name === name);
          if (role) {
            existing.push(name);
            continue;
          }
          await guild.roles.create({ name, reason: "Настройка ролей ботом" }).catch(() => null);
          created.push(name);
        }

        const reports = await applyRoleSettings(guild, botTop, guild.roles);
        const reportLines = reports.length > 0 ? reports.join("\n") : "нет настроек в конфиге";

        await interaction.editReply({
          content:
            `**Создано ролей:** ${created.length > 0 ? created.join(", ") : "нет (все уже есть)"}\n` +
            `**Уже существовали:** ${existing.length > 0 ? existing.join(", ") : "нет"}\n\n` +
            `**Настройки:**\n${reportLines}`,
        });
      },
    });

    registry.slash({
      name: "apply_role_settings",
      description: "Применить цвет, порядок и права ролей из конфига",
      guildOnly: true,
      options: [],
      async run(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        const botMember = await guild.members.fetchMe().catch(() => null);
        if (!botMember) {
          await interaction.editReply({ content: "Бот не найден на сервере." });
          return;
        }
        const botTop = botMember.roles.highest;
        const reports = await applyRoleSettings(guild, botTop, guild.roles);
        await interaction.editReply({
          content: "**Применены настройки ролей:**\n" + (reports.length > 0 ? reports.join("\n") : "нет настроек в конфиге"),
        });
      },
    });

    registry.slash({
      name: "setup_channels",
      description: "Создать категории и каналы из конфига",
      guildOnly: true,
      options: [],
      async run(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        const created = [];
        const existing = [];

        for (const [catName, spec] of Object.entries(CHANNELS)) {
          let category = guild.channels.cache.find((c) => c.type === 4 && c.name === catName);
          let createdCat = false;
          if (!category) {
            category = await guild.channels.create({ name: catName, type: 4, reason: "Настройка каналов ботом" }).catch(() => null);
            createdCat = true;
            if (!category) continue;
          }

          let sponsorRoles = [];
          if (spec.type === "sponsor") {
            for (const rname of spec.roles || []) {
              const role = guild.roles.cache.find((r) => r.name === rname);
              if (role) sponsorRoles.push(role);
            }
          }

          const catType = spec.type;
          if (catType === "temp") {
            const createName = spec.create || "➕ Создать канал";
            const ch = findChannel(category.children.cache.filter((c) => c.type === 2), createName);
            if (ch) {
              existing.push(`🔊 ${createName}`);
            } else {
              await category.children.create({ name: createName, type: 2, reason: "Настройка каналов ботом" }).catch(() => null);
              created.push(`🔊 ${createName}`);
            }
            continue;
          }

          let textNames = [];
          let voiceNames = [];
          if (catType === "sponsor") {
            textNames = spec.text_channels || [];
            voiceNames = spec.voice_channels || [];
          } else {
            textNames = spec.channels || [];
            voiceNames = spec.voice_channels || [];
          }

          for (const name of textNames) {
            const existingCh = findChannel(category.children.cache.filter((c) => c.type === 0), name);
            if (existingCh) {
              existing.push(`#${name}`);
              continue;
            }
            const ch = await category.children.create({ name, type: 0, reason: "Настройка каналов ботом" }).catch(() => null);
            if (ch && sponsorRoles.length > 0) {
              await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
              for (const role of sponsorRoles) {
                await ch.permissionOverwrites.edit(role, { ViewChannel: true });
              }
            }
            created.push(`#${name}`);
          }

          for (const name of voiceNames) {
            const existingCh = findChannel(category.children.cache.filter((c) => c.type === 2), name);
            if (existingCh) {
              existing.push(`🔊 ${name}`);
              continue;
            }
            const ch = await category.children.create({ name, type: 2, reason: "Настройка каналов ботом" }).catch(() => null);
            if (ch && sponsorRoles.length > 0) {
              await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
              for (const role of sponsorRoles) {
                await ch.permissionOverwrites.edit(role, { ViewChannel: true });
              }
            }
            created.push(`🔊 ${name}`);
          }

          if (createdCat) created.push(`Категория «${catName}»`);
        }

        await interaction.editReply({
          content:
            `**Создано:** ${created.length > 0 ? created.join(", ") : "нет (всё уже есть)"}\n` +
            `**Уже существовали:** ${existing.length > 0 ? existing.join(", ") : "нет"}`,
        });
      },
    });

    registry.slash({
      name: "debug_channels",
      description: "Показать текущие категории и каналы",
      guildOnly: true,
      options: [],
      async run(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        const lines = [];

        for (const cat of guild.channels.cache.filter((c) => c.type === 4).sort((a, b) => a.name.localeCompare(b.name)).values()) {
          const sub = [];
          for (const ch of guild.channels.cache.filter((c) => c.type === 0 && c.parentId === cat.id).sort((a, b) => a.name.localeCompare(b.name)).values()) {
            sub.push(`# ${ch.name} (${ch.id})`);
          }
          for (const ch of guild.channels.cache.filter((c) => c.type === 2 && c.parentId === cat.id).sort((a, b) => a.name.localeCompare(b.name)).values()) {
            sub.push(`🔊 ${ch.name} (${ch.id})`);
          }
          lines.push(`**${cat.name}** (${cat.id}): ` + (sub.length > 0 ? sub.join(", ") : "— пусто"));
        }

        for (const ch of guild.channels.cache.filter((c) => c.type === 0 && !c.parentId).sort((a, b) => a.name.localeCompare(b.name)).values()) {
          lines.push(`# ${ch.name} (без категории)`);
        }
        for (const ch of guild.channels.cache.filter((c) => c.type === 2 && !c.parentId).sort((a, b) => a.name.localeCompare(b.name)).values()) {
          lines.push(`🔊 ${ch.name} (без категории)`);
        }

        let msg = lines.length > 0 ? lines.join("\n") : "Нет каналов.";
        if (msg.length > 1900) msg = msg.slice(0, 1900);
        await interaction.editReply({ content: `**Каналы сервера:**\n${msg}` });
      },
    });
  },
};

async function applyRoleSettings(guild, botTop, roles) {
  const reports = [];
  const ordered = Object.entries(ROLE_SETTINGS).sort((a, b) => (a[1].order || 999) - (b[1].order || 999));
  let position = botTop.position - 1;

  for (const [name, spec] of ordered) {
    const role = guild.roles.cache.find((r) => r.name === name);
    if (!role) {
      reports.push(`⚠️ **${name}** — не создана`);
      continue;
    }
    const editData = {};
    if (spec.color) {
      try {
        editData.color = parseColor(spec.color);
      } catch {
        reports.push(`❌ **${name}** — неверный цвет`);
        continue;
      }
    }
    if (spec.permissions && Array.isArray(spec.permissions)) {
      let permFlags = new PermissionFlagsBits(role.permissions.bitfield);
      for (const p of spec.permissions) {
        if (typeof p === "string") {
          if (p in PermissionFlagsBits) permFlags.add(PermissionFlagsBits[p]);
        } else if (p && typeof p === "object") {
          const pname = p.name;
          const enabled = p.allowed !== false;
          if (pname && pname in PermissionFlagsBits) {
            if (enabled) permFlags.add(PermissionFlagsBits[pname]);
            else permFlags.remove(PermissionFlagsBits[pname]);
          }
        }
      }
      editData.permissions = permFlags;
    }
    if (position >= botTop.position) {
      reports.push(`❌ **${name}** — позиция выше/равна роли бота, пропуск`);
      continue;
    }
    if (position > 1) editData.position = position;
    if (spec.hoist !== undefined) editData.hoist = !!spec.hoist;
    if (spec.mentionable !== undefined) editData.mentionable = !!spec.mentionable;

    try {
      await role.edit({ ...editData, reason: "Настройка ролей из конфига" });
      reports.push(`✅ **${name}** — цвет и позиция ${position}`);
    } catch (e) {
      if (e.httpStatus === 403) {
        reports.push(`⛔ **${name}** — нет прав на изменение`);
      } else {
        reports.push(`❌ **${name}** — ${e.message}`);
      }
    }
    position--;
  }
  return reports;
}

export default cog;
