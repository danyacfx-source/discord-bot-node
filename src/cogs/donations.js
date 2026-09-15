import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  EmbedBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
} from "discord.js";
import * as db from "../db.js";
import { CONFIG, BASE_DIR, GUILD_ID } from "../config.js";
import { log } from "../notify.js";

const DA_API = "https://www.donationalerts.com/api/v1";
const DA_TOKEN_URL = "https://www.donationalerts.com/oauth/token";

const cfg = CONFIG.donations || {};
const donateUrl = CONFIG.socials?.donate || "";
const roleName = String(cfg.role || "Спонсор");
const roleId = String(cfg.role_id || "");
const codePrefix = String(cfg.code_prefix || "VIP");
const minAmount = Number(cfg.amount) || 0;
const pollSeconds = Math.max(5, Number(cfg.poll_interval_seconds) || 15);
const envPath = path.join(BASE_DIR, ".env");

let poller = null;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function setEnv(key, value) {
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
    const re = new RegExp(`^(#?\\s*${key}=).*$`, "m");
    content = re.test(content)
      ? content.replace(re, `$1${value}`)
      : content.trimEnd() + `\n${key}=${value}\n`;
    fs.writeFileSync(envPath, content);
    process.env[key] = value;
  } catch (e) {
    log.warn("Donations", `Не удалось записать .env (${key}): ${e.message}`);
  }
}

async function refreshToken() {
  const clientId = process.env.DONATIONALERTS_CLIENT_ID || "";
  const clientSecret = process.env.DONATIONALERTS_CLIENT_SECRET || "";
  const refresh = process.env.DONATIONALERTS_REFRESH_TOKEN || "";
  if (!clientId || !clientSecret || !refresh) return false;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: clientId,
    client_secret: clientSecret,
    scope: "oauth-donation-index oauth-user-show",
  });
  try {
    const res = await fetch(DA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const t = await res.text();
      log.warn("Donations", `Refresh токена: ${res.status} ${t.slice(0, 120)}`);
      return false;
    }
    const data = await res.json();
    if (!data.access_token) return false;
    await setEnv("DONATIONALERTS_TOKEN", data.access_token);
    if (data.refresh_token) await setEnv("DONATIONALERTS_REFRESH_TOKEN", data.refresh_token);
    log.info("Donations", "Доступ DonationAlerts обновлён автоматически");
    return true;
  } catch (e) {
    log.error("Donations", "Ошибка refresh токена DonationAlerts", e);
    return false;
  }
}

async function daGet(url) {
  const call = async () => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.DONATIONALERTS_TOKEN || ""}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`DA API ${res.status}: ${t.slice(0, 200)}`);
    }
    return res.json();
  };
  try {
    return await call();
  } catch (e) {
    if (String(e.message).includes("401")) {
      const ok = await refreshToken();
      if (!ok) throw new Error("Токен DonationAlerts невалиден и не смог автоматически обновиться");
      return call();
    }
    throw e;
  }
}

function dmUser(client, userId, text) {
  return client.users
    .fetch(String(userId))
    .then((user) => user.send(text))
    .catch(() => {});
}

function findRole(guild, link) {
  const linkRoleId = String(link.role_id || "");
  if (linkRoleId) {
    const byId = guild.roles.cache.get(linkRoleId);
    if (byId) return byId;
  }
  return guild.roles.cache.find((r) => r.name === (link.role || roleName));
}

async function grantRole(client, link, code, row) {
  const guild = client.guilds.cache.get(String(link.guild_id));
  if (!guild) {
    db.kvDelete(`da_code:${code}`);
    log.warn("Donations", `Гильдия ${link.guild_id} не найдена — донат ${row.id}`);
    return;
  }
  const role = findRole(guild, link);
  let member;
  try {
    member = await guild.members.fetch(String(link.user_id));
  } catch {}
  if (!member || !role) {
    db.kvDelete(`da_code:${code}`);
    log.warn("Donations", `Роль «${link.role || roleName}» (${link.role_id || "?"}) или участник не найдены — донат ${row.id}`);
    return;
  }
  if (member.roles.cache.has(role.id)) {
    db.kvDelete(`da_code:${code}`);
    return;
  }
  await member.roles.add(role, `Донат ${row.id} через DonationAlerts`);
  db.kvDelete(`da_code:${code}`);
  log.info("Donations", `Роль «${role.name}» выдана <@${member.id}> за донат ${row.id} (${row.amount} ${row.currency})`);
}

