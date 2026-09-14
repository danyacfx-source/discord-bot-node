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
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.Reaction, Partials.User],
  });
  return client;
}

export { TOKEN };