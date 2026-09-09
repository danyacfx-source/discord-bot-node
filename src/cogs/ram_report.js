import { EmbedBuilder } from "discord.js";
import { CONFIG } from "../config.js";
import { log } from "../notify.js";

const cfg = CONFIG.ram_report || {};
const enabled = cfg.enabled || false;
const channelId = cfg.channel_id || 0;
const intervalMinutes = cfg.interval_minutes || 30;

let timerId = null;

function rssMb() {
  const mem = process.memoryUsage();
  return mem.rss / (1024 * 1024);
}

function peakMb() {
  const mem = process.memoryUsage();
  const peak = mem.rss;
  return peak / (1024 * 1024);
}

async function sendReport(client) {
  if (channelId <= 0) return;
  const channel = client.channels.cache.get(String(channelId));
  if (!channel) {
    log.warn("RamReport", `Канал ${channelId} не найден`);
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle("📊 Память бота")
    .setColor(0x5865f2)
    .addFields(
      { name: "Текущее потребление", value: `${rssMb().toFixed(1)} МБ`, inline: false },
      { name: "Пик", value: `${peakMb().toFixed(1)} МБ`, inline: false }
    );
  try {
    await channel.send({ embeds: [embed] });
  } catch (e) {
    log.error("RamReport", `Ошибка отправки отчёта: ${e.message}`);
  }
}

const cog = {
  name: "RamReport",
  async setup(registry) {
    if (!enabled || channelId <= 0) return;

    registry.event("ready", async () => {
      if (timerId) return;
      const client = registry.client;
      log.info("RamReport", `Отчёт по ОЗУ: каждые ${intervalMinutes} мин в канал ${channelId}`);

      // First run after interval
      timerId = setTimeout(async function tick() {
        await sendReport(client);
        timerId = setTimeout(tick, intervalMinutes * 60 * 1000);
      }, intervalMinutes * 60 * 1000);
    });
  },
};

export default cog;
