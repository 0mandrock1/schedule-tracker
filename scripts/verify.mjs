#!/usr/bin/env node
// System health check for the post-2026-07-31 schedule-tracker.
//
// Replaces the old Playwright script, which tested a UI that no longer exists
// (passcode gate, task add/delete, per-task Pomodoro on calendar events).
//
// Checks, in order:
//   1. every /schedule-tracker-api/* endpoint the current system actually has
//   2. auth is really enforced (an unauthenticated call must 401)
//   3. the evening-checkin bot registered its crons (data/crons.json)
//   4. helper scripts exist and are executable
//   5. dead files from the calendar era are gone
//
// Usage:  npm run verify           (or: node scripts/verify.mjs)
// Env:    VERIFY_BASE_URL   default http://127.0.0.1:3464
//         SCHEDULE_API_TOKEN  read from systemd if not set
// Exit code 0 only when every check passes.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOT_DIR = '/root/projects/tg_bots/evening-checkin';
const BASE = (process.env.VERIFY_BASE_URL || 'http://127.0.0.1:3464').replace(/\/$/, '');
const API = `${BASE}/schedule-tracker-api`;

function resolveToken() {
  if (process.env.SCHEDULE_API_TOKEN) return process.env.SCHEDULE_API_TOKEN;
  try {
    const out = execSync('systemctl show schedule-tracker -p Environment', { encoding: 'utf8' });
    const m = out.match(/SCHEDULE_API_TOKEN=(\S+)/);
    if (m) return m[1];
  } catch { /* systemd not available — fall through */ }
  return '';
}

const TOKEN = resolveToken();
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());

const results = [];
function record(group, name, ok, detail) {
  results.push({ group, name, ok, detail: detail == null ? '' : String(detail) });
}

