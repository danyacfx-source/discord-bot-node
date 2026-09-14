import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "./config.js";

// Singleton guard: survive ?pre= cache-bust re-imports (main.js pre-loads cogs with ?pre=)
// Ensures initDb not called twice when imported via ?pre= trick — use globalThis singleton
let db = globalThis.__botDb ?? null;
let _initialized = Boolean(globalThis.__botDb);

function ensureDirForFile(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
  } catch (e) {
    console.error(`[db] cannot create directory for ${filePath}:`, e.message);
  }
}

function initDb() {
  if (_initialized && db) return db;
  if (globalThis.__botDb) {
    db = globalThis.__botDb;
    _initialized = true;
    return db;
  }
  ensureDirForFile(DB_PATH);
  try {
    db = new Database(DB_PATH);
  } catch (e) {
    console.error(`[db] failed to open ${DB_PATH}:`, e.message);
    // Try to recover: rename corrupt file and create new
    // Windows EPERM/EBUSY if file is still open — fallback to copy+unlink
    try {
      const bak = `${DB_PATH}.corrupt.${Date.now()}`;
      try {
        fs.renameSync(DB_PATH, bak);
      } catch (renErr) {
        if (renErr.code === "EPERM" || renErr.code === "EBUSY" || renErr.code === "EACCES" || renErr.code === "EPERM") {
          console.warn(`[db] rename failed (${renErr.code}), trying copy+unlink fallback`);
          try {
            // Ensure DB is not open elsewhere; close any handle if needed
            try { if (db && typeof db.close === "function") db.close(); } catch {}
            fs.copyFileSync(DB_PATH, bak);
            try { fs.unlinkSync(DB_PATH); } catch (unlinkErr) {
              console.error(`[db] unlink after copy failed:`, unlinkErr.message);
              throw unlinkErr;
            }
          } catch (copyErr) {
            throw new Error(`rename+copy recovery failed: ${copyErr.message} (orig: ${renErr.message})`);
          }
        } else {
          throw renErr;
        }
      }
      console.error(`[db] renamed corrupt DB to ${bak}, creating fresh DB`);
      db = new Database(DB_PATH);
    } catch (e2) {
      throw new Error(`[db] cannot open or recover DB: ${e2.message}`);
    }
  }
  try {
    const jm = db.pragma("journal_mode = WAL", { simple: true });
    if (String(jm).toUpperCase() !== "WAL") {
      console.warn(`[db] journal_mode WAL not enabled, got ${jm} — synchronous will use FULL`);
    }
    db.pragma("busy_timeout = 10000");
    db.pragma("foreign_keys = ON");
    const syncMode = String(jm).toUpperCase() === "WAL" ? "NORMAL" : "FULL";
    db.pragma(`synchronous = ${syncMode}`);
  } catch (e) {
    console.warn("[db] pragma failed:", e.message);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS members (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS counters (
    channel TEXT NOT NULL,
    name TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel, name)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS season_members (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS birthdays (
    user_id TEXT PRIMARY KEY,
    month INTEGER NOT NULL,
    day INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS giveaways (
    id INTEGER PRIMARY KEY,
    title TEXT,
    prize TEXT,
    description TEXT,
    winner_count INTEGER,
    end_time REAL,
    channel_id TEXT,
    guild_id TEXT,
    message_id TEXT,
    author_id TEXT,
    min_days INTEGER DEFAULT 0,
    participants TEXT DEFAULT '[]',
    status TEXT DEFAULT 'active'
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  try {
    migrateIdColumnsToText();
  } catch (e) {
    console.error("[db] migration failed:", e.message);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_members_guild_points ON members (guild_id, points DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_season_members_guild_points ON season_members (guild_id, points DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_counters_channel ON counters (channel)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_giveaways_status ON giveaways (status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_giveaways_message ON giveaways (message_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_giveaways_end ON giveaways (end_time)");

  // Graceful checkpoint on exit — ensure WAL is checkpointed
  const checkpoint = () => {
    try {
      if (db && db.open) db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (e) {
      console.warn("[db] checkpoint failed:", e.message);
    }
  };
  process.once("exit", checkpoint);
  process.once("SIGINT", () => { checkpoint(); process.exit(0); });
  process.once("SIGTERM", () => { checkpoint(); process.exit(0); });

  globalThis.__botDb = db;
  _initialized = true;
  return db;
}

const ALLOWED_TABLES = new Set(["members", "season_members", "birthdays", "giveaways"]);
function assertTable(name) {
  if (!ALLOWED_TABLES.has(name)) throw new Error(`invalid table: ${name}`);
  return `"${name.replaceAll('"', '""')}"`;
}

function migrateIdColumnsToText() {
  const migrations = [
    {
      table: "members",
      cols: ["guild_id", "user_id"],
      create: `CREATE TABLE members (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        points INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      )`,
      cast: "CAST(guild_id AS TEXT), CAST(user_id AS TEXT), points",
    },
    {
      table: "season_members",
      cols: ["guild_id", "user_id"],
      create: `CREATE TABLE season_members (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        points INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      )`,
      cast: "CAST(guild_id AS TEXT), CAST(user_id AS TEXT), points",
    },
    {
      table: "birthdays",
      cols: ["user_id"],
      create: `CREATE TABLE birthdays (
        user_id TEXT PRIMARY KEY,
        month INTEGER NOT NULL,
        day INTEGER NOT NULL
      )`,
      cast: "CAST(user_id AS TEXT), month, day",
    },
    {
      table: "giveaways",
      cols: ["channel_id", "guild_id", "message_id", "author_id"],
      create: `CREATE TABLE giveaways (
        id INTEGER PRIMARY KEY,
        title TEXT,
        prize TEXT,
        description TEXT,
        winner_count INTEGER,
        end_time REAL,
        channel_id TEXT,
        guild_id TEXT,
        message_id TEXT,
        author_id TEXT,
        min_days INTEGER DEFAULT 0,
        participants TEXT DEFAULT '[]',
        status TEXT DEFAULT 'active'
      )`,
      cast: `id, title, prize, description, winner_count, end_time,
        CAST(channel_id AS TEXT), CAST(guild_id AS TEXT),
        CAST(message_id AS TEXT), CAST(author_id AS TEXT),
        min_days, participants, status`,
    },
  ];
  const doMigrate = db.transaction(() => {
    for (const { table, cols, create, cast } of migrations) {
      assertTable(table);
      const info = db.prepare(`PRAGMA table_info(${assertTable(table)})`).all();
      if (!info.length) continue;
      const needsMigrate = info.some((c) => cols.includes(c.name) && c.type.toUpperCase() !== "TEXT");
      if (!needsMigrate) continue;
      const old = `${table}__old_${Date.now()}`;
      db.exec(`ALTER TABLE ${assertTable(table)} RENAME TO ${assertTable(old)}`);
      db.exec(create);
      db.exec(`INSERT INTO ${assertTable(table)} SELECT ${cast} FROM ${assertTable(old)}`);
      db.exec(`DROP TABLE ${assertTable(old)}`);
    }
  });
  doMigrate();
}
if (!_initialized) initDb();

export function addMessage(guild_id, user_id) {
  const gid = String(guild_id);
  const uid = String(user_id);
  db.prepare(
    `INSERT INTO members (guild_id, user_id, points)
     VALUES (?, ?, 1)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET points = points + 1`
  ).run(gid, uid);
  return db
    .prepare("SELECT points FROM members WHERE guild_id = ? AND user_id = ?")
    .get(gid, uid);
}

export function getPoints(guild_id, user_id) {
  const row = getStats(guild_id, user_id);
  return row ? row.points : 0;
}

export function getStats(guild_id, user_id) {
  return db
    .prepare("SELECT points FROM members WHERE guild_id = ? AND user_id = ?")
    .get(String(guild_id), String(user_id));
}

export function getLeaderboard(guild_id, limit = 10) {
  const lim = Math.min(Math.max(Number(limit) || 10, 1), 100);
  return db
    .prepare("SELECT user_id, points FROM members WHERE guild_id = ? ORDER BY points DESC LIMIT ?")
    .all(String(guild_id), lim);
}

export function counterGet(channel, name) {
  const row = db.prepare("SELECT value FROM counters WHERE channel = ? AND name = ?").get(String(channel), String(name));
  return row ? row.value : 0;
}

export function counterAdd(channel, name, delta) {
  const ch = String(channel);
  const nm = String(name);
  const d = Number(delta) || 0;
  db.prepare(
    `INSERT INTO counters (channel, name, value) VALUES (?, ?, ?)
     ON CONFLICT(channel, name) DO UPDATE SET value = value + ?`
  ).run(ch, nm, d, d);
  return db.prepare("SELECT value FROM counters WHERE channel = ? AND name = ?").get(ch, nm).value;
}

export function counterList(channel) {
  return db
    .prepare("SELECT name, value FROM counters WHERE channel = ? ORDER BY value DESC")
    .all(String(channel));
}

export function seasonReset(guild_id) {
  db.prepare("DELETE FROM season_members WHERE guild_id = ?").run(String(guild_id));
}

export function seasonAddMessage(guild_id, user_id) {
  db.prepare(
    `INSERT INTO season_members (guild_id, user_id, points)
     VALUES (?, ?, 1)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET points = points + 1`
  ).run(String(guild_id), String(user_id));
}

export const seasonAddMessagesBatch = db.transaction((guild_id, userIds) => {
  const stmt = db.prepare(
    `INSERT INTO season_members (guild_id, user_id, points)
     VALUES (?, ?, 1)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET points = points + 1`
  );
  const gid = String(guild_id);
  for (const uid of userIds) stmt.run(gid, String(uid));
});

export function getSeasonLeaderboard(guild_id, limit = 10) {
  const lim = Math.min(Math.max(Number(limit) || 10, 1), 100);
  return db
    .prepare("SELECT user_id, points FROM season_members WHERE guild_id = ? ORDER BY points DESC LIMIT ?")
    .all(String(guild_id), lim);
}

export function birthdaySet(user_id, month, day) {
  db.prepare(
    `INSERT INTO birthdays (user_id, month, day) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET month = excluded.month, day = excluded.day`
  ).run(String(user_id), Number(month), Number(day));
}

export function birthdayGet(user_id) {
  return db.prepare("SELECT month, day FROM birthdays WHERE user_id = ?").get(String(user_id));
}

export function birthdayRemove(user_id) {
  db.prepare("DELETE FROM birthdays WHERE user_id = ?").run(String(user_id));
}

export function birthdaysAll() {
  return db.prepare("SELECT user_id, month, day FROM birthdays").all();
}

const GIVEAWAY_COLS =
  "id, title, prize, description, winner_count, end_time, channel_id, guild_id, message_id, author_id, min_days, participants, status";

function rowToGiveaway(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    prize: row.prize,
    description: row.description,
    winner_count: row.winner_count,
    end_time: row.end_time,
    channel_id: row.channel_id ? String(row.channel_id) : null,
    guild_id: row.guild_id ? String(row.guild_id) : null,
    message_id: row.message_id ? String(row.message_id) : null,
    author_id: row.author_id ? String(row.author_id) : null,
    min_days: row.min_days,
    participants: row.participants,
    status: row.status,
  };
}

export function giveawaySave(ga) {
  const toStr = (v) => (v == null || v === "" ? null : String(v));
  db.prepare(
    `INSERT INTO giveaways
     (id, title, prize, description, winner_count, end_time, channel_id,
      guild_id, message_id, author_id, min_days, participants, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        prize = excluded.prize,
        description = excluded.description,
        winner_count = excluded.winner_count,
        end_time = excluded.end_time,
        channel_id = excluded.channel_id,
        guild_id = excluded.guild_id,
        message_id = excluded.message_id,
        author_id = excluded.author_id,
        min_days = excluded.min_days,
        participants = excluded.participants,
        status = excluded.status`
  ).run(
    Number(ga.id),
    ga.title || null,
    ga.prize || null,
    ga.description || null,
    Number(ga.winner_count) || 1,
    Number(ga.end_time) || 0,
    toStr(ga.channel_id),
    toStr(ga.guild_id),
    toStr(ga.message_id),
    toStr(ga.author_id),
    Number(ga.min_days) || 0,
    ga.participants_json || (ga.participants ? JSON.stringify(ga.participants) : "[]"),
    ga.status || "active"
  );
}

export function giveawaysLoadActive() {
  const rows = db
    .prepare(`SELECT ${GIVEAWAY_COLS} FROM giveaways WHERE status = 'active' ORDER BY end_time ASC LIMIT 100`)
    .all();
  return rows.map(rowToGiveaway);
}

export function giveawaysFindByMessage(message_id) {
  const row = db
    .prepare(`SELECT ${GIVEAWAY_COLS} FROM giveaways WHERE message_id = ?`)
    .get(String(message_id));
  return rowToGiveaway(row);
}

export function giveawayNextId() {
  const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM giveaways").get();
  return row ? Number(row.m) + 1 : 1;
}

export function giveawaySetParticipants(giveaway_id, participants, status = "active") {
  db.prepare("UPDATE giveaways SET participants = ?, status = ? WHERE id = ?").run(
    JSON.stringify(participants || []),
    String(status),
    Number(giveaway_id)
  );
}

export function kvGet(key) {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(String(key));
  return row ? row.value : null;
}

export function kvSet(key, value) {
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(key), String(value));
}

export function kvDelete(key) {
  db.prepare("DELETE FROM kv WHERE key = ?").run(String(key));
}

export { db };
