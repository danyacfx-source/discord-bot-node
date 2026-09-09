import http from "node:http";
import crypto from "node:crypto";
import { OVERLAY, CONFIG } from "../config.js";
import * as db from "../db.js";
import { log } from "../notify.js";

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
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
.card h3{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#a7a9be;margin-bottom:6px}
.card .value{font-size:16px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.card .empty{color:#6a6c82;font-size:14px}
.counters{font-size:14px;line-height:1.6}.counters b{color:#f1c40f}
</style></head><body><div id="root"></div>
<script>
async function load(){try{const r=await fetch('/overlay/api?token=__TOKEN__');const d=await r.json();let h='';
if(d.counters&&d.counters.length){h+='<div class="card"><h3>📦 Счётчики</h3><div class="counters">';for(const c of d.counters)h+='<div><b>'+esc(c.name)+'</b>: '+c.value+'</div>';h+='</div></div>'}
if(d.donation_goal&&d.donation_goal.enabled){h+='<div class="card"><h3>💰 '+esc(d.donation_goal.label)+'</h3><div class="value">'+d.donation_goal.current+' / '+d.donation_goal.target+' '+esc(d.donation_goal.currency)+'</div></div>'}
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
    const port = Number(process.env.OVERLAY_PORT) || OVERLAY.port || 8765;
    cog._token = process.env.OVERLAY_TOKEN || OVERLAY.token || crypto.randomBytes(24).toString("base64url");

    const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(host);

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const path = url.pathname;
        const queryToken = url.searchParams.get("token") || "";
        const headerToken = req.headers["x-overlay-token"] || "";
        const valid = timingSafeEqual(queryToken || headerToken, cog._token);

        if (path === "/overlay" || path === "/overlay/") {
          if (!isLoopback && !valid) {
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
          const kickChannel = (CONFIG.kick || {}).channel || "";
          const counters = db.counterList(kickChannel).filter((c) => c.name !== "tod");
          const dg = OVERLAY.donation_goal || {};
          const payload = {
            counters,
            donation_goal: {
              enabled: !!dg.enabled,
              target: dg.target || 0,
              currency: dg.currency || "₽",
              label: dg.label || "Донат-цель",
              current: 0,
            },
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

    server.listen(port, host, () => {
      log.info("Overlay", `Сервер запущен на http://${host}:${port}/overlay`);
    });

    server.on("error", (e) => {
      log.error("Overlay", `Не удалось занять порт ${port}`, e);
    });

    cog._server = server;
  },
};

export default cog;
