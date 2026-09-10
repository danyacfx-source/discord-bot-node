import { Client, GatewayIntentBits } from "discord.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log(`Bot: ${client.user?.tag}  Servers: ${client.guilds.cache.size}`);
  for (const [, guild] of client.guilds.cache) {
    console.log(`\n=== Guild: ${guild.name} (${guild.id}) ===`);
    const cats = [...guild.channels.cache.values()].filter((c) => c.type === 4);
    cats.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const noCat = [...guild.channels.cache.values()].filter((c) => c.type !== 4 && !c.parentId);
    const all = [...guild.channels.cache.values()].filter((c) => c.type !== 4);
    const orphans = all.filter((c) => !c.parentId);
    for (const cat of cats) {
      console.log(`CAT  ${cat.name} (${cat.id}) pos=${cat.position}`);
      const kids = cat.children.cache
        ? [...cat.children.cache.values()].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        : [];
      for (const k of kids) console.log(`   ├─ ${k.name} (${k.id}) type=${k.type}`);
    }
    if (orphans.length) {
      console.log("БЕЗ КАТЕГОРИИ:");
      for (const o of orphans) console.log(`   ├─ ${o.name} (${o.id}) type=${o.type}`);
    }
    console.log(`memberCount=${guild.memberCount} approxMembers=${guild.approximateMemberCount} approxOnline=${guild.approximatePresenceCount}`);
  }
  client.destroy();
  process.exit(0);
});

client.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});

client.login(process.env.BOT_TOKEN).catch((e) => {
  console.error("Login failed:", e.message);
  process.exit(1);
});