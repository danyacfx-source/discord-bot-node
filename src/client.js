import { Client, GatewayIntentBits, Partials } from "discord.js";
import { TOKEN } from "./config.js";

export let client;

export function createClient() {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildIntegrations,
      GatewayIntentBits.GuildMessageTyping,
    ],
    partials: [Partials.Channel, Partials.Message],
  });
  return client;
}

export { TOKEN };