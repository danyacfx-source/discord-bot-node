import { EmbedBuilder } from "discord.js";
import { CONFIG } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.reaction_roles || {};
let panelMessageId = null;
let started = false;

async function ensurePanel(guild, client) {
  if (!cfg.enabled && cfg.enabled !== undefined) return;
  const channelId = cfg.channel_id;
  if (!channelId) return;
  const channel = guild.channels.cache.get(String(channelId));
  if (!channel) return;
  const roles = cfg.roles || [];
  if (roles.length === 0) return;

  const desc = roles.map((r) => `${r.emoji} — **${r.role}**`).join("\n");
  const embed = new EmbedBuilder()
    .setTitle(cfg.message || "Выбери уведомления")
    .setDescription(desc)
    .setColor(0x9b59b6)
    .setFooter({ text: "Нажми на реакцию под этим сообщением" });

  // Try existing panel message
  if (panelMessageId) {
    try {
      const msg = await channel.messages.fetch(panelMessageId);
      await msg.edit({ embeds: [embed] });
      await syncReactions(msg, roles);
      return;
    } catch {
      panelMessageId = null;
    }
  }

  // Search for existing bot message with that footer
  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    for (const [, old] of messages) {
      if (old.author.id !== client.user.id || old.embeds.length === 0) continue;
      const footer = (old.embeds[0].footer?.text || "").trim();
      if (footer !== "Нажми на реакцию под этим сообщением") continue;
      await old.edit({ embeds: [embed] });
      await syncReactions(old, roles);
      panelMessageId = old.id;
      return;
    }
  } catch {
    // ignore
  }

  // Create new
  const msg = await channel.send({ embeds: [embed] });
  await syncReactions(msg, roles);
  panelMessageId = msg.id;
}

async function syncReactions(msg, roles) {
  const wanted = new Set(roles.map((r) => r.emoji));
  const current = new Set(msg.reactions.cache.map((r) => (typeof r.emoji === "string" ? r.emoji : r.emoji.name)));
  for (const emoji of wanted) {
    if (!current.has(emoji)) {
      await msg.react(emoji).catch(() => {});
    }
  }
}

async function toggleRole(payload, add, client) {
  const guild = client.guilds.cache.get(String(payload.guild_id));
  if (!guild) return;
  const member = guild.members.cache.get(String(payload.user_id));
  if (!member || member.user.bot) return;

  for (const spec of cfg.roles || []) {
    if (payload.emoji.name !== spec.emoji) continue;
    const role = guild.roles.cache.find((r) => r.name === spec.role);
    if (!role) return;
    try {
      if (add && !member.roles.cache.has(role.id)) {
        await member.roles.add(role, "Выбор роли по реакции");
      } else if (!add && member.roles.cache.has(role.id)) {
        await member.roles.remove(role, "Снятие роли по реакции");
      }
    } catch (e) {
      // Forbidden
    }
    return;
  }
}

const cog = {
  name: "ReactionRoles",
  async setup(registry) {
    registry.event("ready", async () => {
      if (started) return;
      started = true;
      // Find the guild from config
      const client = registry.client;
      for (const [, guild] of client.guilds.cache) {
        await ensurePanel(guild, client);
      }
    });

    registry.event("messageReactionAdd", async (reaction, user) => {
      if (user.bot) return;
      // Handle uncached partials
      if (reaction.message.partial) {
        try {
          await reaction.message.fetch();
        } catch {
          return;
        }
      }
      const payload = {
        guild_id: reaction.message.guild?.id,
        user_id: user.id,
        emoji: reaction.emoji,
        message_id: reaction.message.id,
      };
      if (String(payload.message_id) !== String(panelMessageId)) return;
      await toggleRole(payload, true, registry.client);
    });

    registry.event("messageReactionRemove", async (reaction, user) => {
      if (user.bot) return;
      if (reaction.message.partial) {
        try {
          await reaction.message.fetch();
        } catch {
          return;
        }
      }
      const payload = {
        guild_id: reaction.message.guild?.id,
        user_id: user.id,
        emoji: reaction.emoji,
        message_id: reaction.message.id,
      };
      if (String(payload.message_id) !== String(panelMessageId)) return;
      await toggleRole(payload, false, registry.client);
    });
  },
};

export default cog;
