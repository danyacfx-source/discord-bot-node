// Тест потребления ОЗУ: загружает все коги (как в dry-run), затем меряет память.
// Запуск:  node scripts/ramtest.js [--seconds N] [--interval MS]
// С мусором: node --trace-gc scripts/ramtest.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const COGS_DIR = path.join(ROOT, "src", "cogs");

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  return Number(process.argv[i + 1]) || dflt;
}

const SECONDS = arg("seconds", 8);
const INTERVAL_MS = arg("interval", 1000);

const fmt = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function loadCogs() {
  const files = fs.readdirSync(COGS_DIR).filter((f) => f.endsWith(".js") && !f.startsWith("_"));
  files.sort();
  for (const f of files) {
    await import(pathToFileURL(path.join(COGS_DIR, f)).href);
  }
  return files.length;
}

console.log("Загружаю модули и коги (БД, все зависимости)...");
const count = await loadCogs();
const loaded = process.memoryUsage();

const samples = [];
const marker = { rss: 0, heap: 0, ext: 0 };
let peakRss = 0;
let peakHeap = 0;

const started = Date.now();
while (Date.now() - started < SECONDS * 1000) {
  const m = process.memoryUsage();
  const sample = {
    at: ((Date.now() - started) / 1000).toFixed(1),
    rss: m.rss,
    heapUsed: m.heapUsed,
    external: m.external,
    arrayBuffers: m.arrayBuffers ?? 0,
  };
  samples.push(sample);
  peakRss = Math.max(peakRss, m.rss);
  peakHeap = Math.max(peakHeap, m.heapUsed);
  console.log(
    `  ${sample.at.padStart(5)}s  RSS=${fmt(sample.rss).padStart(8)}  heapUsed=${fmt(sample.heapUsed).padStart(8)}  external=${fmt(sample.external).padStart(8)}  arrayBuffers=${fmt(sample.arrayBuffers).padStart(8)}`
  );
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

const last = samples[samples.length - 1] || {};
const avgRss = samples.reduce((s, x) => s + x.rss, 0) / (samples.length || 1);
const avgHeap = samples.reduce((s, x) => s + x.heapUsed, 0) / (samples.length || 1);

console.log("\n=== ИТОГ (после загрузки когов) ===");
console.log(`Когов загружено: ${count}`);
console.log(`Память сразу после импорта:  RSS=${fmt(loaded?.rss).padStart(8)}  heap=${fmt(loaded?.heapUsed).padStart(8)}`);
console.log(`Финал:                        RSS=${fmt(last.rss).padStart(8)}  heap=${fmt(last.heapUsed).padStart(8)}`);
console.log(`Пик RSS:                      ${fmt(peakRss)}  (средняя RSS=${fmt(avgRss)})`);
console.log(`Пик heapUsed:                 ${fmt(peakHeap)}  (средняя heap=${fmt(avgHeap)})`);