import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, "..");
const ENV_PATH = path.join(BASE_DIR, ".env");

const DA_API = "https://www.donationalerts.com/api/v1";
const DA_TOKEN_URL = "https://www.donationalerts.com/oauth/token";
const SCOPES = "oauth-donation-index oauth-user-show";

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function setEnvValue(key, value) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf-8") : "";
  const re = new RegExp(`^(#?\\s*${key}=).*$`, "m");
  content = re.test(content)
    ? content.replace(re, `$1${value}`)
    : content.trimEnd() + `\n${key}=${value}\n`;
  fs.writeFileSync(ENV_PATH, content);
  process.env[key] = value;
}

loadEnv();

const clientId = (process.env.DONATIONALERTS_CLIENT_ID || "").trim();
const clientSecret = (process.env.DONATIONALERTS_CLIENT_SECRET || "").trim();
const redirect = process.env.DONATIONALERTS_REDIRECT_URI || "http://127.0.0.1:8124/callback";

if (!clientId || !clientSecret) {
  console.error("Нужны DONATIONALERTS_CLIENT_ID и DONATIONALERTS_CLIENT_SECRET.");
  console.error("1. Зарегистрируй приложение: https://www.donationalerts.com/application/clients");
  console.error(`2. Укажи redirect_uri: ${redirect}`);
  console.error(`3. Впиши client_id и client_secret в ${ENV_PATH}`);
  process.exit(1);
}

let redirectUrl;
try {
  redirectUrl = new URL(redirect);
} catch {
  console.error("Некорректный redirect_uri:", redirect);
  process.exit(1);
}

const authUrl =
  "https://www.donationalerts.com/oauth/authorize?" +
  `client_id=${encodeURIComponent(clientId)}&` +
  `redirect_uri=${encodeURIComponent(redirect)}&` +
  `response_type=code&` +
  `scope=${encodeURIComponent(SCOPES)}`;

async function testApi(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("Ошибка API:", res.status, text.slice(0, 200));
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    console.error("Некорректный JSON:", text.slice(0, 200));
    return null;
  }
}

async function exchange(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirect,
    code,
  });
  const res = await fetch(DA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("Token endpoint:", res.status, text.slice(0, 300));
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error("Некорректный JSON от token endpoint:", text.slice(0, 300));
    process.exit(1);
  }
  if (!data.access_token) {
    console.error("В ответе нет access_token");
    process.exit(1);
  }
  setEnvValue("DONATIONALERTS_TOKEN", data.access_token);
  if (data.refresh_token) setEnvValue("DONATIONALERTS_REFRESH_TOKEN", data.refresh_token);
  console.log("Токены сохранены в .env ✔");

  const me = await testApi(`${DA_API}/user/oauth`, data.access_token);
  if (me?.data) console.log(`Аккаунт: ${me.data.code} (${me.data.name})`);

  const alerts = await testApi(`${DA_API}/alerts/donations?page=1`, data.access_token);
  if (alerts && Array.isArray(alerts.data)) console.log(`Донатов в списке: ${alerts.data.length}`);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const cbPath = redirectUrl.pathname || "/";
  if (u.pathname === cbPath) {
    const err = u.searchParams.get("error");
    const code = u.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    if (err) {
      res.end(`Ошибка авторизации: ${err}\nВкладку можно закрыть.`);
      server.close();
      process.exit(1);
    }
    if (!code) {
      res.end("Код не найден в redirect-ссылке.\nВкладку можно закрыть.");
      server.close();
      process.exit(1);
    }
    res.end("Код получен! Вкладку можно закрыть.\n");
    exchange(code)
      .then(() => {
        server.close();
        process.exit(0);
      })
      .catch((e) => {
        console.error(e);
        server.close();
        process.exit(1);
      });
  } else {
    res.writeHead(404);
    res.end();
  }
});

const port = Number(redirectUrl.port) || 8124;
server.listen(port, "127.0.0.1", () => {
  console.log("Локальный сервер слушает http://127.0.0.1:" + port);
  console.log("\nОткрой в браузере (залогинься под своим стримерским аккаунтом DonationAlerts):");
  console.log("\n" + authUrl + "\n");
});