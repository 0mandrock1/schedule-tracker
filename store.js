// Own store for projects/captures — replaces Google Calendar as the source of truth
// for task/theme tracking (2026-07-31 rewrite). Calendar is now read-only, meetings-only.
const { db } = require('./db');

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

  return {
    coverage, coverageOf: 30,
    avgEnergy: energyN ? Math.round((energySum / energyN) * 10) / 10 : null,
    touchesByProject,
    obligations,
  };
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
  listProjects, createProject, patchProject, projectsMenu, touchProjects,
  upsertCapture, getCapture, listCapturesRecent, stats, getDay,
  getObligation, setObligationToday, decideObligationToday,
  recordDashboardOpen,
  pickParkedForReview, recordParkedReview,
  parkStaleProjects,
  kyivToday,
};
