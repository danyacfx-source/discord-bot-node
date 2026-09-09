import { CONFIG } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.rules_gate || {};

const cog = {
  name: "RulesGate",
  _messageId: null,
  _started: false,

  async setup(registry) {
    registry.event("ready", async () => {
      if (cog._started) return;
      cog._started = true;
      cog._ensureReaction(registry.client);
    });

    registry.event("messageReactionAdd", (reaction, user) => {
      cog._toggle(reaction, user, true, registry.client);
    });

    registry.event("messageReactionRemove", (reaction, user) => {
      cog._toggle(reaction, user, false, registry.client);
    });
  },

  async _ensureReaction(client) {
    if (!cfg.enabled) return;
    const emoji = cfg.emoji || "✅";
    const message = await cog._findTarget(client);
    if (!message) {
      log.warn("RulesGate", "Целевое сообщение правил не найдено");
      return;
    }
    const hasReaction = message.reactions.cache.some(
      (r) => r.emoji.name === emoji || r.emoji.toString() === emoji
    );
    if (!hasReaction) {
      try {
        await message.react(emoji);
      } catch {}
    }
    cog._messageId = message.id;
  },

  async _findTarget(client) {
    const channelId = cfg.channel_id || 0;
    const channel = client.channels.cache.get(channelId);
    if (!channel) return null;
    const messageId = cfg.message_id || 0;
    if (messageId) {
      try {
        const msg = await channel.messages.fetch(messageId);
        if (msg) return msg;
      } catch {}
    }
    return null;
  },

  async _toggle(reaction, user, add, client) {
    if (!cfg.enabled) return;
    if (cog._messageId === null) return;
    const messageId = reaction.message?.id;
    if (messageId !== cog._messageId) return;
    const emoji = cfg.emoji || "✅";
    const reactionEmoji = reaction.emoji?.name || reaction.emoji?.toString?.() || "";
    if (reactionEmoji !== emoji) return;
    if (user.bot) return;
    const guild = client.guilds.cache.get(cfg.guild_id || reaction.message?.guild?.id);
    if (!guild) return;
    let member;
    try {
      member = await guild.members.fetch(user.id);
    } catch {
      return;
    }
    if (!member) return;
    const roleName = cfg.role || "Ознакомлен";
    const role = guild.roles.cache.find((r) => r.name === roleName);
    if (!role) {
      log.warn("RulesGate", `Роль «${roleName}» не найдена`);
      return;
    }
    try {
      if (add && !member.roles.cache.has(role.id)) {
        await member.roles.add(role, "Принятие правил ✅");
      } else if (!add && member.roles.cache.has(role.id)) {
        await member.roles.remove(role, "Снятие реакции ✅");
      }
    } catch {}
  },
};

export default cog;
