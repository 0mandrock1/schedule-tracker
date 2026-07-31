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
`);

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
