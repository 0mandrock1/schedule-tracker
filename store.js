// Own store for projects/captures — replaces Google Calendar as the source of truth
// for task/theme tracking (2026-07-31 rewrite). Calendar is now read-only, meetings-only.
const { db } = require('./db');
const fs = require('fs');
const path = require('path');

const MODES = ['hands', 'head', 'ears'];
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
  if (!name || !MODES.includes(mode)) throw new Error('name and mode(hands|head|ears) required');
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
  if (!MODES.includes(next.mode)) throw new Error('mode must be hands|head|ears');
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
  if (!MODES.includes(mode)) throw new Error('mode must be hands|head|ears');
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
  if (!MODES.includes(mode)) throw new Error('mode must be hands|head|ears');
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

// Idempotent: if items already exist for `day`, returns them unchanged rather
// than duplicating (the "Виставити на день" button/prep-day step may fire more
// than once for the same day).
function generateDayItems(day, mode) {
  const existing = listDayItems(day);
  if (existing.length) return existing;

  const insert = db.prepare('INSERT INTO day_items (day, title, kind, source) VALUES (?, ?, ?, ?)');
  const rows = [];

  const obligation = getObligation(day) || ensureObligationForToday();
  if (obligation && obligation.day === day) {
    rows.push({ title: obligation.text, kind: 'obligation', source: `obligation:${obligation.id}` });
  }

  for (const title of loadBaseline()) {
    rows.push({ title, kind: 'baseline', source: 'baseline' });
  }

  for (const habit of activeHabitsForDay(day)) {
    rows.push({ title: habit.title, kind: 'habit', source: `habit:${habit.title}` });
  }

  if (mode && MODES.includes(mode)) {
    const { top } = projectsMenu(mode);
    const now = Date.now();
    for (const project of top.slice(0, 3)) {
      const staleDays = project.last_touch ? (now - new Date(project.last_touch).getTime()) / 86400000 : Infinity;
      if (staleDays > HOOK_STALE_DAYS) {
        rows.push({ title: hookPhrase(project.name), kind: 'hook', source: `project:${project.id}` });
      } else {
        rows.push({ title: `${THEME_VERB} ${project.name}`, kind: 'theme', source: `project:${project.id}` });
      }
    }
  }

  const tx = db.transaction((list) => {
    for (const r of list) insert.run(day, r.title, r.kind, r.source);
  });
  tx(rows);
  return listDayItems(day);
}

function setDayItemSlot(id, slot) {
  if (!DAY_ITEM_SLOTS.includes(slot)) throw new Error('slot must be morning|day|evening|night');
  const info = db.prepare('UPDATE day_items SET slot = ? WHERE id = ?').run(slot, id);
  if (!info.changes) throw new Error('day item not found');
  return db.prepare('SELECT * FROM day_items WHERE id = ?').get(id);
}

function decideDayItem(id, done, note) {
  if (!DAY_ITEM_DONE.includes(done)) throw new Error('done must be yes|no|partial');
  const info = db.prepare(`
    UPDATE day_items SET done = ?, note = COALESCE(?, note), decided_at = datetime('now') WHERE id = ?
  `).run(done, note ?? null, id);
  if (!info.changes) throw new Error('day item not found');
  return db.prepare('SELECT * FROM day_items WHERE id = ?').get(id);
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

function markHabitsNudgeSent() {
  db.prepare("INSERT OR REPLACE INTO flags (key, fired_at) VALUES (?, datetime('now'))").run(HABITS_NUDGE_KEY);
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
  MODES, PROJECT_STATUSES, OBLIGATION_OUTCOMES,
  DAY_ITEM_KINDS, DAY_ITEM_SLOTS, DAY_ITEM_DONE,
  listProjects, createProject, patchProject, projectsMenu, touchProjects,
  upsertCapture, getCapture, listCapturesRecent, stats, energyByProject, getDay,
  getObligation, setObligationToday, decideObligationToday,
  recordDashboardOpen,
  recordSpiceVote,
  pickParkedForReview, recordParkedReview,
  parkStaleProjects,
  generateDayItems, listDayItems, setDayItemSlot, decideDayItem,
  habitsNudgeCheck, markHabitsNudgeSent,
  kyivToday,
};
