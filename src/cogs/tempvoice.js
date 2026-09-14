import fs from "node:fs";
import path from "node:path";
import {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { DATA_DIR, TEMP_CATS, TEMP_TRIGGERS } from "../config.js";
import { log } from "../notify.js";

const OWNERS_FILE = path.join(DATA_DIR, "temp_channel_owners.json");
const CLEANUP_SECONDS = 60;

const tempChannelOwners = new Map();
let ownersLoaded = false;
const triggerChannelIds = new Set();
const tempCategoryIds = new Set();
const channelLocks = new Map();
let bot = null;
let cleanupTimer = null;

function slug(name) {
  // Unicode-aware slug: keep Cyrillic and any letters/numbers, strip emoji/symbols
  return String(name || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function loadOwners() {
  if (ownersLoaded) return;
  ownersLoaded = true;
  try {
    if (fs.existsSync(OWNERS_FILE)) {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(OWNERS_FILE, "utf-8")))) {
        tempChannelOwners.set(String(k), String(v));
      }
    }
  } catch (e) {
    log.warn("TempVoice", `Не удалось прочитать владельцев каналов: ${e.message}`);
  }
}

function saveOwners() {
  try {
    fs.mkdirSync(path.dirname(OWNERS_FILE), { recursive: true });
    const tmp = OWNERS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(tempChannelOwners)), "utf-8");
    fs.renameSync(tmp, OWNERS_FILE);
  } catch (e) {
    log.warn("TempVoice", `Не удалось сохранить владельцев каналов: ${e.message}`);
  }
}

const MAX_LOCKS = 256;
function channelLock(id) {
  const key = String(id);
  let lock = channelLocks.get(key);
  if (!lock) {
    lock = { p: Promise.resolve(), lastUsed: Date.now() };
    channelLocks.set(key, lock);
    // LRU eviction: remove oldest when exceeding limit
    if (channelLocks.size > MAX_LOCKS) {
      // sort by lastUsed
      const entries = [...channelLocks.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const toDelete = entries.slice(0, Math.ceil(channelLocks.size / 2));
      for (const [cid] of toDelete) {
        const l = channelLocks.get(cid);
        // don't delete if still pending
        if (l && l.p) {
          // check if lock is idle (resolved)
          // we still delete oldest; withLock will recreate
        }
        channelLocks.delete(cid);
      }
    }
  }
  lock.lastUsed = Date.now();
  return lock;
}

function withLock(id, fn) {
  const lock = channelLock(id);
  const run = lock.p.then(() => fn()).catch((e) => { throw e; });
  // chain next
  lock.p = run.catch(() => {});
  // schedule cleanup after idle 5 minutes
  setTimeout(() => {
    const current = channelLocks.get(String(id));
    if (current === lock) {
      // if no pending chain beyond resolved, allow eviction on next overflow; keep for now
      // optional auto-delete if idle and promise settled
      // we keep to avoid churn; LRU will evict
    }
  }, 5 * 60 * 1000).unref?.();
  return run;
}

function specFor(channel) {
  if (!channel || !channel.parent) return null;
  return TEMP_CATS[channel.parent.name] || null;
}

function isCreate(channel) {
  if (!channel) return false;
  if (triggerChannelIds.has(String(channel.id))) return true;
  const spec = specFor(channel);
  if (!spec) return false;
  return slug(channel.name) === slug(spec.create || "➕ Создать канал");
}

function isManaged(channel) {
  if (!channel) return false;
  if (triggerChannelIds.has(String(channel.id))) return false;
  const spec = specFor(channel);
  if (spec) return slug(channel.name) !== slug(spec.create || "➕ Создать канал");
  if (channel.parent && tempCategoryIds.has(String(channel.parent.id))) return true;
  return false;
}

function isOwner(interaction, vc) {
  return tempChannelOwners.get(String(vc.id)) === String(interaction.user.id);
}

function newChannelName(trigger, category, spec) {
  const name = TEMP_TRIGGERS[String(trigger.id)];
  if (name) return name;
  if (spec && spec.prefix) return spec.prefix;
  return "Канал";
}

function tempChannels(guild) {
  const out = [];
  const seen = new Set();
  for (const category of guild.channels.cache.values()) {
    if (category.type !== ChannelType.GuildCategory) continue;
    if (!TEMP_CATS[category.name] && !tempCategoryIds.has(String(category.id))) continue;
    for (const ch of category.children.cache.values()) {
      if (ch.type !== ChannelType.GuildVoice) continue;
      if (seen.has(String(ch.id))) continue;
      if (isManaged(ch)) {
        seen.add(String(ch.id));
        out.push(ch);
      }
    }
  }
  return out;
}

function humansOf(vc) {
  return [...vc.members.values()].filter((m) => !m.user.bot);
}

async function deleteIfEmpty(vc) {
  tempChannelOwners.delete(String(vc.id));
  saveOwners();
  try {
    await vc.delete("Временный канал: пустой");
  } catch (e) {
    if (e.code !== 10003) {
      log.warn("TempVoice", `Ошибка удаления канала ${vc.name}: ${e.message}`);
    }
  } finally {
    // cleanup lock after deletion to prevent unbounded growth
    channelLocks.delete(String(vc.id));
  }
}

async function cleanupEmpty() {
  for (const guild of bot.guilds.cache.values()) {
    for (const vc of tempChannels(guild)) {
      if (humansOf(vc).length) continue;
      await withLock(String(vc.id), () => deleteIfEmpty(vc));
    }
  }
}

async function onReady() {
  loadOwners();
  for (const guild of bot.guilds.cache.values()) {
    for (const catName of Object.keys(TEMP_CATS)) {
      const category = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name === catName
      );
      if (!category) continue;
      const spec = TEMP_CATS[catName];
      for (const ch of category.children.cache.values()) {
        if (ch.type === ChannelType.GuildVoice && slug(ch.name) === slug(spec.create || "➕ Создать канал")) {
          triggerChannelIds.add(String(ch.id));
        }
      }
    }
    for (const vid of Object.keys(TEMP_TRIGGERS)) {
      if (guild.channels.cache.get(String(vid))) triggerChannelIds.add(String(vid));
    }
    for (const tid of triggerChannelIds) {
      const ch = guild.channels.cache.get(String(tid));
      if (ch && ch.parent) tempCategoryIds.add(String(ch.parent.id));
    }
    for (const vc of tempChannels(guild)) {
      const humans = humansOf(vc);
      if (!humans.length) {
        await withLock(String(vc.id), () => deleteIfEmpty(vc));
      } else if (!tempChannelOwners.has(String(vc.id))) {
        tempChannelOwners.set(String(vc.id), String(humans[0].id));
        saveOwners();
      }
    }
  }
  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => {
      cleanupEmpty().catch((e) => log.error("TempVoice", `Ошибка очистки: ${e.message}`, e));
    }, CLEANUP_SECONDS * 1000);
  }
}

