import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OVERLAY, CONFIG, DATA_DIR } from "../config.js";
import * as db from "../db.js";
import { activeStream, fmtNum, CHANNELS } from "../stream_state.js";
import { log } from "../notify.js";

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try {
    const ha = crypto.createHash("sha256").update(String(a)).digest();
    const hb = crypto.createHash("sha256").update(String(b)).digest();
    const eq = crypto.timingSafeEqual(ha, hb);
    return eq && String(a).length === String(b).length;
  } catch {
    return false;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const limit = 1 * 1024 * 1024; // 1MB
    let rejected = false;
    function fail(err) {
      if (rejected) return;
      rejected = true;
      try { req.removeAllListeners("data"); req.removeAllListeners("end"); req.removeAllListeners("error"); } catch {}
      try { req.pause(); } catch {}
      try { if (!req.destroyed) req.destroy(); } catch {}
      reject(err);
    }
    req.on("data", (c) => {
      if (rejected) return;
      total += c.length;
      if (total > limit) {
        const e = new Error("payload too large");
        e.status = 413;
        fail(e);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      resolve(Buffer.concat(chunks).toString());
    });
    req.on("error", (e) => fail(e));
  });
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const PAGE = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>Overlay</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:transparent;font-family:'Segoe UI',Roboto,Arial,sans-serif;color:#fff;width:420px;overflow:hidden}
.card{background:rgba(20,22,31,.82);border-left:4px solid #9146ff;border-radius:10px;padding:14px 16px;margin-bottom:12px;box-shadow:0 4px 18px rgba(0,0,0,.45);backdrop-filter:blur(4px)}
.card.live{border-left-color:#e74c3c}
.card h3{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#a7a9be;margin-bottom:6px}
.card .value{font-size:16px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.card .empty{color:#6a6c82;font-size:14px}
.counters{font-size:14px;line-height:1.6}.counters b{color:#f1c40f}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#e74c3c;margin-right:6px;animation:blink 1.2s infinite}
@keyframes blink{50%{opacity:.25}}
</style></head><body><div id="root"></div>
<script>
async function load(){try{const r=await fetch('/overlay/api?token=__TOKEN__');const d=await r.json();let h='';
if(d.stream&&d.stream.live){h+='<div class="card live"><h3>🔴 Стрим · '+esc(d.stream.platform)+'</h3><div class="value"><span class="dot"></span><b>'+esc(d.stream.title)+'</b></div>';
h+='<div class="counters">👁 Зрители: <b>'+esc(d.stream.viewers)+'</b> · Пик: <b>'+esc(d.stream.peak)+'</b></div>';
if(d.stream.category)h+='<div class="counters">🎮 '+esc(d.stream.category)+'</div>';h+='</div>'}
else if(d.stream){h+='<div class="card"><h3>Стрим</h3><div class="empty">Офлайн</div></div>'}
if(d.counters&&d.counters.length){h+='<div class="card"><h3>📦 Счётчики</h3><div class="counters">';for(const c of d.counters)h+='<div><b>'+esc(c.name)+'</b>: '+esc(c.value)+'</div>';h+='</div></div>'}
if(d.donation_goal&&d.donation_goal.enabled){h+='<div class="card"><h3>💰 '+esc(d.donation_goal.label)+'</h3><div class="value">'+esc(d.donation_goal.current)+' / '+esc(d.donation_goal.target)+' '+esc(d.donation_goal.currency)+'</div></div>'}
document.getElementById('root').innerHTML=h;}catch(e){}}
function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML}
load();setInterval(load,5000);
</script></body></html>`;

const cog = {
  name: "Overlay",
  _server: null,
  _token: null,

  async setup(registry) {
    if (!OVERLAY.enabled) {
      log.info("Overlay", "Отключён в конфиге");
      return;
    }
    if (cog._server) return;

    const host = process.env.OVERLAY_HOST || OVERLAY.host || "127.0.0.1";
    const portRaw = process.env.OVERLAY_PORT || OVERLAY.port;
    const port = portRaw !== undefined && String(portRaw).trim() !== "" ? Number.parseInt(String(portRaw), 10) : 8765;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      log.error("Overlay", `Invalid port ${portRaw}, fallback to 8765`);
    }
    const effectivePort = Number.isFinite(port) && port > 0 && port <= 65535 ? port : 8765;
    const overlayTokenFile = path.join(DATA_DIR || path.resolve("data"), ".overlay-token");
    let resolvedToken = (process.env.OVERLAY_TOKEN || "").trim() || (OVERLAY.token || "").trim();
    if (resolvedToken && resolvedToken.length < 16) {
      log.warn("Overlay", "OVERLAY_TOKEN too short (<16) — ignoring insecure token");
      resolvedToken = "";
    }
    if (resolvedToken && resolvedToken.length >= 16) {
      cog._token = resolvedToken;
    } else {
      let fileToken = "";
      try {
        if (fs.existsSync(overlayTokenFile)) fileToken = fs.readFileSync(overlayTokenFile, "utf-8").trim();
      } catch {}
      if (fileToken && fileToken.length >= 16) {
        cog._token = fileToken;
        log.warn("Overlay", "Используется сохранённый токен из файла (OVERLAY_TOKEN не задан)");
      } else {
        const generated = crypto.randomBytes(24).toString("base64url");
        try {
          fs.mkdirSync(path.dirname(overlayTokenFile), { recursive: true });
          fs.writeFileSync(overlayTokenFile, generated + "\n", { mode: 0o600 });
          log.warn("Overlay", `Сгенерирован и сохранён OVERLAY_TOKEN в ${overlayTokenFile} — установите OVERLAY_TOKEN в .env для постоянства`);
        } catch (e) {
          log.warn("Overlay", "OVERLAY_TOKEN не задан — сгенерирован временный токен (перезапуск сменит токен, установите OVERLAY_TOKEN в .env)");
        }
        cog._token = generated;
      }
    }

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const path = url.pathname;
        const queryToken = url.searchParams.get("token") || "";
        const headerToken = req.headers["x-overlay-token"] || "";
        // Fix timingSafeEqual logic bug: check both tokens independently, don't fallback via ||
        const valid = timingSafeEqual(queryToken, cog._token) || timingSafeEqual(String(headerToken), cog._token);

        // Health check without auth (optional)
        if (path === "/overlay/health") {
          sendJson(res, { ok: true });
          return;
        }

        if (path === "/overlay" || path === "/overlay/") {
          if (!valid) {
            res.writeHead(401);
            res.end("Unauthorized");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(PAGE.replace("__TOKEN__", cog._token));
          return;
        }

        if (path === "/overlay/api") {
          if (!valid) {
            sendJson(res, { error: "unauthorized" }, 401);
            return;
          }
          const kickChannel = String((CONFIG.kick || {}).channel || "").trim();
          const rawCounters = kickChannel ? db.counterList(kickChannel).filter((c) => c.name !== "tod") : [];
          // sanitize counters — limit fields, no internal leaks
          const counters = rawCounters.slice(0, 50).map(c => ({
            name: String(c.name).slice(0, 64),
            value: typeof c.value === "number" ? c.value : String(c.value).slice(0, 64),
          }));
          const dg = OVERLAY.donation_goal || {};
          const stream = activeStream();
          // Fix PAYLOAD leaks and hardcoded donation_goal: don't expose full CHANNELS, sanitize donation_goal
          const donationGoalEnabled = !!dg.enabled;
          const safeDonationGoal = donationGoalEnabled ? {
            enabled: true,
            target: Number.isFinite(Number(dg.target)) ? Number(dg.target) : 0,
            currency: String(dg.currency || "₽").slice(0, 8),
            label: String(dg.label || "Донат-цель").slice(0, 64),
            current: Number.isFinite(Number(dg.current)) ? Number(dg.current) : 0,
          } : { enabled: false };
          // Only expose safe subset of CHANNELS, not full config
          const safeChannels = {};
          if (CHANNELS.twitch) safeChannels.twitch = String(CHANNELS.twitch).slice(0, 64);
          if (CHANNELS.kick) safeChannels.kick = String(CHANNELS.kick).slice(0, 64);
          if (CHANNELS.youtube) safeChannels.youtube = String(CHANNELS.youtube).slice(0, 64);

          const payload = {
            stream: stream
              ? {
                  platform: String(stream.platform).slice(0, 32),
                  live: !!stream.live,
                  viewers: Number.isFinite(stream.viewers) ? stream.viewers : 0,
                  peak: Number.isFinite(stream.peak) ? stream.peak : 0,
                  title: String(stream.title || "").slice(0, 200),
                  category: String(stream.category || "").slice(0, 100),
                  startedAt: stream.startedAt || null,
                  url: String(stream.url || "").slice(0, 300),
                }
              : null,
            channels: safeChannels,
            counters,
            donation_goal: safeDonationGoal,
          };
          sendJson(res, payload);
          return;
        }

        res.writeHead(404);
        res.end("Not Found");
      } catch (e) {
        log.error("Overlay", "Ошибка HTTP-запроса", e);
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });

    server.on("error", (e) => {
      if (e && e.code === "EADDRINUSE") {
        log.error("Overlay", `Порт ${effectivePort} уже занят — оверлей не запущен`);
      } else {
        log.error("Overlay", `Ошибка сервера оверлея`, e);
      }
      try { server.close(); } catch {}
      cog._server = null;
    });
    server.on("clientError", (err, socket) => {
      try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {}
    });

    server.listen(effectivePort, host, () => {
      log.info("Overlay", `Сервер запущен на http://${host}:${effectivePort}/overlay`);
    });

    cog._server = server;
  },
};

export default cog;
