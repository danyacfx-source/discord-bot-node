import { Client, GatewayIntentBits } from "discord.js";

const TARGET = process.argv[2] || "1543026204985008238";
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  for (const [id, guild] of client.guilds.cache) {
    const ch = guild.channels.cache.get(TARGET);
    if (ch) {
      const parent = ch.parent ? `parent="${ch.parent.name}"(${ch.parentId})` : "no-parent";
      console.log(`TARGET ${TARGET}: name="${ch.name}" type=${ch.type} ${parent}`);
    } else {
      console.log(`TARGET ${TARGET}: not in cache for guild ${guild.name}`);
    }
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