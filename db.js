const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(__dirname, 'tracker.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  eventId TEXT PRIMARY KEY,
  calendarId TEXT NOT NULL DEFAULT 'primary',
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  markers TEXT NOT NULL DEFAULT '[]',
  start TEXT,
  end TEXT,
  sourceLegacy INTEGER NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pomodoro_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eventId TEXT,
  startedAt TEXT NOT NULL,
  endedAt TEXT,
  durationSec INTEGER,
  completed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS legacy_history (
  slotKey TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pomodoro_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL,
  cycleCount INTEGER NOT NULL,
  phaseDurationSec INTEGER NOT NULL,
  startedAt TEXT NOT NULL,
  eventId TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  pausedRemainingSec INTEGER,
  logId INTEGER
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT UNIQUE NOT NULL,
  subscription TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT,
  cluster TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_touch TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day DATE UNIQUE NOT NULL,
  projects_json TEXT NOT NULL DEFAULT '[]',
  energy INTEGER,
  note TEXT,
  tomorrow TEXT,
  voice_path TEXT,
  transcript TEXT,
  closed_at TEXT,
  source TEXT NOT NULL DEFAULT 'api'
);

CREATE TABLE IF NOT EXISTS parked_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  asked_at TEXT NOT NULL DEFAULT (datetime('now')),
  answer TEXT
);

CREATE TABLE IF NOT EXISTS dashboard_opens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  ua TEXT
);

CREATE TABLE IF NOT EXISTS obligations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day DATE UNIQUE NOT NULL,
  text TEXT NOT NULL,
  source_day DATE,
  outcome TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spice_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day DATE NOT NULL,
  connector TEXT NOT NULL,
  vote TEXT NOT NULL,
  voted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS day_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day DATE NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  slot TEXT,
  source TEXT,
  done TEXT,
  note TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_day_items_day ON day_items(day);

