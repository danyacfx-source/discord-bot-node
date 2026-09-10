import Database from "better-sqlite3";
import { DB_PATH } from "./config.js";

let db;

function initDb() {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 10000");
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
  migrateIdColumnsToText();
  db.exec("CREATE INDEX IF NOT EXISTS idx_members_guild_points ON members (guild_id, points DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_season_members_guild_points ON season_members (guild_id, points DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_counters_channel ON counters (channel)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_giveaways_status ON giveaways (status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_giveaways_message ON giveaways (message_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_giveaways_end ON giveaways (end_time)");
}

// Снежинки Discord > 2^53 не помещаются в JS Number без потери точности.
// Если БД создалась со старыми INTEGER-колонками — мигрируем их в TEXT (CAST точен на стороне SQLite).
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
  for (const { table, cols, create, cast } of migrations) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!info.length) continue;
    const needsMigrate = info.some((c) => cols.includes(c.name) && c.type.toUpperCase() !== "TEXT");
    if (!needsMigrate) continue;
    const old = `${table}__old`;
    db.exec(`ALTER TABLE ${table} RENAME TO ${old}`);
    db.exec(create);
    db.exec(`INSERT INTO ${table} SELECT ${cast} FROM ${old}`);
    db.exec(`DROP TABLE ${old}`);
  }
}
initDb();

export function addMessage(guild_id, user_id) {
  db.prepare(
    `INSERT INTO members (guild_id, user_id, points)
     VALUES (?, ?, 1)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET points = points + 1`
  ).run(guild_id, user_id);
  return db
    .prepare("SELECT points FROM members WHERE guild_id = ? AND user_id = ?")
    .get(guild_id, user_id);
}

export function getPoints(guild_id, user_id) {
  const row = getStats(guild_id, user_id);
  return row ? row.points : 0;
}

export function getStats(guild_id, user_id) {
  return db
    .prepare("SELECT points FROM members WHERE guild_id = ? AND user_id = ?")
    .get(guild_id, user_id);
}

export function getLeaderboard(guild_id, limit = 10) {
  return db
    .prepare("SELECT user_id, points FROM members WHERE guild_id = ? ORDER BY points DESC LIMIT ?")
    .all(guild_id, limit);
}

export function counterGet(channel, name) {
  const row = db.prepare("SELECT value FROM counters WHERE channel = ? AND name = ?").get(channel, name);
  return row ? row.value : 0;
}

export function counterAdd(channel, name, delta) {
  db.prepare(
    `INSERT INTO counters (channel, name, value) VALUES (?, ?, ?)
     ON CONFLICT(channel, name) DO UPDATE SET value = value + ?`
  ).run(channel, name, delta, delta);
  return db.prepare("SELECT value FROM counters WHERE channel = ? AND name = ?").get(channel, name).value;
}

export function counterList(channel) {
  return db
    .prepare("SELECT name, value FROM counters WHERE channel = ? ORDER BY value DESC")
    .all(channel);
}

export function seasonReset(guild_id) {
  db.prepare("DELETE FROM season_members WHERE guild_id = ?").run(guild_id);
}

export function seasonAddMessage(guild_id, user_id) {
  db.prepare(
    `INSERT INTO season_members (guild_id, user_id, points)
     VALUES (?, ?, 1)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET points = points + 1`
  ).run(guild_id, user_id);
}

export function getSeasonLeaderboard(guild_id, limit = 10) {
  return db
    .prepare("SELECT user_id, points FROM season_members WHERE guild_id = ? ORDER BY points DESC LIMIT ?")
    .all(guild_id, limit);
}

export function birthdaySet(user_id, month, day) {
  db.prepare(
    `INSERT INTO birthdays (user_id, month, day) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET month = ?, day = ?`
  ).run(user_id, month, day, month, day);
}

export function birthdayGet(user_id) {
  return db.prepare("SELECT month, day FROM birthdays WHERE user_id = ?").get(user_id);
}

export function birthdayRemove(user_id) {
  db.prepare("DELETE FROM birthdays WHERE user_id = ?").run(user_id);
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
    channel_id: row.channel_id,
    guild_id: row.guild_id,
    message_id: row.message_id === "0" ? 0 : row.message_id,
    author_id: row.author_id,
    min_days: row.min_days,
    participants: row.participants,
    status: row.status,
  };
}

export function giveawaySave(ga) {
  db.prepare(
    `INSERT INTO giveaways
     (id, title, prize, description, winner_count, end_time, channel_id,
      guild_id, message_id, author_id, min_days, participants, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       end_time = excluded.end_time,
       message_id = excluded.message_id,
       participants = excluded.participants,
       status = excluded.status`
  ).run(
    ga.id,
    ga.title,
    ga.prize,
    ga.description,
    ga.winner_count,
    ga.end_time,
    ga.channel_id,
    ga.guild_id,
    ga.message_id || 0,
    ga.author_id || 0,
    ga.min_days || 0,
    ga.participants_json || "[]",
    ga.status || "active"
  );
}

export function giveawaysLoadActive() {
  const rows = db
    .prepare(`SELECT ${GIVEAWAY_COLS} FROM giveaways WHERE status = 'active'`)
    .all();
  return rows.map(rowToGiveaway);
}

export function giveawaysFindByMessage(message_id) {
  const row = db
    .prepare(`SELECT ${GIVEAWAY_COLS} FROM giveaways WHERE message_id = ?`)
    .get(message_id);
  return rowToGiveaway(row);
}

export function giveawayNextId() {
  const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM giveaways").get();
  return row ? Number(row.m) : 0;
}

export function giveawaySetParticipants(giveaway_id, participants, status = "active") {
  db.prepare("UPDATE giveaways SET participants = ?, status = ? WHERE id = ?").run(
    JSON.stringify(participants),
    status,
    giveaway_id
  );
}

export function kvGet(key) {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function kvSet(key, value) {
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

export function kvDelete(key) {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
}

export { db };