async function hit(name, method, pathname, { body, expect = 200, auth = true, validate } = {}) {
  const url = `${API}${pathname}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && TOKEN ? { 'x-api-token': TOKEN } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status !== expect) {
      record('endpoints', name, false, `${method} ${pathname} -> ${res.status}, очікував ${expect}`);
      return null;
    }
    let payload = null;
    const text = await res.text();
    if (text) { try { payload = JSON.parse(text); } catch { payload = text; } }
    if (validate) {
      const problem = validate(payload);
      if (problem) { record('endpoints', name, false, problem); return payload; }
    }
    record('endpoints', name, true, `${res.status}`);
    return payload;
  } catch (err) {
    record('endpoints', name, false, `${method} ${pathname} -> ${err.message}`);
    return null;
  }
}

const isArray = (label) => (p) => (Array.isArray(p) ? null : `${label}: очікував масив, отримав ${typeof p}`);
const hasKeys = (...keys) => (p) => {
  if (!p || typeof p !== 'object') return `очікував обʼєкт, отримав ${typeof p}`;
  const missing = keys.filter((k) => !(k in p));
  return missing.length ? `нема полів: ${missing.join(', ')}` : null;
};

async function checkEndpoints() {
  if (!TOKEN) {
    record('endpoints', 'SCHEDULE_API_TOKEN', false, 'токен не знайдено ні в env, ні в systemd — усі виклики впадуть у 401');
  } else {
    record('endpoints', 'SCHEDULE_API_TOKEN', true, `знайдено (${TOKEN.length} символів)`);
  }

  // auth must actually bite
  await hit('auth: без токена -> 401', 'GET', '/projects', { auth: false, expect: 401 });

  await hit('GET /projects', 'GET', '/projects', { validate: isArray('projects') });
  await hit('GET /projects?status=active', 'GET', '/projects?status=active', { validate: isArray('projects') });
  await hit('GET /projects/menu', 'GET', '/projects/menu?mode=head');
  await hit('GET /day (hands)', 'GET', '/day?mode=hands', { validate: hasKeys('obligation', 'topics') });
  await hit('GET /day (head)', 'GET', '/day?mode=head', { validate: hasKeys('obligation', 'topics') });
  await hit('GET /day (ears)', 'GET', '/day?mode=ears', { validate: hasKeys('obligation', 'topics') });
  await hit('GET /capture', 'GET', `/capture?day=${TODAY}`);
  await hit('GET /captures', 'GET', '/captures?days=7', { validate: isArray('captures') });
  await hit('GET /stats', 'GET', '/stats');
  await hit('GET /stats/energy-by-project', 'GET', '/stats/energy-by-project', { validate: isArray('energy-by-project') });
  await hit('GET /day-items', 'GET', `/day-items?day=${TODAY}`, { validate: isArray('day-items') });
  await hit('GET /parked-reviews/next', 'GET', '/parked-reviews/next?n=2', { validate: isArray('parked-reviews') });
  await hit('GET /habits-nudge-check', 'GET', '/habits-nudge-check', { validate: hasKeys('shouldSend') });
  await hit('GET /flags', 'GET', '/flags', { validate: isArray('flags') });
  await hit('GET /meetings', 'GET', '/meetings?hours=24', { validate: isArray('meetings') });
  await hit('GET /counter', 'GET', '/counter');
  await hit('GET /legacy-history', 'GET', '/legacy-history');
  await hit('GET /pomodoro/active', 'GET', '/pomodoro/active');
  await hit('GET /push/vapid-public-key', 'GET', '/push/vapid-public-key');

  // idempotent write path: claim a throwaway key twice, must be true then false
  const key = `verify:${Date.now()}`;
  const first = await hit('POST /meeting-ping-claim (1-й раз)', 'POST', '/meeting-ping-claim', {
    body: { key }, validate: (p) => (p && p.claimed === true ? null : `очікував claimed=true, отримав ${JSON.stringify(p)}`),
  });
  if (first) {
    await hit('POST /meeting-ping-claim (дедуп)', 'POST', '/meeting-ping-claim', {
      body: { key }, validate: (p) => (p && p.claimed === false ? null : `очікував claimed=false, отримав ${JSON.stringify(p)}`),
    });
    await hit('POST /flags/clear (прибрати за собою)', 'POST', '/flags/clear', {
      body: { key: `meeting_ping:${key}` },
      validate: (p) => (p && p.cleared === true ? null : `очікував cleared=true, отримав ${JSON.stringify(p)}`),
    });
  }

  // compat routes carried over from the Calendar era (paths only — they run on
  // day_items now). Only the read and validation paths are exercised here, so a
  // verify run never leaves a stray day_items row behind.
  const WEEK_OUT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date(Date.now() + 7 * 86400000));
  await hit('GET /calendar (сьогодні +7)', 'GET', `/calendar?from=${TODAY}&to=${WEEK_OUT}`, {
    validate: (p) => (p && typeof p === 'object' && !Array.isArray(p)
      ? null
      : `очікував обʼєкт день->події, отримав ${Array.isArray(p) ? 'масив' : typeof p}`),
  });
  await hit('GET /calendar (to < from -> 400)', 'GET', `/calendar?from=${WEEK_OUT}&to=${TODAY}`, { expect: 400 });
  await hit('GET /calendar (>62 днів -> 400)', 'GET', '/calendar?from=2026-01-01&to=2026-12-31', { expect: 400 });
  await hit('GET /calendar (без параметрів -> 400)', 'GET', '/calendar', { expect: 400 });
  await hit('GET /calendar (неіснуюча дата -> 400)', 'GET', '/calendar?from=2026-02-31&to=2026-03-05', { expect: 400 });
  await hit('POST /status (неіснуючий id -> 404)', 'POST', '/status', { body: { id: 999999999, status: 'done' }, expect: 404 });
  await hit('POST /status (невалідний status -> 400)', 'POST', '/status', { body: { id: 1, status: 'maybe' }, expect: 400 });
  await hit('POST /task (порожній title -> 400)', 'POST', '/task', { body: { title: '' }, expect: 400 });

  // static frontend
  try {
    const res = await fetch(`${BASE}/schedule-tracker/`);
    record('endpoints', 'GET /schedule-tracker/ (дашборд)', res.status === 200, `${res.status}`);
  } catch (err) {
    record('endpoints', 'GET /schedule-tracker/ (дашборд)', false, err.message);
  }
}

const EXPECTED_CRONS = [
  'nightly-checkin',
  'nightly-nudge',
  'slot-reminder-morning',
  'slot-reminder-day',
  'slot-reminder-evening',
  'slot-reminder-night',
  'habits-nudge',
  'meetings-poll',
];

function checkBotCrons() {
  const file = path.join(BOT_DIR, 'data', 'crons.json');
  if (!fs.existsSync(file)) {
    record('bot', 'data/crons.json', false, 'нема — бот не стартував після додавання крон-реєстру');
    EXPECTED_CRONS.forEach((n) => record('bot', `cron ${n}`, false, 'реєстр відсутній'));
    return;
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    record('bot', 'data/crons.json', false, `не парситься: ${err.message}`);
    return;
  }
  record('bot', 'data/crons.json', true, `${payload.crons?.length ?? 0} кронів, старт ${payload.started_at}`);

  const byName = new Map((payload.crons || []).map((c) => [c.name, c]));
  EXPECTED_CRONS.forEach((name) => {
    const c = byName.get(name);
    record('bot', `cron ${name}`, Boolean(c), c ? `${c.expr} (${c.tz})` : 'не зареєстрований');
  });

  // the registry is only meaningful if the process that wrote it is still alive
  try {
    process.kill(payload.pid, 0);
    record('bot', 'процес бота живий', true, `pid ${payload.pid}`);
  } catch {
    record('bot', 'процес бота живий', false, `pid ${payload.pid} не відповідає — реєстр від мертвого процесу`);
  }
}

function checkScripts() {
  const expected = [
    [path.join(ROOT, 'scripts/prep-day-run.sh'), true],
    [path.join(ROOT, 'scripts/day-items-to-craft.sh'), true],
    [path.join(ROOT, 'scripts/verify.mjs'), false],
    [path.join(ROOT, 'scripts/hash-password.js'), false],
    ['/root/claude-config/skills/user/prep-day/SKILL.md', false],
    [path.join(ROOT, 'config/spice.json'), false],
    [path.join(ROOT, 'config/baseline.json'), false],
  ];
  for (const [file, needsExec] of expected) {
    if (!fs.existsSync(file)) { record('files', path.basename(file), false, `нема: ${file}`); continue; }
    if (needsExec) {
      const mode = fs.statSync(file).mode;
      const exec = Boolean(mode & 0o111);
      record('files', path.basename(file), exec, exec ? 'є, executable' : 'є, але БЕЗ executable-біта');
    } else {
      record('files', path.basename(file), true, 'є');
    }
  }

  // spice.json must have all seven days and all of them enabled
  try {
    const spice = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/spice.json'), 'utf8'));
    const days = spice.map((x) => x.day);
    const want = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const missing = want.filter((d) => !days.includes(d));
    const disabled = spice.filter((x) => !x.enabled).map((x) => x.day);
    record('files', 'spice.json: 7 днів', missing.length === 0, missing.length ? `нема: ${missing.join(', ')}` : '7/7');
    record('files', 'spice.json: усі увімкнені', disabled.length === 0, disabled.length ? `вимкнені: ${disabled.join(', ')}` : 'усі enabled');
  } catch (err) {
    record('files', 'spice.json', false, err.message);
  }
}

function checkDeadFiles() {
  const dead = [
    [path.join(ROOT, 'migrate-legacy-to-calendar.js'), 'скрипт ери Calendar-write'],
    [path.join(ROOT, 'config/token.json'), 'мертвий OAuth-токен'],
    [path.join(ROOT, 'config/oauth-client.json'), 'мертвий OAuth-клієнт'],
    [path.join(ROOT, 'auth.js'), 'OAuth-флоу'],
    [path.join(ROOT, 'setup-auth.js'), 'OAuth-сетап'],
  ];
  for (const [file, why] of dead) {
    const gone = !fs.existsSync(file);
    record('legacy', `видалено: ${path.basename(file)}`, gone, gone ? why : `ВСЕ ЩЕ НА ДИСКУ (${why})`);
  }

  // no Calendar write calls may creep back into calendar.js
  try {
    const cal = fs.readFileSync(path.join(ROOT, 'calendar.js'), 'utf8');
    const bad = /googleapis|setEventStatus|events\.(insert|patch|update|delete)/.test(cal);
    record('legacy', 'calendar.js без write-викликів', !bad, bad ? 'знайдено запис у Calendar API' : 'тільки iCal-читання');
  } catch (err) {
    record('legacy', 'calendar.js', false, err.message);
  }

  // the prep-day skill must not create calendar events or read Notion any more
  try {
    const skill = fs.readFileSync('/root/claude-config/skills/user/prep-day/SKILL.md', 'utf8');
    const createsEvents = /create_event/.test(skill);
    record('legacy', 'prep-day не пише в Calendar', !createsEvents, createsEvents ? 'знайдено create_event' : 'жодного create_event');
    // The skill is allowed (and expected) to *name* the removed pieces in its
    // "чого тут свідомо немає" block and in the section-order guard. What must
    // be gone is any actual instruction to call Notion.
    const callsNotion = /Notion:notion-|notion-query-data-sources|notion-search/.test(skill);
    record('legacy', 'prep-day не ходить у Notion', !callsNotion, callsNotion ? 'знайдено виклик Notion MCP' : 'жодного виклику Notion');
    const notionStep = /^##\s*Step\s+\d[^\n]*Notion/m.test(skill);
    record('legacy', 'prep-day без кроку Notion-кандидатів', !notionStep, notionStep ? 'крок Notion ще існує' : 'кроку нема');
    const spiceDaily = /Блок є \*\*кожен день\*\*/.test(skill);
    record('legacy', 'prep-day: spice щодня', spiceDaily, spiceDaily ? 'зафіксовано в скілі' : 'формулювання "кожен день" не знайдено');
    const humor = /Step 3\.5/.test(skill);
    record('legacy', 'prep-day: блок гумору', humor, humor ? 'Step 3.5 присутній' : 'нема');
  } catch (err) {
    record('legacy', 'prep-day SKILL.md', false, err.message);
  }
}

function printTable() {
  const w1 = Math.max(...results.map((r) => r.name.length), 6);
  const groups = [...new Set(results.map((r) => r.group))];
  const LABELS = { endpoints: 'ЕНДПОІНТИ', bot: 'БОТ / КРОНИ', files: 'ФАЙЛИ І КОНФІГИ', legacy: 'ЛЕГАСІ ПРИБРАНО' };
  for (const g of groups) {
    console.log(`\n── ${LABELS[g] || g} ${'─'.repeat(Math.max(0, 60 - (LABELS[g] || g).length))}`);
    for (const r of results.filter((x) => x.group === g)) {
      console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name.padEnd(w1)}  ${r.detail}`);
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`Разом: ${results.length - failed.length}/${results.length} OK, ${failed.length} FAIL`);
  if (failed.length) {
    console.log('\nЩо впало:');
    failed.forEach((r) => console.log(`  - [${r.group}] ${r.name}: ${r.detail}`));
  }
  return failed.length === 0;
}

async function main() {
  console.log(`schedule-tracker verify — ${new Date().toISOString()}`);
  console.log(`base: ${BASE}   день (Kyiv): ${TODAY}`);
  await checkEndpoints();
  checkBotCrons();
  checkScripts();
  checkDeadFiles();
  process.exitCode = printTable() ? 0 : 1;
}

main();
