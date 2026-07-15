require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const fs = require('fs');
const express = require('express');
const path = require('path');
const { db, importLegacy } = require('./db');
const { calendarByDate, setEventStatus, setEventMarkers, createTask, deleteTask, rescheduleTask } = require('./calendar');
const { exchangeCode } = require('./auth');
const pomodoro = require('./pomodoro');

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
    // Markers live in extendedProperties on the Calendar event, but the public iCal feed
    // we read from doesn't expose those — the tasks table mirror is the only place we can
    // read them back from without burning Calendar API quota on every list request.
    const markersByEventId = {};
    for (const row of db.prepare('SELECT eventId, markers FROM tasks').all()) {
      try { markersByEventId[row.eventId] = JSON.parse(row.markers || '[]'); } catch (e) { markersByEventId[row.eventId] = []; }
    }
    for (const dateKey in byDate) {
      for (const ev of byDate[dateKey]) ev.markers = markersByEventId[ev.uid] || [];
    }
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

app.post('/schedule-tracker-api/task', async (req, res) => {
  const { title, start, end } = req.body || {};
  if (!title || !start || !end) return res.status(400).json({ error: 'title, start, end required' });
  try {
    const data = await createTask({ title, start, end });
    res.json({ ok: true, id: data.id, iCalUID: data.iCalUID });
  } catch (err) {
    res.status(502).json({ error: 'create failed', detail: err.message });
  }
});

app.delete('/schedule-tracker-api/task/:uid', async (req, res) => {
  const { start } = req.query;
  if (!start) return res.status(400).json({ error: 'start query param required to resolve the instance' });
  try {
    await deleteTask(req.params.uid, start);
    db.prepare('DELETE FROM tasks WHERE eventId = ?').run(req.params.uid);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'delete failed', detail: err.message });
  }
});

app.patch('/schedule-tracker-api/task/:uid', async (req, res) => {
  const { start, newStart, newEnd } = req.body || {};
  if (!start || !newStart || !newEnd) return res.status(400).json({ error: 'start, newStart, newEnd required' });
  try {
    await rescheduleTask(req.params.uid, start, newStart, newEnd);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'reschedule failed', detail: err.message });
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

app.get('/schedule-tracker-api/pomodoro/active', (req, res) => {
  const st = pomodoro.checkAndAdvance(true);
  res.json(pomodoro.stateToJson(st));
});

app.post('/schedule-tracker-api/pomodoro/start', (req, res) => {
  const { uid } = req.body || {};
  const st = pomodoro.startCycle(uid || null);
  res.json(pomodoro.stateToJson(st));
});

app.post('/schedule-tracker-api/pomodoro/stop', (req, res) => {
  const { completed } = req.body || {};
  pomodoro.stopCycle(!!completed);
  res.json({ ok: true });
});

app.post('/schedule-tracker-api/pomodoro/pause', (req, res) => {
  const st = pomodoro.pauseCycle();
  res.json(pomodoro.stateToJson(st));
});

app.post('/schedule-tracker-api/pomodoro/resume', (req, res) => {
  const st = pomodoro.resumeCycle();
  res.json(pomodoro.stateToJson(st));
});

app.post('/schedule-tracker-api/pomodoro/skip', (req, res) => {
  const st = pomodoro.skipPhase();
  res.json(pomodoro.stateToJson(st));
});

app.get('/schedule-tracker-api/pomodoro/log', (req, res) => {
  const rows = db.prepare('SELECT * FROM pomodoro_log ORDER BY startedAt DESC LIMIT 200').all();
  res.json(rows);
});

app.get('/schedule-tracker-api/pomodoro/focus-summary', (req, res) => {
  const { from, to } = req.query;
  const rows = db.prepare(`
    SELECT eventId, SUM(durationSec) as totalSec, COUNT(*) as sessions
    FROM pomodoro_log
    WHERE phase = 'work' AND durationSec IS NOT NULL AND eventId IS NOT NULL
      AND (? IS NULL OR startedAt >= ?) AND (? IS NULL OR startedAt <= ?)
    GROUP BY eventId
    ORDER BY totalSec DESC
  `).all(from || null, from || null, to || null, to || null);
  res.json(rows);
});

app.get('/schedule-tracker-api/push/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

app.post('/schedule-tracker-api/push/subscribe', (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'subscription required' });
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, subscription) VALUES (?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription
  `).run(subscription.endpoint, JSON.stringify(subscription));
  res.json({ ok: true });
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

// Advances pomodoro phases (and fires push notifications) even when nobody is
// polling /pomodoro/active — otherwise "start on phone, walk away" never notifies.
setInterval(() => pomodoro.checkAndAdvance(true), 5000);

// Keeps the event loop alive under process supervisors (systemd) that were
// observed letting the loop drain immediately after listen() despite the
// active server handle.
setInterval(() => {}, 1 << 30);
