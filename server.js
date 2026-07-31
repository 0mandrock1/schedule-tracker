require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db, importLegacy } = require('./db');
const { getMeetingsInRange } = require('./calendar');
const pomodoro = require('./pomodoro');
const store = require('./store');

const PORT = process.env.PORT || 3463;

// ---- auth: human login (signed session cookie) + machine token (bot) ----
// Replaces the old single shared SCHEDULE_PASSCODE gate.
const SCHEDULE_USER = process.env.SCHEDULE_USER || '';
const SCHEDULE_PASS_HASH = process.env.SCHEDULE_PASS_HASH || ''; // format: scrypt:saltHex:hashHex
const SCHEDULE_API_TOKEN = process.env.SCHEDULE_API_TOKEN || '';
const SESSION_SECRET = process.env.SCHEDULE_SESSION_SECRET || '';

const SESSION_COOKIE = 'st_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const app = express();
app.set('trust proxy', 'loopback'); // nginx on the same host sets X-Forwarded-For
app.use(express.json());

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(a || '');
  const bBuf = Buffer.from(b || '');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || !SESSION_SECRET) return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (!timingSafeEqualStr(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function verifyPasswordHash(password, stored) {
  const parts = (stored || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const derived = crypto.scryptSync(password || '', salt, expected.length);
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// ip -> { count, resetAt }
const loginAttempts = new Map();
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= LOGIN_MAX_ATTEMPTS;
}

function requireAuth(req, res, next) {
  // machine path: bot uses a static bearer token; click-through links (e.g. the
  // spice-vote 👍/👎 links in the prep-day Craft doc) pass the same token as a
  // query param since a browser click can't set custom headers.
  const bearer = req.get('authorization');
  const supplied = req.get('x-api-token') || (bearer && bearer.startsWith('Bearer ') ? bearer.slice(7) : null) || req.query.token;
  if (SCHEDULE_API_TOKEN && supplied && timingSafeEqualStr(supplied, SCHEDULE_API_TOKEN)) {
    return next();
  }
  // human path: signed session cookie set by /login
  const session = verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (session && SCHEDULE_USER && session.u === SCHEDULE_USER) return next();

  res.status(401).json({ error: 'authentication required' });
}

app.post('/schedule-tracker-api/login', (req, res) => {
  if (!checkLoginRateLimit(req.ip)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }
  if (!SCHEDULE_USER || !SCHEDULE_PASS_HASH || !SESSION_SECRET) {
    return res.status(500).json({ error: 'auth not configured' });
  }
  const { username, password } = req.body || {};
  const userOk = timingSafeEqualStr(username || '', SCHEDULE_USER);
  const passOk = verifyPasswordHash(password || '', SCHEDULE_PASS_HASH);
  if (!userOk || !passOk) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = signSession({ u: SCHEDULE_USER, exp: Date.now() + SESSION_MAX_AGE_MS });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
  res.json({ ok: true });
});

app.post('/schedule-tracker-api/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.use('/schedule-tracker-api', requireAuth);

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

// ---- own store: projects/captures (source of truth, replaces Calendar task-status) ----

app.get('/schedule-tracker-api/projects', (req, res) => {
  const { status, mode } = req.query;
  res.json(store.listProjects({ status, mode }));
});

app.post('/schedule-tracker-api/projects', (req, res) => {
  try {
    res.json(store.createProject(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/schedule-tracker-api/projects/:id', (req, res) => {
  try {
    res.json(store.patchProject(Number(req.params.id), req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/schedule-tracker-api/projects/menu', (req, res) => {
  try {
    res.json(store.projectsMenu(req.query.mode));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/schedule-tracker-api/capture', (req, res) => {
  try {
    res.json(store.upsertCapture(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/schedule-tracker-api/capture', (req, res) => {
  const { day } = req.query;
  if (!day) return res.status(400).json({ error: 'day required (YYYY-MM-DD)' });
  res.json(store.getCapture(day));
});

app.get('/schedule-tracker-api/stats', (req, res) => {
  res.json(store.stats());
});

app.get('/schedule-tracker-api/stats/energy-by-project', (req, res) => {
  res.json(store.energyByProject());
});

app.get('/schedule-tracker-api/captures', (req, res) => {
  const days = Number(req.query.days) || 30;
  res.json(store.listCapturesRecent(days));
});

app.get('/schedule-tracker-api/day', (req, res) => {
  try {
    res.json(store.getDay(req.query.mode));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/schedule-tracker-api/obligation', (req, res) => {
  try {
    res.json(store.setObligationToday((req.body || {}).text));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/schedule-tracker-api/obligation/decide', (req, res) => {
  try {
    res.json(store.decideObligationToday((req.body || {}).outcome));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/schedule-tracker-api/dashboard-open', (req, res) => {
  store.recordDashboardOpen(req.get('user-agent'));
  res.json({ ok: true });
});

app.get('/schedule-tracker-api/parked-reviews/next', (req, res) => {
  const n = Number(req.query.n) || 2;
  res.json(store.pickParkedForReview(n));
});

app.post('/schedule-tracker-api/parked-reviews', (req, res) => {
  const { project_id, answer } = req.body || {};
  if (!project_id || !['alive', 'sleeping', 'dead'].includes(answer)) {
    return res.status(400).json({ error: 'project_id, answer(alive|sleeping|dead) required' });
  }
  store.recordParkedReview(project_id, answer);
  res.json({ ok: true });
});

// Clicked from a 👍/👎 link in the prep-day Craft doc's "для смаку" block —
// GET (not POST) because it has to work as a plain hyperlink. Auth via ?token=.
app.get('/schedule-tracker-api/spice-vote', (req, res) => {
  const { day, connector, vote } = req.query;
  if (!day || !connector || !['up', 'down'].includes(vote)) {
    return res.status(400).send('day, connector, vote(up|down) required');
  }
  store.recordSpiceVote(day, connector, vote);
  res.type('html').send(`<!doctype html><meta charset="utf-8"><body style="font:16px sans-serif;padding:2rem">Дякую, голос (${vote === 'up' ? '👍' : '👎'}) за ${connector} зараховано.</body>`);
});

// "Виставити на день" — generates today's day_items once (idempotent) from the
// obligation, config/baseline.json, active config/habits.json entries, and
// 2-3 theme picks for the given mode.
app.post('/schedule-tracker-api/day-items/generate', (req, res) => {
  try {
    const day = store.kyivToday();
    res.json(store.generateDayItems(day, (req.body || {}).mode));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/schedule-tracker-api/day-items', (req, res) => {
  const day = req.query.day || store.kyivToday();
  res.json(store.listDayItems(day));
});

app.patch('/schedule-tracker-api/day-items/:id', (req, res) => {
  try {
    const { slot, done, note } = req.body || {};
    let item;
    if (slot !== undefined) item = store.setDayItemSlot(req.params.id, slot);
    if (done !== undefined) item = store.decideDayItem(req.params.id, done, note);
    if (!item) return res.status(400).json({ error: 'slot or done required' });
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// One-time (no earlier than 2026-08-07 Kyiv, only while habits.json is still
// empty) — the bot cron polls this and calls the -sent endpoint after it
// actually delivers the "підселити звичку" nudge.
app.get('/schedule-tracker-api/habits-nudge-check', (req, res) => {
  res.json(store.habitsNudgeCheck());
});

app.post('/schedule-tracker-api/habits-nudge-sent', (req, res) => {
  store.markHabitsNudgeSent();
  res.json({ ok: true });
});

app.get('/schedule-tracker-api/meetings', async (req, res) => {
  const hours = Number(req.query.hours) || 24;
  try {
    const meetings = await getMeetingsInRange(hours);
    res.json(meetings);
  } catch (err) {
    res.status(502).json({ error: 'meetings fetch failed', detail: err.message });
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

// Parks active projects untouched for 14+ days. Runs at startup and once a day —
// systemd keeps this process running for weeks, a plain setInterval is enough.
store.parkStaleProjects();
setInterval(() => store.parkStaleProjects(), 24 * 3600 * 1000);

// Keeps the event loop alive under process supervisors (systemd) that were
// observed letting the loop drain immediately after listen() despite the
// active server handle.
setInterval(() => {}, 1 << 30);