async function onVoiceStateUpdate(oldState, newState) {
  if (newState.member?.user.bot) return;
  const beforeCh = oldState.channel;
  const afterCh = newState.channel;

  if (beforeCh && isCreate(beforeCh)) return;

  if (afterCh && isCreate(afterCh)) {
    const category = afterCh.parent;
    if (!category) return;
    const guild = afterCh.guild;
    const spec = TEMP_CATS[category.name] || null;
    const member = newState.member;
    if (!member) return;
    const triggerId = String(afterCh.id);
    // Use lock per trigger to prevent duplicate creation when two users join simultaneously
    await withLock(`create:${triggerId}`, async () => {
      // Atomic re-check: member may have already left trigger or been moved by parallel handler
      const freshMember = guild.members.cache.get(String(member.id));
      const currentChannel = freshMember?.voice?.channel;
      if (!currentChannel || String(currentChannel.id) !== triggerId) return;
      // Also ensure trigger still exists and is still a create channel
      const triggerChannel = guild.channels.cache.get(triggerId);
      if (!triggerChannel || !isCreate(triggerChannel)) return;

      let vc;
      try {
        vc = await guild.channels.create({
          name: newChannelName(afterCh, category, spec),
          type: ChannelType.GuildVoice,
          parent: category.id,
          reason: "Временный канал",
        });
      } catch (e) {
        log.warn("TempVoice", `Ошибка создания временного канала: ${e.message}`);
        return;
      }
      tempChannelOwners.set(String(vc.id), String(member.id));
      saveOwners();
      let moved = false;
      // Collect members currently in trigger at creation time (atomic snapshot)
      const toMove = [...triggerChannel.members.values()].filter((m) => !m.user.bot);
      // Prefer moving the triggering member first
      toMove.sort((a, b) => (String(a.id) === String(member.id) ? -1 : String(b.id) === String(member.id) ? 1 : 0));
      for (const m of toMove) {
        // Skip if already moved or not in trigger anymore
        if (String(m.voice?.channel?.id) !== triggerId) continue;
        try {
          await m.voice.setChannel(vc.id);
          moved = true;
        } catch (e) {
          log.warn("TempVoice", `Ошибка перемещения ${m.id}: ${e.message}`);
        }
      }
      if (!moved) {
        // Handle move failures: no one could be moved -> cleanup to avoid orphan
        tempChannelOwners.delete(String(vc.id));
        saveOwners();
        await vc.delete("Временный канал: никто не перемещён").catch(() => {});
        channelLocks.delete(String(vc.id));
      }
    }).catch((e) => log.warn("TempVoice", `Ошибка withLock create: ${e.message}`));
  }

  if (beforeCh && isManaged(beforeCh) && String(beforeCh.id) !== String(afterCh?.id)) {
    const vc = beforeCh;
    const member = newState.member || oldState.member;
    if (!member) return;
    await withLock(String(vc.id), async () => {
      const remaining = humansOf(vc);
      if (!remaining.length) {
        await deleteIfEmpty(vc);
      } else if (tempChannelOwners.get(String(vc.id)) === String(member.id) && (!afterCh || String(afterCh.id) !== String(vc.id))) {
        const newOwner = remaining[0];
        tempChannelOwners.set(String(vc.id), String(newOwner.id));
        saveOwners();
        const embed = new EmbedBuilder()
          .setTitle("👑 Права канала переданы")
          .setDescription(
            `Предыдущий владелец **${member.displayName}** покинул канал.\nНовый владелец: **${newOwner}**`
          )
          .setColor(0xf1c40f);
        try {
          await vc.send({ embeds: [embed] });
        } catch {}
      }
    });
  }
}