async function processDonation(client, row) {
  const message = String(row.message || "").trim();
  const amount = Number(row.amount) || 0;
  const match = message.match(new RegExp(`${escapeRe(codePrefix)}-[A-Fa-f0-9]{8}`, "i"));
  if (!match) return;
  const code = match[0].toUpperCase();
  const raw = db.kvGet(`da_code:${code}`);
  if (!raw) return;
  let link;
  try {
    link = JSON.parse(raw);
  } catch {
    db.kvDelete(`da_code:${code}`);
    return;
  }
  if (amount < minAmount) {
    db.kvDelete(`da_code:${code}`);
    await dmUser(
      client,
      link.user_id,
      `Принят донат ${amount} ₽, но порог для роли «${link.role || roleName}» — ${minAmount} ₽. Роль не выдана.`
    );
    log.info("Donations", `Донат ${row.id}: ${code} — сумма ${amount} меньше порога ${minAmount}`);
    return;
  }
  await grantRole(client, link, code, row);
}

async function pollOnce(client) {
  const token = process.env.DONATIONALERTS_TOKEN || "";
  if (!token) {
    stopPoller();
    return;
  }
  let payload;
  try {
    payload = await daGet(`${DA_API}/alerts/donations?page=1`);
  } catch (e) {
    log.error("Donations", `Ошибка запроса донатов: ${e.message}`, e);
    return;
  }
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  if (!rows.length) return;
  const lastRaw = Number(db.kvGet("da_last_id") || 0);
  let maxId = lastRaw;
  for (const row of rows) {
    const id = Number(row.id);
    if (id > maxId) maxId = id;
  }
  if (lastRaw === 0) {
    db.kvSet("da_last_id", String(maxId));
    return;
  }
  const fresh = rows.filter((row) => Number(row.id) > lastRaw);
  for (const row of fresh) {
    try {
      await processDonation(client, row);
    } catch (e) {
      log.error("Donations", `Обработка доната ${row.id}: ${e.message}`, e);
    }
  }
  if (maxId > lastRaw) db.kvSet("da_last_id", String(maxId));
}

function startPoller(client) {
  if (poller) return;
  const tick = async () => {
    try {
      await pollOnce(client);
    } catch (e) {
      log.error("Donations", `Цикл опроса: ${e.message}`, e);
    }
  };
  tick();
  poller = setInterval(tick, pollSeconds * 1000);
}

function stopPoller() {
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
}

function genCode() {
  return `${codePrefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

async function onDonateClick(interaction) {
  const token = process.env.DONATIONALERTS_TOKEN || "";
  if (!token) {
    await interaction.reply({
      content: "Связь с DonationAlerts ещё не настроена — попроси администратора добавить токен.",
      ephemeral: true,
    });
    return;
  }
  const code = genCode();
  db.kvSet(
    `da_code:${code}`,
    JSON.stringify({
      user_id: interaction.user.id,
      guild_id: String(interaction.guildId || ""),
      role: roleName,
      role_id: roleId,
      created_at: Date.now(),
    })
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Открыть страницу доната").setStyle(ButtonStyle.Link).setURL(donateUrl)
  );
  const embed = new EmbedBuilder()
    .setTitle("Донат и роль")
    .setColor(0xf1c40f)
    .setDescription(
      `Твой персональный код: **\`${code}\`**\n\n` +
        `1. Нажми кнопку ниже.\n` +
        `2. В поле сообщения доната напиши код **\`${code}\`**.\n` +
        `3. После оплаты роль **«${roleName}»** выдастся автоматически.` +
        (minAmount > 0 ? `\n\nМинимальная сумма для роли: **${minAmount} ₽**` : "")
    );
  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

const cog = {
  name: "Donations",
  async setup(registry) {
    registry.component("donate:btn", onDonateClick);

    registry.event("clientReady", async (client) => {
      if (cfg.enabled === false) return;

      if (GUILD_ID) {
        const guild = client.guilds.cache.get(String(GUILD_ID));
        const roleExists = roleId
          ? guild?.roles?.cache?.has(String(roleId))
          : guild?.roles?.cache?.some((r) => r.name === roleName);
        if (!roleExists) {
          log.warn("Donations", `Роль «${roleName}» (${roleId || "по имени"}) не найдена на сервере — создай её и убедись, что бот стоит выше`);
        }
      }

      try {
        db.kvDelete("donations_message_id");
      } catch {}

      if (!process.env.DONATIONALERTS_TOKEN) {
        log.warn("Donations", "DONATIONALERTS_TOKEN не задан — ожидание донатов выключено (кнопка работает)");
        return;
      }
      startPoller(client);
    });
  },
};

export default cog;