require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { execFile } = require('child_process');
const { db, importLegacy } = require('./db');
const { getEventsInRange, getMeetingsInRange, isMeeting } = require('./calendar');
const pomodoro = require('./pomodoro');
const store = require('./store');
const template = require('./template');

const PORT = process.env.PORT || 3463;

// ---- auth: human login (signed session cookie) + machine token (bot) ----
// Replaced the old single shared-passcode gate (removed 2026-07-31, env var no longer read).
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

// ---- device whitelist for the /day/ nginx Basic Auth (5feat P4) ----
// Regenerate the nginx map include from the day_devices table, then test+reload nginx.
// The map is consumed by an http-level `map $cookie_day_device $day_auth` block (in
// /etc/nginx/conf.d/day-device-map.conf): a matching cookie => "off" disables
// auth_basic for that browser; everything else falls to the default "day" realm.
const DEVICE_MAP_FILE = '/etc/nginx/day-device-whitelist.map';
function regenerateDeviceMap() {
  return new Promise((resolve, reject) => {
    const lines = store.listDeviceTokens().map((t) => `"${t}" "off";`);
    const body = lines.length ? lines.join('\n') + '\n' : '# no whitelisted devices\n';
    try {
      fs.writeFileSync(DEVICE_MAP_FILE, body);
    } catch (err) {
      return reject(new Error(`write map failed: ${err.message}`));
    }
    execFile('nginx', ['-t'], (tErr, _o, tStderr) => {
      if (tErr) return reject(new Error(`nginx -t failed: ${tStderr || tErr.message}`));
      execFile('systemctl', ['reload', 'nginx'], (rErr, _ro, rStderr) => {
        if (rErr) return reject(new Error(`nginx reload failed: ${rStderr || rErr.message}`));
        resolve();
      });
    });
  });
}

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

