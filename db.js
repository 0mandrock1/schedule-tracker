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
`);

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