CREATE TABLE IF NOT EXISTS flags (
  key TEXT PRIMARY KEY,
  fired_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rituals (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE,
  emoji TEXT,
  mode TEXT,
  slot TEXT,
  cadence TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  enabled INTEGER DEFAULT 1,
  last_done DATE,
  streak INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS day_plans (
  id INTEGER PRIMARY KEY,
  day DATE UNIQUE,
  mode TEXT,
  md TEXT,
  html TEXT,
  data_json TEXT,
  generated_at TEXT,
  source TEXT
);

CREATE TABLE IF NOT EXISTS templates (
  name TEXT PRIMARY KEY,
  md TEXT,
  updated_at TEXT,
  updated_by TEXT
);
`);

// flags predates the `value` column (used to persist the one-time pickMode salt) — add it
// if missing, same idempotent pattern as the pomodoro_log columns below.
const flagsCols = db.prepare('PRAGMA table_info(flags)').all().map(c => c.name);
if (!flagsCols.includes('value')) db.exec('ALTER TABLE flags ADD COLUMN value TEXT');

// ---- 2026-08-05 day_items idempotency fix: UNIQUE(day, title, kind) ----
// generateDayItems() used to check "already generated?" before its one await
// (countMeetingsForDay), so two concurrent calls for the same day could both pass
// the check and both insert — duplicating the checklist. The index below is the
// actual guard (paired with a transaction + INSERT OR IGNORE in store.js); dedupe
// first because CREATE UNIQUE INDEX fails outright if exact duplicates already exist.
const dupDayItemGroups = db.prepare(
  'SELECT day, title, kind, MIN(id) as keepId FROM day_items GROUP BY day, title, kind HAVING COUNT(*) > 1'
).all();
if (dupDayItemGroups.length) {
  const delDup = db.prepare('DELETE FROM day_items WHERE day = ? AND title = ? AND kind = ? AND id != ?');
  const tx = db.transaction((groups) => { for (const g of groups) delDup.run(g.day, g.title, g.kind, g.keepId); });
  tx(dupDayItemGroups);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_day_items_day_title_kind ON day_items(day, title, kind)');

// ---- 2026-08-06 day_items timed reminders: due_at + notified_at ----
// due_at (ISO datetime, tz-qualified) = optional clock time for an item; the bot polls
// items with due_at set and pings ~15 min before. notified_at is the dedup marker (set
// atomically when the ping is claimed, same idea as the meeting-ping flag) so a restart
// mid-window can't double-push. Both nullable, idempotent ALTERs on every startup.
const dayItemsCols = db.prepare('PRAGMA table_info(day_items)').all().map(c => c.name);
if (!dayItemsCols.includes('due_at')) db.exec('ALTER TABLE day_items ADD COLUMN due_at TEXT');
if (!dayItemsCols.includes('notified_at')) db.exec('ALTER TABLE day_items ADD COLUMN notified_at TEXT');

// ---- 2026-08-05 taxonomy rework: 5 modes (hands/head/ears/body/magic) + rituals registry ----
// Idempotent — re-run safely on every startup. See schedule-tracker/CLAUDE.md and the
// cc/daybot-core task brief for the "why" (KB/Skills retired, body+magic modes added).

const RETIRED_PROJECTS = ['KB (Craft)', 'Skills/агенти'];
const retireProject = db.prepare("UPDATE projects SET status = 'dead' WHERE name = ? AND status != 'dead'");
for (const name of RETIRED_PROJECTS) retireProject.run(name);

const NEW_PROJECTS = [
  { name: 'Заняття на музичному інструменті', emoji: '🎸', cluster: 'body', mode: 'body' },
  { name: 'Таро: записи', emoji: '📓', cluster: 'tarot', mode: 'magic' },
  { name: 'Таро: сесія', emoji: '🃏', cluster: 'tarot', mode: 'magic' },
];
const insertProjectIfMissing = db.prepare(`
  INSERT INTO projects (name, emoji, cluster, mode) SELECT ?, ?, ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM projects WHERE name = ?)
`);
for (const p of NEW_PROJECTS) insertProjectIfMissing.run(p.name, p.emoji, p.cluster, p.mode, p.name);

const RITUAL_SEED = [
  { name: 'Чистка зубів', emoji: '🦷', mode: 'body', slot: 'morning', cadence: 'daily' },
  { name: 'Спорт', emoji: '🏃', mode: 'body', slot: null, cadence: 'weekly:3' },
  { name: 'Підтягування', emoji: '💪', mode: 'body', slot: null, cadence: 'weekly:4' },
  { name: 'Поїсти нормально', emoji: '🍲', mode: 'body', slot: null, cadence: 'daily' },
  { name: 'Повідпочивати', emoji: '🛋', mode: 'body', slot: null, cadence: 'weekly:5' },
  { name: 'Відпочити', emoji: '😴', mode: 'body', slot: 'evening', cadence: 'daily' },
  { name: 'Пограти в компʼютер', emoji: '🎮', mode: 'head', slot: null, cadence: 'weekly:3' },
  { name: 'Таро: день', emoji: '🔮', mode: 'magic', slot: 'morning', cadence: 'daily' },
];
const insertRitual = db.prepare(`
  INSERT INTO rituals (name, emoji, mode, slot, cadence, created_at)
  VALUES (@name, @emoji, @mode, @slot, @cadence, datetime('now'))
  ON CONFLICT(name) DO NOTHING
`);
for (const r of RITUAL_SEED) insertRitual.run(r);

// Legacy config/baseline.json + config/habits.json → rituals, one time only, mapped onto
// the seed above where an equivalent already exists (avoids near-duplicate names like
// "Почистити зуби" vs "Чистка зубів"). Files themselves stay untouched on disk (legacy).
const BASELINE_RITUAL_ALIAS = {
  'Почистити зуби': 'Чистка зубів',
  'Поїсти нормально': 'Поїсти нормально',
  'Пограти в компʼютер': 'Пограти в компʼютер',
  'Підтягування': 'Підтягування',
};
function migrateLegacyConfigToRituals() {
  const already = db.prepare("SELECT value FROM flags WHERE key = 'legacy_config_migrated'").get();
  if (already) return;
  try {
    const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'baseline.json'), 'utf8'));
    for (const text of Array.isArray(baseline) ? baseline : []) {
      const aliasName = BASELINE_RITUAL_ALIAS[text] || text;
      insertRitual.run({ name: aliasName, emoji: null, mode: 'head', slot: null, cadence: 'daily' });
    }
  } catch (err) { /* baseline.json missing/unreadable — nothing to migrate */ }
  try {
    const habits = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'habits.json'), 'utf8'));
    for (const h of Array.isArray(habits) ? habits : []) {
      if (!h || !h.title) continue;
      insertRitual.run({ name: h.title, emoji: null, mode: 'head', slot: h.slot || null, cadence: 'daily' });
    }
  } catch (err) { /* habits.json missing/unreadable — nothing to migrate */ }
  db.prepare("INSERT OR REPLACE INTO flags (key, value, fired_at) VALUES ('legacy_config_migrated', '1', datetime('now'))").run();
}
migrateLegacyConfigToRituals();

// Seed the day-plan template from config/day-template.md the first time this table is
// empty for name='day' — after that the DB row is the source of truth (see template.js).
function seedDayTemplate() {
  const existing = db.prepare("SELECT 1 FROM templates WHERE name = 'day'").get();
  if (existing) return;
  try {
    const md = fs.readFileSync(path.join(__dirname, 'config', 'day-template.md'), 'utf8');
    db.prepare("INSERT INTO templates (name, md, updated_at, updated_by) VALUES ('day', ?, datetime('now'), 'seed')").run(md);
  } catch (err) { /* config/day-template.md missing — leave templates empty, template.js handles fallback */ }
}
seedDayTemplate();

// Seed the project map once — the old Craft "Меню дня — ротація тем" doc is retired in
// favor of this table (see Phase 1 of the 2026-07-31 rewrite). Emoji doubles as a cluster
// tag within `head` (💻 general software/agents, 🖥 CAD-adjacent).
const PROJECT_SEED = [
  { name: 'Embedded (Lilka+Raspberry)', emoji: '🔌', cluster: 'hands', mode: 'hands' },
  { name: 'Паяльник/ремонт', emoji: '🔌', cluster: 'hands', mode: 'hands' },
  { name: 'Задній двір/фізична робота', emoji: '🔌', cluster: 'hands', mode: 'hands' },
  { name: 'KB (Craft)', emoji: '💻', cluster: 'software', mode: 'head' },
  { name: 'Skills/агенти', emoji: '💻', cluster: 'software', mode: 'head' },
  { name: 'Livecoding Hydra/Strudel', emoji: '💻', cluster: 'software', mode: 'head' },
  { name: "Кар'єра (пошук роботи/інтерв'ю/резюме/портфоліо)", emoji: '💻', cluster: 'software', mode: 'head' },
  { name: 'AV-проєкти (lumen-engine, sonargale, VR, EarForge)', emoji: '💻', cluster: 'software', mode: 'head' },
  { name: 'Контент (курс Bitwig, релізи, канал)', emoji: '💻', cluster: 'software', mode: 'head' },
  { name: 'Onshape/Blender', emoji: '🖥', cluster: 'cad', mode: 'head' },
  { name: 'Альбом — мастеринг', emoji: '🎛', cluster: 'mastering', mode: 'ears' },
  { name: 'Деки/діджеїнг', emoji: '🎧', cluster: 'dj', mode: 'ears' },
];

function seedProjects() {
  const count = db.prepare('SELECT COUNT(*) as n FROM projects').get().n;
  if (count > 0) return 0;
  const insert = db.prepare('INSERT INTO projects (name, emoji, cluster, mode) VALUES (?, ?, ?, ?)');
  const tx = db.transaction((rows) => { for (const r of rows) insert.run(r.name, r.emoji, r.cluster, r.mode); });
  tx(PROJECT_SEED);
  return PROJECT_SEED.length;
}
seedProjects();

// pomodoro_log predates the phase/cycleCount columns — add them if missing (idempotent across restarts).
const pomodoroLogCols = db.prepare("PRAGMA table_info(pomodoro_log)").all().map(c => c.name);
if (!pomodoroLogCols.includes('phase')) db.exec("ALTER TABLE pomodoro_log ADD COLUMN phase TEXT");
if (!pomodoroLogCols.includes('cycleCount')) db.exec("ALTER TABLE pomodoro_log ADD COLUMN cycleCount INTEGER");

function importLegacy(legacyPath) {
  const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  const insert = db.prepare('INSERT OR REPLACE INTO legacy_history (slotKey, date, status) VALUES (?, ?, ?)');
  const tx = db.transaction((entries) => {
    for (const [slotKey, status] of entries) {
      const date = slotKey.split(/_{1,2}/)[0];
      insert.run(slotKey, date, status);
    }
  });
  tx(Object.entries(raw));
  return Object.keys(raw).length;
}

module.exports = { db, importLegacy };