function guardManagedChannel(interaction) {
  const member = interaction.member;
  if (!member.voice?.channel) return "Вы не в голосовом канале.";
  const vc = member.voice.channel;
  if (!isManaged(vc)) return "Нельзя управлять этим каналом.";
  if (!isOwner(interaction, vc)) return "Только владелец канала может это делать.";
  return null;
}

async function toggleEveryonePerm(vc, permission, denyIt) {
  const everyone = vc.guild.roles.everyone;
  // Fix Allow/Deny case: discord.js expects lowercase allow/deny or permission name mapping
  // Use edit with permission name for reliability
  let permKey = null;
  if (permission === PermissionFlagsBits.Connect) permKey = "Connect";
  else if (permission === PermissionFlagsBits.ViewChannel) permKey = "ViewChannel";
  else if (permission === PermissionFlagsBits.Speak) permKey = "Speak";
  if (permKey) {
    // When denyIt = true -> deny (false), when false -> clear overwrite (null)
    return vc.permissionOverwrites.edit(everyone, { [permKey]: denyIt ? false : null }, "Управление временным каналом");
  }
  // Fallback generic bitfield handling with correct lowercase keys
  const existing = vc.permissionOverwrites.cache.get(String(everyone.id));
  const allow = existing ? existing.allow.bitfield : 0n;
  const deny = existing ? existing.deny.bitfield : 0n;
  const bit = PermissionsBitField.resolve(permission);
  const newAllow = allow & ~bit;
  const newDeny = denyIt ? deny | bit : deny & ~bit;
  // Use edit with object containing allow/deny as strings? Use overwrite edit with bitfields
  return vc.permissionOverwrites.edit(everyone, { Connect: undefined }, "Управление временным каналом").then(() => {
    // Fallback if generic path needed, use set with correct structure
    return vc.permissionOverwrites.set([{ id: everyone.id, allow: newAllow, deny: newDeny }], "Управление временным каналом");
  });
}

async function vcLock(interaction) {
  const err = guardManagedChannel(interaction);
  if (err) return interaction.reply({ content: err, ephemeral: true });
  const vc = interaction.member.voice.channel;
  const overwrite = vc.permissionOverwrites.cache.get(String(vc.guild.roles.everyone.id));
  const locked = overwrite ? overwrite.deny.has(PermissionFlagsBits.Connect) : false;
  await toggleEveryonePerm(vc, PermissionFlagsBits.Connect, !locked);
  return interaction.reply({
    content: locked ? "✅ Канал открыт." : "✅ Канал закрыт.",
    ephemeral: true,
  });
}