app.get('/schedule-tracker-api/health', (req, res) => {
  res.json({ ok: true, version: require('./package.json').version });
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
app.post('/schedule-tracker-api/day-items/generate', async (req, res) => {
  try {
    const day = store.kyivToday();
    res.json(await store.generateDayItems(day, (req.body || {}).mode));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/schedule-tracker-api/day-items', (req, res) => {
  const day = req.query.day || store.kyivToday();
  res.json(store.listDayItems(day));
});

// Timed-reminder poll source: today's items with a due_at still awaiting a ping.
// Static path — declared before PATCH `/day-items/:id` so `due` isn't read as an id.
app.get('/schedule-tracker-api/day-items/due', (req, res) => {
  const day = req.query.day || store.kyivToday();
  res.json(store.dueDayItemsPending(day));
});

// Atomic dedup claim for the 15-min reminder (bot-side poll wins exactly once).
app.post('/schedule-tracker-api/day-items/:id/reminder-claim', (req, res) => {
  res.json({ claimed: store.claimDayItemReminder(req.params.id) });
});

app.patch('/schedule-tracker-api/day-items/:id', (req, res) => {
  try {
    const { slot, done, note, due_at } = req.body || {};
    let item;
    if (slot !== undefined) item = store.setDayItemSlot(req.params.id, slot);
    if (done !== undefined) item = store.decideDayItem(req.params.id, done, note);
    if (due_at !== undefined) item = store.setDayItemDueAt(req.params.id, due_at);
    if (!item) return res.status(400).json({ error: 'slot, done or due_at required' });
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- day-plan storage + templater (2026-08-05 taxonomy rework) ----
// The plan itself (mode + rendered md/html + the data it was rendered from) is stored
// by whatever generates it (bot/script) via PUT; this server only stores/renders, it
// never picks a mode or assembles day-plan data on its own initiative.

function dayPlanJson(plan) {
  return {
    date: plan.day, mode: plan.mode, md: plan.md, html: plan.html,
    theme_accent: plan.theme_accent || null,
    data: JSON.parse(plan.data_json || '{}'), generated_at: plan.generated_at,
  };
}

// Registered before /day-plan/:date so "latest" isn't swallowed as a literal date param.
app.get('/schedule-tracker-api/day-plan/latest', (req, res) => {
  const plan = store.getLatestDayPlan();
  if (!plan) return res.status(404).json({ error: 'no day plan saved yet' });
  res.json(dayPlanJson(plan));
});

// Same reason (must precede /day-plan/:date): first-full-push poll source (5feat P2).
app.get('/schedule-tracker-api/day-plan/full-push-pending', (req, res) => {
  res.json(store.dayFullPushPending(store.kyivToday()));
});

app.get('/schedule-tracker-api/day-plan/:date', (req, res) => {
  const plan = store.getDayPlan(req.params.date);
  if (!plan || plan.md == null) return res.status(404).json({ error: `no day plan for ${req.params.date}` });
  res.json(dayPlanJson(plan));
});

app.put('/schedule-tracker-api/day-plan/:date', (req, res) => {
  try {
    const { mode, md, html, data } = req.body || {};
    res.json(dayPlanJson(store.saveDayPlan(req.params.date, { mode, md, html, data })));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Preview only — re-renders the day's already-stored `data` with the CURRENT template,
// nothing is written back. Useful for iterating on the template against a real day.
app.post('/schedule-tracker-api/day-plan/:date/render', (req, res) => {
  const plan = store.getDayPlan(req.params.date);
  if (!plan || !plan.data_json) return res.status(404).json({ error: `no stored data for ${req.params.date} to render` });
  const tpl = store.getTemplate('day');
  if (!tpl) return res.status(500).json({ error: 'template not found' });
  const data = JSON.parse(plan.data_json);
  const { md, warnings } = template.render(tpl.md, data);
  const html = template.renderHtml(tpl.md, data);
  res.json({ md, html, warnings });
});

// Re-render the latest (today's) day plan with the CURRENT template and WRITE it back
// (unlike /day-plan/:date/render, which is preview-only). Same data/mode are kept —
// saveDayPlan re-persists them unchanged, and theme_accent is preserved (COALESCE),
// so regeneration never changes the colour or re-picks the mode within the day.
app.post('/schedule-tracker-api/template/regenerate', (req, res) => {
  const plan = store.getLatestDayPlan();
  if (!plan || !plan.data_json) return res.status(404).json({ error: 'no stored day plan to regenerate' });
  const tpl = store.getTemplate('day');
  if (!tpl) return res.status(500).json({ error: 'template not found' });
  try {
    const data = JSON.parse(plan.data_json);
    const { md, warnings } = template.render(tpl.md, data);
    const html = template.renderHtml(tpl.md, data);
    const saved = store.saveDayPlan(plan.day, { mode: plan.mode, md, html, data });
    res.json({ ...dayPlanJson(saved), warnings });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rituals that did NOT make it into today's day_items — the bot draws 2 at random
// from here every ~2h (5feat P3). Read-only.
app.get('/schedule-tracker-api/rituals/unscheduled', (req, res) => {
  const day = req.query.day || store.kyivToday();
  res.json(store.unscheduledRituals(day));
});

// First-full-push latch (5feat P2): the bot polls -pending; if pending it claims
// atomically then sends the full plan md exactly once per day. (GET counterpart is
// registered above /day-plan/:date so the literal path isn't read as a date.)
app.post('/schedule-tracker-api/day-plan/full-push-claim', (req, res) => {
  res.json({ claimed: store.claimDayFullPush(store.kyivToday()) });
});

app.get('/schedule-tracker-api/template', (req, res) => {
  const tpl = store.getTemplate('day');
  if (!tpl) return res.status(404).json({ error: 'template not found' });
  res.json({ name: tpl.name, md: tpl.md, updated_at: tpl.updated_at });
});

app.put('/schedule-tracker-api/template', (req, res) => {
  const { md } = req.body || {};
  if (typeof md !== 'string' || !md) return res.status(400).json({ error: 'md required (string)' });
  const { warnings, usedTokens } = template.render(md, {});
  store.saveTemplate(md, 'day', 'api');
  res.json({ ok: true, warnings, usedTokens });
});

app.get('/schedule-tracker-api/template/tokens', (req, res) => {
  res.json(template.TEMPLATE_TOKENS);
});

app.post('/schedule-tracker-api/template/reset', (req, res) => {
  const tpl = store.resetTemplate('day');
  res.json({ name: tpl.name, md: tpl.md, updated_at: tpl.updated_at });
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

// Flags are one-shot latches (habits nudge, meeting-ping claims). Exposed so the
// bot's hidden /debughabits can show and reset them without shelling into sqlite.
app.get('/schedule-tracker-api/flags', (req, res) => {
  res.json(store.listFlags());
});

app.post('/schedule-tracker-api/flags/clear', (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  res.json(store.clearFlag(key));
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

// Atomic claim for meeting-ping dedup — bot calls this before sending a
// "30 min out" ping so a restart never re-sends (was an in-memory Set).
app.post('/schedule-tracker-api/meeting-ping-claim', (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  res.json({ claimed: store.claimMeetingPing(key) });
});

// ---- device whitelist register (5feat P4) ----
// Called by a tiny inline JS in /day/index.html the first time a browser lands with a
// valid Basic Auth but no day_device cookie. nginx already validated Basic Auth (and
// injects the machine token, so requireAuth passes); we mint a device token, whitelist
// it in the nginx map, and set it as a long-lived cookie so that browser stops being
// prompted. X-Remote-User (set by nginx from Basic Auth) is stored only as a label.
app.post('/schedule-tracker-api/device/register', async (req, res) => {
  const label = req.get('x-remote-user') || null;
  const token = store.registerDevice(label);
  try {
    await regenerateDeviceMap();
  } catch (err) {
    return res.status(500).json({ error: `device registered but nginx not reloaded: ${err.message}` });
  }
  res.cookie('day_device', token, {
    path: '/', maxAge: 180 * 24 * 3600 * 1000, httpOnly: true, secure: true, sameSite: 'lax',
  });
  res.json({ ok: true });
});

// ---- compatibility routes kept from the Calendar era (paths only) ----
// `/status` and `/task` are the original path names from when Google Calendar WAS
// the database: `/status` rewrote a `✅ `/`❌ ` prefix into the event title and
// `/task` created a calendar event. Both now operate purely on `day_items` in the
// local store — the paths survived so existing callers/bookmarks keep working, the
// implementations did not. Nothing here touches the Calendar API.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CALENDAR_MAX_DAYS = 62;
// Kyiv, not UTC: a 23:30 Kyiv event must land on the day the owner lived it,
// which is what every other date in this store (kyivToday) already means.
const kyivDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' });

// Round-trip check, because V8 silently rolls '2026-02-31' over into March
// instead of returning Invalid Date — a typo'd day would otherwise return a
// window the caller never asked for.
function parseDay(value) {
  if (!DAY_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return null;
  return d;
}

function shiftDay(date, days) {
  return new Date(date.getTime() + days * 86400000).toISOString().slice(0, 10);
}

// Read-only calendar window grouped by Kyiv day. Carries no task status at all —
// statuses live in `day_items` now, the calendar no longer encodes them.
app.get('/schedule-tracker-api/calendar', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });
  const fromDate = parseDay(String(from));
  const toDate = parseDay(String(to));
  if (!fromDate) return res.status(400).json({ error: `from must be a valid date in YYYY-MM-DD format, got "${from}"` });
  if (!toDate) return res.status(400).json({ error: `to must be a valid date in YYYY-MM-DD format, got "${to}"` });
  if (toDate < fromDate) return res.status(400).json({ error: `to (${to}) must not be earlier than from (${from})` });
  const days = Math.round((toDate - fromDate) / 86400000) + 1;
  // The iCal feed is re-parsed and RRULEs expanded per request (60s cache); an
  // unbounded window is a cheap way to hang the event loop.
  if (days > CALENDAR_MAX_DAYS) {
    return res.status(400).json({ error: `range must not exceed ${CALENDAR_MAX_DAYS} days, got ${days}` });
  }

  try {
    // getEventsInRange takes a UTC window but we group by Kyiv day (UTC+2/+3), so
    // fetch a day wider on each side and let the key filter below trim it —
    // otherwise a 01:00 Kyiv event on the first day falls outside the UTC window.
    const events = await getEventsInRange(shiftDay(fromDate, -1), shiftDay(toDate, 1));
    const byDay = {};
    for (const ev of events) {
      const key = kyivDayFmt.format(ev.start);
      if (key < from || key > to) continue; // UTC-window edges spilling outside the asked-for Kyiv days
      (byDay[key] ||= []).push({
        uid: ev.uid,
        start: ev.start.toISOString(),
        end: ev.end.toISOString(),
        summary: ev.summary || '',
        allDay: Boolean(ev.allDay),
        isMeeting: isMeeting(ev),
      });
    }
    for (const key of Object.keys(byDay)) byDay[key].sort((a, b) => a.start.localeCompare(b.start));
    res.json(byDay);
  } catch (err) {
    res.status(502).json({ error: 'calendar fetch failed', detail: err.message });
  }
});

// Compat wrapper over store.decideDayItem. `pending` is the reset case — the old
// Calendar version expressed it by stripping the title prefix; here it nulls
// `done` so the item goes back to undecided rather than being marked skipped.
const STATUS_TO_DONE = { done: 'yes', skipped: 'no', pending: null };

app.post('/schedule-tracker-api/status', (req, res) => {
  const { id, status } = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(STATUS_TO_DONE, status)) {
    return res.status(400).json({ error: 'status must be done|skipped|pending' });
  }
  const itemId = Number(id);
  if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ error: 'id required (day_items row id)' });
  if (!store.getDayItem(itemId)) return res.status(404).json({ error: `day item ${itemId} not found` });
  try {
    res.json(store.decideDayItem(itemId, STATUS_TO_DONE[status], (req.body || {}).note));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Compat wrapper over store.addDayItem: same path as the old "create a calendar
// event" endpoint, but the row lands in `day_items` for today (Kyiv) instead.
app.post('/schedule-tracker-api/task', (req, res) => {
  try {
    const { title, slot, kind } = req.body || {};
    res.status(201).json(store.addDayItem({ title, slot, kind }));
  } catch (err) {
    res.status(400).json({ error: err.message });
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
