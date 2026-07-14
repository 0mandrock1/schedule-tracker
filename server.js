const fs = require('fs');
const express = require('express');
const path = require('path');
const { db, importLegacy } = require('./db');
const { calendarByDate, setEventStatus, setEventMarkers } = require('./calendar');
const { exchangeCode } = require('./auth');

const TOKEN_FILE = path.join(__dirname, 'config', 'token.json');

const PORT = process.env.PORT || 3463;
const PASSCODE = process.env.SCHEDULE_PASSCODE || '';

const app = express();
app.use(express.json());

function requirePasscode(req, res, next) {
  if (!PASSCODE) return next();
  const supplied = req.get('x-passcode') || req.query.passcode;
  if (supplied === PASSCODE) return next();
  res.status(401).json({ error: 'passcode required' });
}

app.use('/schedule-tracker-api', requirePasscode);

app.get('/schedule-tracker-api/calendar', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from/to required (YYYY-MM-DD)' });
  try {
    const byDate = await calendarByDate(from, to);
    res.json(byDate);
  } catch (err) {
    res.status(502).json({ error: 'calendar fetch failed', detail: err.message });
  }
});

app.post('/schedule-tracker-api/status', async (req, res) => {
  const { uid, start, status } = req.body || {};
  if (!uid || !start || !['pending', 'done', 'skipped'].includes(status)) {
    return res.status(400).json({ error: 'uid, start, status(pending|done|skipped) required' });
  }
  try {
    await setEventStatus(uid, start, status);
    db.prepare(`
      INSERT INTO tasks (eventId, title, status, start, sourceLegacy, updatedAt)
      VALUES (?, '', ?, ?, 0, datetime('now'))
      ON CONFLICT(eventId) DO UPDATE SET status = excluded.status, updatedAt = excluded.updatedAt
    `).run(uid, status, start);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'update failed', detail: err.message });
  }
});

app.post('/schedule-tracker-api/markers', async (req, res) => {
  const { uid, start, markers } = req.body || {};
  if (!uid || !start || !Array.isArray(markers)) {
    return res.status(400).json({ error: 'uid, start, markers[] required' });
  }
  try {
    await setEventMarkers(uid, start, markers);
    db.prepare(`
      INSERT INTO tasks (eventId, title, markers, start, sourceLegacy, updatedAt)
      VALUES (?, '', ?, ?, 0, datetime('now'))
      ON CONFLICT(eventId) DO UPDATE SET markers = excluded.markers, updatedAt = excluded.updatedAt
    `).run(uid, JSON.stringify(markers), start);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'update failed', detail: err.message });
  }
});

app.get('/schedule-tracker-api/counter', (req, res) => {
  const { from, to } = req.query;
  const liveRows = db.prepare(`
    SELECT status, COUNT(*) as n FROM tasks
    WHERE (? IS NULL OR start >= ?) AND (? IS NULL OR start <= ?)
    GROUP BY status
  `).all(from || null, from || null, to || null, to || null);
  const legacyRows = db.prepare(`
    SELECT status, COUNT(*) as n FROM legacy_history
    WHERE (? IS NULL OR date >= ?) AND (? IS NULL OR date <= ?)
    GROUP BY status
  `).all(from || null, from || null, to || null, to || null);
  res.json({ live: liveRows, legacy: legacyRows });
});

app.get('/schedule-tracker-api/legacy-history', (req, res) => {
  const rows = db.prepare('SELECT slotKey, date, status FROM legacy_history ORDER BY date').all();
  res.json(rows);
});

app.post('/schedule-tracker-api/pomodoro/start', (req, res) => {
  const { uid } = req.body || {};
  const info = db.prepare('INSERT INTO pomodoro_log (eventId, startedAt) VALUES (?, datetime(\'now\'))').run(uid || null);
  res.json({ id: info.lastInsertRowid });
});

app.post('/schedule-tracker-api/pomodoro/:id/finish', (req, res) => {
  const { completed } = req.body || {};
  const row = db.prepare('SELECT startedAt FROM pomodoro_log WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare(`
    UPDATE pomodoro_log SET endedAt = datetime('now'), completed = ?,
    durationSec = CAST((julianday(datetime('now')) - julianday(startedAt)) * 86400 AS INTEGER)
    WHERE id = ?
  `).run(completed ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.get('/schedule-tracker-api/pomodoro/log', (req, res) => {
  const rows = db.prepare('SELECT * FROM pomodoro_log ORDER BY startedAt DESC LIMIT 200').all();
  res.json(rows);
});

app.get('/oauth/callback', async (req, res) => {
  if (fs.existsSync(TOKEN_FILE)) {
    return res.status(403).send('Already authorized. Delete config/token.json on the server to re-run setup.');
  }
  const { code, error } = req.query;
  if (error) return res.status(400).send(`OAuth error: ${error}`);
  if (!code) return res.status(400).send('Missing code');
  try {
    const tokens = await exchangeCode(code);
    res.send(`OAuth ok. refresh_token saved: ${!!tokens.refresh_token}. You can close this tab.`);
  } catch (err) {
    res.status(500).send(`Exchange failed: ${err.message}`);
  }
});

app.use('/schedule-tracker', express.static(path.join(__dirname, 'public')));

app.listen(PORT, '127.0.0.1', () => {
  const legacyCount = importLegacy(path.join(__dirname, 'legacy-import.json'));
  console.log(`schedule-tracker listening on ${PORT}, imported ${legacyCount} legacy entries`);
});

// Keeps the event loop alive under process supervisors (systemd) that were
// observed letting the loop drain immediately after listen() despite the
// active server handle.
setInterval(() => {}, 1 << 30);
