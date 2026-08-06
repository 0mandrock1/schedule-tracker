// Own store for projects/captures — replaces Google Calendar as the source of truth
// for task/theme tracking (2026-07-31 rewrite). Calendar is now read-only, meetings-only.
const { db } = require('./db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Lazy require — calendar.js throws at load time if ICAL_URL isn't set, and store.js
// should still be requireable on its own (tests, scripts) without that env var.
let _calendar = null;
function calendar() {
  if (!_calendar) _calendar = require('./calendar');
  return _calendar;
}

// 2026-08-05 taxonomy rework: hands/head/ears kept, body (physical/rest) and magic
// (tarot) added. Old rows with mode NULL/unknown are treated as 'head' at read time
// (see modeOrDefault below) — nothing rewrites historical data.
const MODES = ['hands', 'head', 'ears', 'body', 'magic'];
const MODE_LABELS = { hands: '🔌 руки', head: '💻 голова', ears: '🎧 вуха', body: '🫀 тіло', magic: '🔮 магія' };
const PROJECT_STATUSES = ['active', 'parked', 'dead'];
const PARK_AFTER_DAYS = 14;

function kyivToday(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// ---- projects ----

function listProjects({ status, mode } = {}) {
  let sql = 'SELECT * FROM projects WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (mode) { sql += ' AND mode = ?'; params.push(mode); }
  sql += ' ORDER BY (last_touch IS NOT NULL), last_touch ASC, name ASC';
  return db.prepare(sql).all(...params);
}

function createProject({ name, emoji, cluster, mode }) {
  if (!name || !MODES.includes(mode)) throw new Error('name and mode(hands|head|ears|body|magic) required');
  const info = db.prepare('INSERT INTO projects (name, emoji, cluster, mode) VALUES (?, ?, ?, ?)')
    .run(name, emoji || null, cluster || null, mode);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
}

function patchProject(id, fields) {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!existing) throw new Error('project not found');
  const next = {
    name: fields.name ?? existing.name,
    emoji: fields.emoji ?? existing.emoji,
    cluster: fields.cluster ?? existing.cluster,
    mode: fields.mode ?? existing.mode,
    status: fields.status ?? existing.status,
  };
  if (!MODES.includes(next.mode)) throw new Error('mode must be hands|head|ears|body|magic');
  if (!PROJECT_STATUSES.includes(next.status)) throw new Error('status must be active|parked|dead');
  db.prepare('UPDATE projects SET name=?, emoji=?, cluster=?, mode=?, status=? WHERE id=?')
    .run(next.name, next.emoji, next.cluster, next.mode, next.status, id);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

function touchProjects(ids, when = new Date().toISOString()) {
  if (!ids || !ids.length) return;
  const upd = db.prepare('UPDATE projects SET last_touch = ? WHERE id = ?');
  const tx = db.transaction((list) => { for (const id of list) upd.run(when, id); });
  tx(ids);
}

function projectsMenu(mode) {
  if (!MODES.includes(mode)) throw new Error('mode must be hands|head|ears|body|magic');
  const active = listProjects({ status: 'active', mode });
  return { top: active.slice(0, 6), rest: active.slice(6) };
}

// ---- captures ----

// Partial-update aware: a field absent from `fields` keeps whatever the row already has
// (falls back to null for a brand-new day). This lets the bot post the main flow in one
// call, then later post just `{day, note}` or `{day, voice_path, transcript}` for the
// optional post-flow voice/text add-on without clobbering topics/energy/tomorrow.
function upsertCapture(fields) {
  const { day } = fields;
  if (!day) throw new Error('day required (YYYY-MM-DD)');
  const existing = db.prepare('SELECT * FROM captures WHERE day = ?').get(day);
  const pick = (key) => (key in fields ? fields[key] : existing ? existing[key] : null);

  const projects = 'projects' in fields ? (fields.projects || []) : (existing ? JSON.parse(existing.projects_json || '[]') : []);
  const projectsJson = JSON.stringify(projects);
  const energy = pick('energy');
  const note = pick('note');
  const tomorrow = pick('tomorrow');
  const voice_path = pick('voice_path');
  const transcript = pick('transcript');
  const source = fields.source || (existing ? existing.source : 'api');

  db.prepare(`
    INSERT INTO captures (day, projects_json, energy, note, tomorrow, voice_path, transcript, closed_at, source)
    VALUES (@day, @projectsJson, @energy, @note, @tomorrow, @voice_path, @transcript, datetime('now'), @source)
    ON CONFLICT(day) DO UPDATE SET
      projects_json = @projectsJson, energy = @energy, note = @note, tomorrow = @tomorrow,
      voice_path = @voice_path, transcript = @transcript, closed_at = datetime('now'), source = @source
  `).run({ day, projectsJson, energy, note, tomorrow, voice_path, transcript, source });
  if ('projects' in fields) touchProjects(projects, day);
  return getCapture(day);
}

function getCapture(day) {
  const row = db.prepare('SELECT * FROM captures WHERE day = ?').get(day);
  if (!row) return null;
  return { ...row, projects: JSON.parse(row.projects_json || '[]') };
}

function listCapturesRecent(days = 30) {
  const since = kyivToday(-days);
  const rows = db.prepare('SELECT * FROM captures WHERE day >= ? ORDER BY day DESC').all(since);
  const projectsById = {};
  for (const p of db.prepare('SELECT id, name, emoji FROM projects').all()) projectsById[p.id] = p;
  return rows.map(r => ({
    ...r,
    projects: JSON.parse(r.projects_json || '[]').map(id => projectsById[id] || { id, name: '(deleted project)' }),
  }));
}

function stats() {
  const since = kyivToday(-30);
  const rows = db.prepare('SELECT day, projects_json, energy FROM captures WHERE day >= ? ORDER BY day').all(since);
  const coverage = rows.length;
  const touches = {};
  let energySum = 0, energyN = 0;
  for (const r of rows) {
    if (r.energy != null) { energySum += r.energy; energyN++; }
    for (const pid of JSON.parse(r.projects_json || '[]')) touches[pid] = (touches[pid] || 0) + 1;
  }
  const projects = db.prepare('SELECT id, name, emoji, mode, status FROM projects').all();
  const touchesByProject = projects.map(p => ({ ...p, touches: touches[p.id] || 0 }));

  const oblRows = db.prepare('SELECT outcome FROM obligations WHERE day >= ?').all(since);
  const taken = oblRows.filter(r => r.outcome === 'taken').length;
  const moved = oblRows.filter(r => r.outcome === 'moved').length;
  const dropped = oblRows.filter(r => r.outcome === 'dropped').length;
  const decided = taken + moved + dropped;
  const obligations = {
    total: oblRows.length, taken, moved, dropped, decided,
    completionRate: decided ? Math.round((taken / decided) * 1000) / 10 : null,
  };

  const spiceRows = db.prepare('SELECT connector, vote FROM spice_votes').all();
  const spiceVotes = {};
  for (const r of spiceRows) {
    if (!spiceVotes[r.connector]) spiceVotes[r.connector] = { up: 0, down: 0 };
    spiceVotes[r.connector][r.vote] = (spiceVotes[r.connector][r.vote] || 0) + 1;
  }

  return {
    coverage, coverageOf: 30,
    avgEnergy: energyN ? Math.round((energySum / energyN) * 10) / 10 : null,
    touchesByProject,
    obligations,
    spiceVotes,
    dayItems: dayItemsStats(),
  };
}

// Average capture energy per project (last 30 days), min 3 observations so a
// single high/low-energy day doesn't skew a project's read. Sorted best-first.
function energyByProject() {
  const since = kyivToday(-30);
  const rows = db.prepare('SELECT projects_json, energy FROM captures WHERE day >= ? AND energy IS NOT NULL').all(since);
  const sums = {};
  for (const r of rows) {
    for (const pid of JSON.parse(r.projects_json || '[]')) {
      if (!sums[pid]) sums[pid] = { sum: 0, n: 0 };
      sums[pid].sum += r.energy;
      sums[pid].n += 1;
    }
  }
  const projects = db.prepare("SELECT id, name, emoji, mode, status FROM projects WHERE status IN ('active', 'parked')").all();
  return projects
    .map((p) => {
      const s = sums[p.id];
      if (!s || s.n < 3) return null;
      return { ...p, avgEnergy: Math.round((s.sum / s.n) * 10) / 10, observations: s.n };
    })
    .filter(Boolean)
    .sort((a, b) => b.avgEnergy - a.avgEnergy);
}

// baseline is deliberately excluded — it's background, not a completion signal.
function dayItemsStats() {
  const since = kyivToday(-30);
  const rows = db.prepare("SELECT day, title, kind, done FROM day_items WHERE day >= ? AND kind != 'baseline'").all(since);

  const themeRows = rows.filter(r => r.kind === 'theme');
  const themeDone = themeRows.filter(r => r.done === 'yes').length;
  const theme = {
    total: themeRows.length, done: themeDone,
    share: themeRows.length ? Math.round((themeDone / themeRows.length) * 1000) / 10 : null,
  };

  const byTitle = {};
  for (const r of rows.filter(r => r.kind === 'habit')) (byTitle[r.title] ||= []).push(r);
  const habits = Object.entries(byTitle).map(([title, items]) => {
    const sorted = [...items].sort((a, b) => (a.day < b.day ? 1 : -1));
    let streak = 0;
    for (const it of sorted) {
      if (it.done !== 'yes') break;
      streak++;
    }
    return { title, streak, total: items.length };
  });

  return { theme, habits };
}

// ---- obligations ----
// One row per day: either auto-carried from yesterday's capture `tomorrow`
// (source_day set) or picked manually in /day (source_day null). `outcome`
// stays null until the owner resolves it (taken/moved/dropped).

const OBLIGATION_OUTCOMES = ['taken', 'moved', 'dropped'];

function getObligation(day) {
  return db.prepare('SELECT * FROM obligations WHERE day = ?').get(day);
}

// Auto-creates today's obligation from yesterday's capture.tomorrow the first
// time anyone asks for it. Never overwrites an existing row (manual pick wins).
function ensureObligationForToday() {
  const today = kyivToday();
  const existing = getObligation(today);
  if (existing) return existing;
  const yesterday = kyivToday(-1);
  const prevCapture = getCapture(yesterday);
  if (!prevCapture || !prevCapture.tomorrow) return null;
  db.prepare('INSERT INTO obligations (day, text, source_day) VALUES (?, ?, ?)').run(today, prevCapture.tomorrow, yesterday);
  return getObligation(today);
}

// Manual pick from /day when nothing carried over. No-ops (returns the
// existing row) if one already exists — avoids a race clobbering an
// already-decided obligation.
function setObligationToday(text) {
  if (!text) throw new Error('text required');
  const today = kyivToday();
  const existing = getObligation(today);
  if (existing) return existing;
  db.prepare('INSERT INTO obligations (day, text, source_day) VALUES (?, ?, NULL)').run(today, text);
  return getObligation(today);
}

function decideObligationToday(outcome) {
  if (!OBLIGATION_OUTCOMES.includes(outcome)) throw new Error('outcome must be taken|moved|dropped');
  const today = kyivToday();
  const existing = getObligation(today);
  if (!existing) throw new Error('no obligation set for today');
  db.prepare("UPDATE obligations SET outcome = ?, decided_at = datetime('now') WHERE day = ?").run(outcome, today);
  return getObligation(today);
}

function getDay(mode) {
  if (!MODES.includes(mode)) throw new Error('mode must be hands|head|ears|body|magic');
  const obligation = ensureObligationForToday();
  const { top } = projectsMenu(mode);
  return { obligation, topics: top.slice(0, 2) };
}

// ---- spice votes ----
// One row per click on a "для смаку" 👍/👎 link in the prep-day Craft doc.
// `vote` is 'up'|'down', enforced at the route, not here (link-driven, no client to trust).

function recordSpiceVote(day, connector, vote) {
  db.prepare('INSERT INTO spice_votes (day, connector, vote) VALUES (?, ?, ?)').run(day, connector, vote);
}

// ---- dashboard opens ----

function recordDashboardOpen(ua) {
  db.prepare('INSERT INTO dashboard_opens (ua) VALUES (?)').run(ua || null);
}

// ---- parked_reviews ----

function pickParkedForReview(n = 2) {
  return db.prepare("SELECT * FROM projects WHERE status = 'parked' ORDER BY last_touch ASC LIMIT ?").all(n);
}

function recordParkedReview(project_id, answer) {
  db.prepare('INSERT INTO parked_reviews (project_id, answer) VALUES (?, ?)').run(project_id, answer);
  if (answer === 'alive') db.prepare("UPDATE projects SET status = 'active' WHERE id = ?").run(project_id);
  else if (answer === 'dead') db.prepare("UPDATE projects SET status = 'dead' WHERE id = ?").run(project_id);
  // 'sleeping' (спить далі) leaves status as parked
}

// ---- mode picker ----
// Deterministic weighted random: same day → same mode, forever (no Math.random
// anywhere in this section). Seed = hash(day + one-time salt persisted in `flags`).
// Weight per mode = 1 + 0.35 * min(days since it last fell, 6); yesterday's mode is
// further multiplied by 0.15 (rare, not impossible). History comes from `day_plans`
// (the mode column is written the first time a day's items are generated), not a
// separate log — one place, not two copies of "when did X last happen".

const MODE_SALT_KEY = 'mode_pick_salt';

function ensureModeSalt() {
  const row = db.prepare('SELECT value FROM flags WHERE key = ?').get(MODE_SALT_KEY);
  if (row && row.value) return row.value;
  const salt = crypto.randomBytes(8).toString('hex');
  db.prepare("INSERT OR REPLACE INTO flags (key, value, fired_at) VALUES (?, ?, datetime('now'))").run(MODE_SALT_KEY, salt);
  return salt;
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shiftDayStr(day, deltaDays) {
  return new Date(new Date(`${day}T12:00:00Z`).getTime() + deltaDays * 86400000).toISOString().slice(0, 10);
}

function lastModePickDates(beforeDay) {
  const rows = db.prepare('SELECT mode, MAX(day) as day FROM day_plans WHERE day < ? AND mode IS NOT NULL GROUP BY mode').all(beforeDay);
  const out = {};
  for (const r of rows) out[r.mode] = r.day;
  return out;
}

function getDayPlanMode(day) {
  const row = db.prepare('SELECT mode FROM day_plans WHERE day = ?').get(day);
  return row ? row.mode : null;
}

function pickMode(day) {
  const salt = ensureModeSalt();
  const rand = mulberry32(hashStr(day + salt));
  const lastPicked = lastModePickDates(day);
  const yesterdayMode = getDayPlanMode(shiftDayStr(day, -1));

  const weights = MODES.map((m) => {
    const lastDay = lastPicked[m];
    let daysSince = 6;
    if (lastDay) {
      daysSince = Math.max(0, Math.min(6, Math.round((new Date(`${day}T12:00:00Z`) - new Date(`${lastDay}T12:00:00Z`)) / 86400000)));
    }
    let w = 1 + 0.35 * daysSince;
    if (m === yesterdayMode) w *= 0.15;
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < MODES.length; i++) {
    r -= weights[i];
    if (r <= 0) return MODES[i];
  }
  return MODES[MODES.length - 1];
}

// ---- per-day accent colour (5feat P5) ----
// Accent is an independent axis from `mode`: mode still drives the mode LABEL/badge,
// but the page colour is a random daily accent. Names must match the CSS rules
// (:root[data-accent=NAME]) hard-coded in /var/www/html/day/index.html — hex lives
// there (frontend renders), the server only ever deals in these names.
const ACCENTS = ['red', 'green', 'blue', 'pink-violet', 'malachite', 'octarine-1', 'octarine-2', 'octarine-3', 'vampire-werewolf'];

// Picked once per day and stable: if the day already has an accent, keep it (so
// regeneration/repeat PUT never re-rolls mid-day). Otherwise random from the pool
// excluding yesterday's accent.
function pickAccentForDay(day) {
  const cur = db.prepare('SELECT theme_accent FROM day_plans WHERE day = ?').get(day);
  if (cur && cur.theme_accent) return cur.theme_accent;
  const yest = db.prepare('SELECT theme_accent FROM day_plans WHERE day = ?').get(shiftDayStr(day, -1));
  const exclude = yest && yest.theme_accent ? yest.theme_accent : null;
  const pool = ACCENTS.filter((a) => a !== exclude);
  return pool[Math.floor(Math.random() * pool.length)];
}

function ensureDayPlanMode(day, mode) {
  db.prepare(`
    INSERT INTO day_plans (day, mode, theme_accent, generated_at, source) VALUES (?, ?, ?, datetime('now'), 'day-items')
    ON CONFLICT(day) DO NOTHING
  `).run(day, mode, pickAccentForDay(day));
}

// ---- calendar density (theme quota depends on how packed the day already is) ----
// Meetings, not raw events — same predicate GET /calendar exports (isMeeting). A
// calendar fetch failure counts as 0 meetings rather than blocking day-item generation.

function themeQuotaForMeetingCount(n) {
  if (n <= 0) return 4;
  if (n === 1) return 3;
  if (n === 2) return 2;
  return 1;
}

async function countMeetingsForDay(day) {
  const kyivDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' });
  try {
    const { getEventsInRange, isMeeting } = calendar();
    const events = await getEventsInRange(shiftDayStr(day, -1), shiftDayStr(day, 1));
    return events.filter((ev) => !ev.allDay && isMeeting(ev) && kyivDayFmt.format(ev.start) === day).length;
  } catch (err) {
    return 0;
  }
}

// ---- rituals ----
// Registry of rhythm-only commitments (no progress, just cadence) — distinct from
// `projects`, which track last_touch/parking. `cadence` is 'daily' | 'weekly:N' |
// 'gap:N', read by generateDayItems below.

function listRituals({ enabled } = {}) {
  let sql = 'SELECT * FROM rituals WHERE 1=1';
  const params = [];
  if (enabled !== undefined) { sql += ' AND enabled = ?'; params.push(enabled ? 1 : 0); }
  sql += ' ORDER BY id ASC';
  return db.prepare(sql).all(...params);
}

function isoWeekStart(day) {
  const d = new Date(`${day}T12:00:00Z`);
  const wd = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (wd - 1));
  return d.toISOString().slice(0, 10);
}

function ritualWeeklyDoneCount(ritualId, day) {
  const weekStart = isoWeekStart(day);
  const row = db.prepare("SELECT COUNT(*) as n FROM day_items WHERE source = ? AND done = 'yes' AND day >= ? AND day < ?")
    .get(`ritual:${ritualId}`, weekStart, day);
  return row.n;
}

// Decides which rituals land in today's day_items. `daily` fires whenever its own
// mode matches today's mode, OR it's a `body` ritual (physical upkeep runs every day
// regardless of the day's theme). `weekly:N` uses a random draw weighted up when the
// week is behind quota. `gap:N` is deterministic: overdue once last_done is >= N days
// old (or never done).
function ritualsForDay(day, mode) {
  const picked = [];
  for (const ritual of listRituals({ enabled: true })) {
    const [kind, nStr] = ritual.cadence.split(':');
    const n = Number(nStr);
    if (kind === 'daily') {
      if (ritual.mode === mode || ritual.mode === 'body') picked.push(ritual);
    } else if (kind === 'weekly') {
      const done = ritualWeeklyDoneCount(ritual.id, day);
      const weekday = isoWeekday(day);
      const remainingDays = Math.max(1, 8 - weekday);
      const needed = n - done;
      const prob = needed <= 0 ? 0.05 : Math.min(1, (needed / remainingDays) * 1.2);
      if (Math.random() < prob) picked.push(ritual);
    } else if (kind === 'gap') {
      const staleDays = ritual.last_done ? (new Date(`${day}T12:00:00Z`) - new Date(`${ritual.last_done}T12:00:00Z`)) / 86400000 : Infinity;
      if (staleDays >= n) picked.push(ritual);
    }
  }
  return picked;
}

// Keeps ritual.last_done/streak in sync when a ritual-derived day_item gets decided —
// the completion record lives in day_items, this is just a cheap denormalized cursor
// so gap:N/weekly:N lookups above don't have to rescan history on every call.
function markRitualDecided(ritualId, day, done) {
  if (done === 'yes') {
    const ritual = db.prepare('SELECT * FROM rituals WHERE id = ?').get(ritualId);
    if (!ritual) return;
    const wasYesterday = ritual.last_done === shiftDayStr(day, -1);
    const streak = wasYesterday ? ritual.streak + 1 : 1;
    db.prepare('UPDATE rituals SET last_done = ?, streak = ? WHERE id = ?').run(day, streak, ritualId);
  }
}

// ---- day_items ----
// Generated once per day right after the obligation is set (prep-day), then
// walked through in the evening reconciliation. `baseline` items are excluded
// from completion metrics on purpose — see stats() below.

const DAY_ITEM_KINDS = ['baseline', 'habit', 'theme', 'obligation', 'hook'];
const DAY_ITEM_SLOTS = ['morning', 'day', 'evening', 'night'];
const DAY_ITEM_DONE = ['yes', 'no', 'partial'];
const THEME_VERB = 'Приділити трохи часу:';
// A project untouched this long (but not yet parked) gets a 5-minute "hook"
// item instead of a full theme item — lowers the bar back in rather than
// implying a real session is owed.
const HOOK_STALE_DAYS = 10;
const HOOK_TEMPLATES = [
  (name) => `Відкрити ${name} і нічого більше.`,
  (name) => `Дістати ${name} з коробки.`,
];

function hookPhrase(name) {
  const template = HOOK_TEMPLATES[Math.floor(Math.random() * HOOK_TEMPLATES.length)];
  return template(name);
}

function readJsonConfig(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config', file), 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function loadBaseline() {
  const rows = readJsonConfig('baseline.json', []);
  return Array.isArray(rows) ? rows.filter(t => typeof t === 'string') : [];
}

function loadHabits() {
  const rows = readJsonConfig('habits.json', []);
  return Array.isArray(rows) ? rows.filter(h => h && h.enabled !== false && h.title) : [];
}

// ISO weekday: Monday=1 .. Sunday=7, matching `active_days` in habits.json.
function isoWeekday(day) {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
}

function activeHabitsForDay(day) {
  const weekday = isoWeekday(day);
  return loadHabits().filter(h => {
    if (h.active_from && day < h.active_from) return false;
    if (Array.isArray(h.active_days) && h.active_days.length && !h.active_days.includes(weekday)) return false;
    return true;
  });
}

function listDayItems(day) {
  return db.prepare('SELECT * FROM day_items WHERE day = ? ORDER BY id ASC').all(day);
}

// Weighted pick without replacement (weight = 1 + 0.1 * min(days since last_touch, 30)) —
// reservoir-style: assign each candidate a random key = rand()^(1/weight), take the top N.
function weightedPickWithoutReplacement(candidates, weightFn, n) {
  const keyed = candidates.map((c) => ({ c, key: Math.pow(Math.random(), 1 / weightFn(c)) }));
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, n).map((k) => k.c);
}

function projectStaleDays(project, now) {
  return project.last_touch ? (now - new Date(project.last_touch).getTime()) / 86400000 : Infinity;
}

// Idempotent: if items already exist for `day`, returns them unchanged rather than
// duplicating (the "Виставити на день" button/prep-day step may fire more than once
// for the same day). `mode` picks the theme pool; falls back to pickMode(day) if
// omitted/invalid so a caller never has to think about mode selection itself.
async function generateDayItems(day, mode) {
  const existingPlanMode = getDayPlanMode(day);
  const finalMode = existingPlanMode || (mode && MODES.includes(mode) ? mode : pickMode(day));
  ensureDayPlanMode(day, finalMode);

  const rows = [];

  const obligation = getObligation(day) || ensureObligationForToday();
  if (obligation && obligation.day === day) {
    rows.push({ title: obligation.text, kind: 'obligation', source: `obligation:${obligation.id}` });
  }

  for (const ritual of ritualsForDay(day, finalMode)) {
    rows.push({ title: `${ritual.emoji ? ritual.emoji + ' ' : ''}${ritual.name}`, kind: 'habit', source: `ritual:${ritual.id}` });
  }

  const meetingCount = await countMeetingsForDay(day);
  const quota = themeQuotaForMeetingCount(meetingCount);
  const now = Date.now();
  let pool = listProjects({ status: 'active', mode: finalMode });
  if (pool.length < quota) {
    const extra = listProjects({ status: 'active', mode: 'head' }).filter((p) => !pool.some((q) => q.id === p.id));
    pool = pool.concat(extra);
  }
  const picks = weightedPickWithoutReplacement(pool, (p) => 1 + 0.1 * Math.min(projectStaleDays(p, now), 30), quota);
  for (const project of picks) {
    const staleDays = projectStaleDays(project, now);
    if (staleDays > HOOK_STALE_DAYS) {
      rows.push({ title: hookPhrase(project.name), kind: 'hook', source: `project:${project.id}` });
    } else {
      rows.push({ title: `${THEME_VERB} ${project.name}`, kind: 'theme', source: `project:${project.id}` });
    }
  }

  // Idempotency check has to live inside this synchronous transaction, not before the
  // `await countMeetingsForDay` above — otherwise two concurrent calls both pass the
  // check before either has inserted, and both proceed to insert (the original bug).
  // INSERT OR IGNORE backs this up against the day_items UNIQUE(day,title,kind) index
  // (see db.js) in case two transactions still race past the listDayItems check.
  const insert = db.prepare('INSERT OR IGNORE INTO day_items (day, title, kind, source) VALUES (?, ?, ?, ?)');
  const tx = db.transaction((list) => {
    const existing = listDayItems(day);
    if (existing.length) return existing;
    for (const r of list) insert.run(day, r.title, r.kind, r.source);
    return listDayItems(day);
  });
  return tx(rows);
}

function setDayItemSlot(id, slot) {
  if (!DAY_ITEM_SLOTS.includes(slot)) throw new Error('slot must be morning|day|evening|night');
  const info = db.prepare('UPDATE day_items SET slot = ? WHERE id = ?').run(slot, id);
  if (!info.changes) throw new Error('day item not found');
  return db.prepare('SELECT * FROM day_items WHERE id = ?').get(id);
}

// `done = null` un-decides the row (clears decided_at too) — needed because a
// decision has to be reversible from the phone, not just correctable. Existing
// callers pass 'yes'|'no'|'partial' and are unaffected: they never send null,
// and the PATCH route only reaches here when `done !== undefined`.
function decideDayItem(id, done, note) {
  const reset = done === null;
  if (!reset && !DAY_ITEM_DONE.includes(done)) throw new Error('done must be yes|no|partial (or null to reset)');
  const item = db.prepare('SELECT * FROM day_items WHERE id = ?').get(id);
  if (!item) throw new Error('day item not found');
  db.prepare(`
    UPDATE day_items SET done = ?, note = COALESCE(?, note),
      decided_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END
    WHERE id = ?
  `).run(done, note ?? null, done, id);
  if (item.source && item.source.startsWith('ritual:')) {
    markRitualDecided(Number(item.source.slice('ritual:'.length)), item.day, done);
  }
  return db.prepare('SELECT * FROM day_items WHERE id = ?').get(id);
}

// Assign (or clear, dueAt=null) a concrete clock time to an item. Expects a
// tz-qualified ISO string (e.g. "2026-08-06T14:30:00+03:00") so the bot's
// `new Date(due_at)` is unambiguous. Re-setting due_at clears notified_at so the
// reminder re-arms for the new time; clearing it (null) disables the reminder.
function setDayItemDueAt(id, dueAt) {
  if (dueAt !== null) {
    if (typeof dueAt !== 'string' || Number.isNaN(Date.parse(dueAt))) {
      throw new Error('due_at must be a tz-qualified ISO datetime string, or null to clear');
    }
  }
  const info = db.prepare('UPDATE day_items SET due_at = ?, notified_at = NULL WHERE id = ?').run(dueAt, id);
  if (!info.changes) throw new Error('day item not found');
  return db.prepare('SELECT * FROM day_items WHERE id = ?').get(id);
}

// Candidates for the timed-reminder poll: today's items that have a due_at and
// haven't been pinged yet. The bot filters the [~13..15 min before] window client-side
// (it knows "now"), then claims via claimDayItemReminder — same split as meetings.
function dueDayItemsPending(day) {
  return db.prepare('SELECT * FROM day_items WHERE day = ? AND due_at IS NOT NULL AND notified_at IS NULL').all(day);
}

// Atomic claim: stamps notified_at only if still unset. Returns true for the caller
// that won the race, false for a duplicate poll — mirrors claimMeetingPing so a bot
// restart straddling the reminder window can't double-ping.
function claimDayItemReminder(id) {
  const info = db.prepare("UPDATE day_items SET notified_at = datetime('now') WHERE id = ? AND notified_at IS NULL").run(id);
  return info.changes > 0;
}

function getDayItem(id) {
  return db.prepare('SELECT * FROM day_items WHERE id = ?').get(id);
}

// Ad-hoc item for today, outside the generated set (POST /task). `hook` is the
// default kind because a thing typed in by hand mid-day is a low-bar nudge, not
// a tracked habit or a theme session — keeping it out of `theme` also keeps the
// completion metric in dayItemsStats() honest.
function addDayItem({ title, slot, kind } = {}) {
  const clean = typeof title === 'string' ? title.trim() : '';
  if (!clean) throw new Error('title required');
  const itemKind = kind || 'hook';
  if (!DAY_ITEM_KINDS.includes(itemKind)) throw new Error(`kind must be ${DAY_ITEM_KINDS.join('|')}`);
  const itemSlot = slot ?? null;
  if (itemSlot !== null && !DAY_ITEM_SLOTS.includes(itemSlot)) throw new Error('slot must be morning|day|evening|night');
  const info = db.prepare('INSERT INTO day_items (day, title, kind, slot, source) VALUES (?, ?, ?, ?, ?)')
    .run(kyivToday(), clean, itemKind, itemSlot, 'manual');
  return getDayItem(info.lastInsertRowid);
}

// ---- habits nudge (one-time) ----
// Fires once, no earlier than 2026-08-07 (Kyiv), only while habits.json is
// still empty — a nudge to seed the first habit. The bot cron polls this and
// calls markHabitsNudgeSent() after it actually sends the message.

const HABITS_NUDGE_KEY = 'habits_nudge_sent';
const HABITS_NUDGE_NOT_BEFORE = '2026-08-07';

function habitsNudgeCheck() {
  const today = kyivToday();
  if (today < HABITS_NUDGE_NOT_BEFORE) return { shouldSend: false };
  if (loadHabits().length > 0) return { shouldSend: false };
  const sent = db.prepare('SELECT 1 FROM flags WHERE key = ?').get(HABITS_NUDGE_KEY);
  return { shouldSend: !sent };
}

// Debug/verify surface over the `flags` table: lets /debughabits show whether the
// one-time nudge already fired and reset it, instead of poking sqlite by hand.
function listFlags() {
  return db.prepare('SELECT key, fired_at FROM flags ORDER BY fired_at DESC').all();
}

function clearFlag(key) {
  const info = db.prepare('DELETE FROM flags WHERE key = ?').run(key);
  return { cleared: info.changes > 0 };
}

function markHabitsNudgeSent() {
  db.prepare("INSERT OR REPLACE INTO flags (key, fired_at) VALUES (?, datetime('now'))").run(HABITS_NUDGE_KEY);
}

// ---- meeting ping dedup (survives bot restart, unlike an in-memory Set) ----
// Reuses `flags` as a claim table: one row per event-occurrence key means
// "already pinged". INSERT OR IGNORE makes the claim atomic — changes > 0
// only for the caller that wins the race.

function claimMeetingPing(key) {
  const info = db.prepare("INSERT OR IGNORE INTO flags (key, fired_at) VALUES (?, datetime('now'))").run(`meeting_ping:${key}`);
  return info.changes > 0;
}

// ---- unscheduled rituals (5feat P3) ----
// Enabled rituals that did NOT land in today's day_items (source `ritual:<id>`). Uses
// the persisted checklist rather than re-calling ritualsForDay so the random weekly
// draw isn't re-rolled on every poll — this reflects what actually made the day.
function unscheduledRituals(day) {
  const scheduled = new Set(
    db.prepare("SELECT source FROM day_items WHERE day = ? AND source LIKE 'ritual:%'").all(day)
      .map((r) => Number(r.source.split(':')[1]))
  );
  return listRituals({ enabled: true }).filter((r) => !scheduled.has(r.id));
}

// ---- first full day-plan push latch (5feat P2, fixed 2026-08-06) ----
// One push of the full rendered plan per calendar day. MUST be armed only by
// genuine schedule/ritual generation (PUT /day-plan/:date, the path
// generate-day-prompt.md calls) via armDayFullPush() below — NOT by
// /template/regenerate and NOT merely by "md is non-null". First cut inferred
// pending from md-presence alone, so it fired off a pm2 restart mid-deploy
// (boot-time checkFullPush) rather than off the actual morning generation.
function armDayFullPush(day) {
  db.prepare("INSERT OR IGNORE INTO flags (key, fired_at) VALUES (?, datetime('now'))").run(`day_full_push_armed:${day}`);
}

function dayFullPushPending(day) {
  const plan = getDayPlan(day);
  if (!plan || plan.md == null) return { pending: false };
  const armed = db.prepare('SELECT 1 FROM flags WHERE key = ?').get(`day_full_push_armed:${day}`);
  if (!armed) return { pending: false };
  const fired = db.prepare('SELECT 1 FROM flags WHERE key = ?').get(`day_full_push:${day}`);
  if (fired) return { pending: false };
  return { pending: true, plan: { day: plan.day, mode: plan.mode, md: plan.md } };
}

function claimDayFullPush(day) {
  const info = db.prepare("INSERT OR IGNORE INTO flags (key, fired_at) VALUES (?, datetime('now'))").run(`day_full_push:${day}`);
  return info.changes > 0;
}

// ---- device whitelist (5feat P4) ----
function registerDevice(label) {
  const token = require('crypto').randomBytes(32).toString('hex');
  db.prepare("INSERT INTO day_devices (token, created_at, last_seen_at, label) VALUES (?, datetime('now'), datetime('now'), ?)")
    .run(token, label || null);
  return token;
}

function listDeviceTokens() {
  return db.prepare('SELECT token FROM day_devices ORDER BY created_at ASC').all().map((r) => r.token);
}

// ---- day_plans (rendered plan storage) ----

function getDayPlan(day) {
  return db.prepare('SELECT * FROM day_plans WHERE day = ?').get(day) || null;
}

function getLatestDayPlan() {
  return db.prepare('SELECT * FROM day_plans WHERE md IS NOT NULL ORDER BY day DESC LIMIT 1').get() || null;
}

// The generator (bot/script) calls this once it has picked/rendered the day's plan.
// Upserts by day — ensureDayPlanMode may already have created a mode-only row earlier
// the same day; this fills in the rest without duplicating.
function saveDayPlan(day, { mode, md, html, data }) {
  if (!MODES.includes(mode)) throw new Error('mode must be hands|head|ears|body|magic');
  // theme_accent: COALESCE keeps whatever the day already had (ensureDayPlanMode or an
  // earlier save may have set it) and only fills it from the fresh pick when still null.
  // So /template/regenerate and repeat PUT the same day never re-roll the colour.
  db.prepare(`
    INSERT INTO day_plans (day, mode, md, html, data_json, theme_accent, generated_at, source)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'api')
    ON CONFLICT(day) DO UPDATE SET
      mode = excluded.mode, md = excluded.md, html = excluded.html,
      data_json = excluded.data_json,
      theme_accent = COALESCE(day_plans.theme_accent, excluded.theme_accent),
      generated_at = datetime('now'), source = 'api'
  `).run(day, mode, md ?? null, html ?? null, JSON.stringify(data ?? {}), pickAccentForDay(day));
  return getDayPlan(day);
}

// ---- templates ----

function getTemplate(name = 'day') {
  return db.prepare('SELECT * FROM templates WHERE name = ?').get(name) || null;
}

function saveTemplate(md, name = 'day', updatedBy = 'api') {
  db.prepare(`
    INSERT INTO templates (name, md, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(name) DO UPDATE SET md = excluded.md, updated_at = datetime('now'), updated_by = excluded.updated_by
  `).run(name, md, updatedBy);
  return getTemplate(name);
}

function resetTemplate(name = 'day') {
  const md = fs.readFileSync(path.join(__dirname, 'config', 'day-template.md'), 'utf8');
  return saveTemplate(md, name, 'reset');
}

// ---- daily park sweep ----

function parkStaleProjects() {
  const cutoff = new Date(Date.now() - PARK_AFTER_DAYS * 86400000).toISOString();
  const info = db.prepare(`
    UPDATE projects SET status = 'parked'
    WHERE status = 'active' AND last_touch IS NOT NULL AND last_touch < ?
  `).run(cutoff);
  return info.changes;
}

module.exports = {
  MODES, MODE_LABELS, PROJECT_STATUSES, OBLIGATION_OUTCOMES,
  DAY_ITEM_KINDS, DAY_ITEM_SLOTS, DAY_ITEM_DONE,
  listProjects, createProject, patchProject, projectsMenu, touchProjects,
  upsertCapture, getCapture, listCapturesRecent, stats, energyByProject, getDay,
  getObligation, setObligationToday, decideObligationToday,
  recordDashboardOpen,
  recordSpiceVote,
  pickParkedForReview, recordParkedReview,
  parkStaleProjects,
  generateDayItems, listDayItems, getDayItem, addDayItem, setDayItemSlot, decideDayItem,
  setDayItemDueAt, dueDayItemsPending, claimDayItemReminder,
  habitsNudgeCheck, markHabitsNudgeSent, listFlags, clearFlag,
  claimMeetingPing,
  unscheduledRituals, dayFullPushPending, claimDayFullPush, armDayFullPush,
  registerDevice, listDeviceTokens,
  ACCENTS, pickAccentForDay,
  kyivToday,
  pickMode, listRituals, ritualsForDay,
  countMeetingsForDay, themeQuotaForMeetingCount,
  ensureDayPlanMode, getDayPlanMode,
  getDayPlan, getLatestDayPlan, saveDayPlan,
  getTemplate, saveTemplate, resetTemplate,
};