async function vcHide(interaction) {
  const err = guardManagedChannel(interaction);
  if (err) return interaction.reply({ content: err, ephemeral: true });
  const vc = interaction.member.voice.channel;
  const overwrite = vc.permissionOverwrites.cache.get(String(vc.guild.roles.everyone.id));
  const hidden = overwrite ? overwrite.deny.has(PermissionFlagsBits.ViewChannel) : false;
  await toggleEveryonePerm(vc, PermissionFlagsBits.ViewChannel, !hidden);
  return interaction.reply({
    content: hidden ? "✅ Канал показан." : "✅ Канал скрыт.",
    ephemeral: true,
  });
}

async function vcQuality(interaction) {
  const err = guardManagedChannel(interaction);
  if (err) return interaction.reply({ content: err, ephemeral: true });
  const vc = interaction.member.voice.channel;
  const low = vc.bitrate <= 64000;
  await vc.setBitrate(low ? 128000 : 64000, "Качество изменено владельцем");
  return interaction.reply({
    content: low ? "✅ Качество повышено (128 кбит/с)." : "✅ Качество понижено (64 кбит/с).",
    ephemeral: true,
  });
}

function kickModal() {
  return new ModalBuilder()
    .setCustomId("vc_modal_kick")
    .setTitle("Выгнать участника")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("vc_target")
          .setLabel("ID или упоминание участника")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
}

function renameModal() {
  return new ModalBuilder()
    .setCustomId("vc_modal_rename")
    .setTitle("Переименовать канал")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("vc_name")
          .setLabel("Новое название")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      )
    );
}

function limitModal() {
  return new ModalBuilder()
    .setCustomId("vc_modal_limit")
    .setTitle("Лимит участников")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("vc_limit_value")
          .setLabel("Лимит (0 = без лимита, макс. 99)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
}

function transferModal() {
  return new ModalBuilder()
    .setCustomId("vc_modal_transfer")
    .setTitle("Передать владельца")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("vc_transfer_target")
          .setLabel("ID или упоминание участника в канале")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
}

function showModalIfOwner(interaction, modal) {
  const err = guardManagedChannel(interaction);
  if (err) return interaction.reply({ content: err, ephemeral: true });
  return interaction.showModal(modal);
}

async function parseTarget(vc, raw, interaction) {
  const uid = String(raw || "").replace(/[^\d]/g, "");
  if (!uid) {
    await interaction.reply({ content: "Укажите ID участника.", ephemeral: true });
    return null;
  }
  const member = interaction.guild.members.cache.get(String(uid));
  if (!member) {
    await interaction.reply({ content: "Участник не найден.", ephemeral: true });
    return null;
  }
  return member;
}

async function onKickModal(interaction) {
  const err = guardManagedChannel(interaction);
  if (err) return interaction.reply({ content: err, ephemeral: true });
  const vc = interaction.member.voice.channel;
  const raw = interaction.fields.getTextInputValue("vc_target");
  const member = await parseTarget(vc, raw, interaction);
  if (!member) return;
  if (String(member.voice?.channel?.id) === String(vc.id)) {
    try {
      await member.voice.setChannel(null, "Выгнан из временного канала");
    } catch (e) {
      return interaction.reply({ content: `Не удалось выгнать: ${e.message}`, ephemeral: true });
    }
    return interaction.reply({ content: `✅ ${member} выгнан.`, ephemeral: true });
  }
  return interaction.reply({ content: "Участник не в вашем канале.", ephemeral: true });
}

async function onRenameModal(interaction) {
  const err = guardManagedChannel(interaction);
  if (err) return interaction.reply({ content: err, ephemeral: true });
  const vc = interaction.member.voice.channel;
  const name = interaction.fields.getTextInputValue("vc_name").trim();
  if (!name) return interaction.reply({ content: "Название не может быть пустым.", ephemeral: true });
  const oldName = vc.name;
  try {
    await vc.setName(name, "Переименован владельцем");
  } catch (e) {
    return interaction.reply({ content: `Не удалось переименовать: ${e.message}`, ephemeral: true });
  }
  return interaction.reply({
    content: `✅ Канал переименован: \`${oldName}\` → \`${name}\``,
    ephemeral: true,
  });
}

async function onLimitModal(interaction) {
  const err = guardManagedChannel(interaction);
  if (err) return interaction.reply({ content: err, ephemeral: true });
  const vc = interaction.member.voice.channel;
  const raw = interaction.fields.getTextInputValue("vc_limit_value");
  const n = Number(raw);
  if (!Number.isFinite(n)) return interaction.reply({ content: "Введите число.", ephemeral: true });
  if (n < 0 || n > 99) {
    return interaction.reply({ content: "Лимит должен быть от 0 до 99.", ephemeral: true });
  }
  try {
    await vc.setUserLimit(n, "Лимит изменён владельцем");
  } catch (e) {
    return interaction.reply({ content: `Не удалось изменить лимит: ${e.message}`, ephemeral: true });
  }
  const text = n === 0 ? "✅ Лимит снят." : `✅ Лимит установлен: **${n}** участников.`;
  return interaction.reply({ content: text, ephemeral: true });
}

async function onTransferModal(interaction) {
  const err = guardManagedChannel(interaction);
  if (err) return interaction.reply({ content: err, ephemeral: true });
  const vc = interaction.member.voice.channel;
  const raw = interaction.fields.getTextInputValue("vc_transfer_target");
  const member = await parseTarget(vc, raw, interaction);
  if (!member) return;
  if (String(member.voice?.channel?.id) !== String(vc.id)) {
    return interaction.reply({ content: "Участник не в вашем канале.", ephemeral: true });
  }
  tempChannelOwners.set(String(vc.id), String(member.id));
  saveOwners();
  return interaction.reply({ content: `✅ Права канала переданы: **${member.displayName}**.`, ephemeral: true });
}

function buildPanel() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("vc_lock").setLabel("Закрыть").setEmoji("🔒").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("vc_hide").setLabel("Скрыть").setEmoji("👁").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("vc_limit").setLabel("Лимит").setEmoji("👥").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("vc_quality").setLabel("Качество").setEmoji("🎚").setStyle(ButtonStyle.Primary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("vc_kick").setLabel("Выгнать").setEmoji("👢").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("vc_rename").setLabel("Название").setEmoji("✏️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("vc_transfer").setLabel("Передать").setEmoji("👑").setStyle(ButtonStyle.Success)
  );
  return [row1, row2];
}

const cog = {
  name: "TempVoice",
  async setup(registry) {
    bot = registry.client;

    registry.event("clientReady", () => onReady().catch((e) => log.error("TempVoice", `Ошибка ready: ${e.message}`, e)));

    registry.event("voiceStateUpdate", (oldState, newState) =>
      onVoiceStateUpdate(oldState, newState).catch((e) =>
        log.error("TempVoice", `Ошибка обработки voiceStateUpdate: ${e.message}`, e)
      )
    );

    registry.componentPrefix("vc_", async (interaction) => {
      const id = interaction.customId;
      if (id === "vc_lock") return vcLock(interaction);
      if (id === "vc_hide") return vcHide(interaction);
      if (id === "vc_quality") return vcQuality(interaction);
      if (id === "vc_kick") return showModalIfOwner(interaction, kickModal());
      if (id === "vc_rename") return showModalIfOwner(interaction, renameModal());
      if (id === "vc_limit") return showModalIfOwner(interaction, limitModal());
      if (id === "vc_transfer") return showModalIfOwner(interaction, transferModal());
      return interaction.reply({ content: "Неизвестная кнопка.", ephemeral: true });
    });

    registry.component("vc_modal_kick", onKickModal);
    registry.component("vc_modal_rename", onRenameModal);
    registry.component("vc_modal_limit", onLimitModal);
    registry.component("vc_modal_transfer", onTransferModal);

    registry.slash({
      name: "temp_panel",
      description: "Отправить панель управления временными каналами",
      guildOnly: true,
      options: [],
      async run(interaction) {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
          return interaction.reply({ content: "Только для администраторов.", ephemeral: true });
        }
        const embed = new EmbedBuilder()
          .setTitle("🎛️ Панель управления временным каналом")
          .setDescription(
            "Зайдите в свой временный голосовой канал и нажмите кнопку:\n\n" +
              "🔒 **Закрыть** — закрыть/открыть канал для всех\n" +
              "👢 **Выгнать** — выгнать участника из канала\n" +
              "✏️ **Название** — переименовать канал\n" +
              "👥 **Лимит** — ограничить число участников\n" +
              "👁 **Скрыть** — скрыть/показать канал\n" +
              "👑 **Передать** — передать права владельца\n" +
              "🎚 **Качество** — понизить/повысить качество звука"
          )
          .setColor(0x5865f2);
        await interaction.reply({ embeds: [embed], components: buildPanel() });
      },
    });
  },
};

export default cog;
