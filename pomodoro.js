const webpush = require('web-push');
const { db } = require('./db');

// Overridable via env for fast test cycles (scripts/verify.mjs pomodoro) — real values are the defaults.
const DURATIONS = {
  work: parseInt(process.env.POMO_WORK_SEC || '1500', 10),
  short_break: parseInt(process.env.POMO_SHORT_BREAK_SEC || '300', 10),
  long_break: parseInt(process.env.POMO_LONG_BREAK_SEC || '900', 10)
};

const PHASE_LABELS = { work: 'Робота', short_break: 'Перерва', long_break: 'Довга перерва' };

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:0mandrock1@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// work(25) -> short_break(5) x3, 4th work -> long_break(15) -> back to work, cycleCount resets
function nextPhase(phase, cycleCount) {
  if (phase === 'work') {
    return cycleCount >= 4 ? { phase: 'long_break', cycleCount } : { phase: 'short_break', cycleCount };
  }
  if (phase === 'short_break') return { phase: 'work', cycleCount: cycleCount + 1 };
  return { phase: 'work', cycleCount: 1 }; // long_break -> work
}

function getActiveState() {
  return db.prepare('SELECT * FROM pomodoro_state WHERE id = 1').get();
}

function closeCurrentLog(completed) {
  const st = getActiveState();
  if (!st || !st.logId) return;
  db.prepare(`
    UPDATE pomodoro_log SET endedAt = datetime('now'), completed = ?,
    durationSec = CAST((julianday('now') - julianday(startedAt)) * 86400 AS INTEGER)
    WHERE id = ?
  `).run(completed ? 1 : 0, st.logId);
}

function beginPhase(phase, cycleCount, eventId) {
  const startedAt = new Date().toISOString();
  const logInfo = db.prepare(`
    INSERT INTO pomodoro_log (eventId, startedAt, phase, cycleCount) VALUES (?, ?, ?, ?)
  `).run(eventId || null, startedAt, phase, cycleCount);
  db.prepare(`
    INSERT INTO pomodoro_state (id, phase, cycleCount, phaseDurationSec, startedAt, eventId, paused, pausedRemainingSec, logId)
    VALUES (1, ?, ?, ?, ?, ?, 0, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      phase = excluded.phase, cycleCount = excluded.cycleCount, phaseDurationSec = excluded.phaseDurationSec,
      startedAt = excluded.startedAt, eventId = excluded.eventId, paused = 0, pausedRemainingSec = NULL, logId = excluded.logId
  `).run(phase, cycleCount, DURATIONS[phase], startedAt, eventId || null, logInfo.lastInsertRowid);
  return getActiveState();
}

function startCycle(eventId) {
  db.prepare('DELETE FROM pomodoro_state WHERE id = 1').run();
  return beginPhase('work', 1, eventId);
}

function stopCycle(completed) {
  closeCurrentLog(completed);
  db.prepare('DELETE FROM pomodoro_state WHERE id = 1').run();
}

function pauseCycle() {
  const st = getActiveState();
  if (!st || st.paused) return st;
  const elapsed = Math.floor((Date.now() - new Date(st.startedAt).getTime()) / 1000);
  const remaining = Math.max(0, st.phaseDurationSec - elapsed);
  db.prepare('UPDATE pomodoro_state SET paused = 1, pausedRemainingSec = ? WHERE id = 1').run(remaining);
  return getActiveState();
}

function resumeCycle() {
  const st = getActiveState();
  if (!st || !st.paused) return st;
  const newStartedAt = new Date(Date.now() - (st.phaseDurationSec - st.pausedRemainingSec) * 1000).toISOString();
  db.prepare('UPDATE pomodoro_state SET paused = 0, pausedRemainingSec = NULL, startedAt = ? WHERE id = 1').run(newStartedAt);
  return getActiveState();
}

function skipPhase() {
  const st = getActiveState();
  if (!st) return null;
  closeCurrentLog(false);
  const { phase, cycleCount } = nextPhase(st.phase, st.cycleCount);
  const newSt = beginPhase(phase, cycleCount, st.eventId);
  sendPhasePush(newSt);
  return newSt;
}

// Called on GET /pomodoro/active and by the background interval — self-healing:
// if the process restarted or nobody polled for a while, this catches the state up.
function checkAndAdvance(sendPush) {
  const st = getActiveState();
  if (!st || st.paused) return st;
  const elapsed = (Date.now() - new Date(st.startedAt).getTime()) / 1000;
  if (elapsed < st.phaseDurationSec) return st;
  closeCurrentLog(true);
  const { phase, cycleCount } = nextPhase(st.phase, st.cycleCount);
  const newSt = beginPhase(phase, cycleCount, st.eventId);
  if (sendPush) sendPhasePush(newSt);
  return newSt;
}

function stateToJson(st) {
  if (!st) return { active: false };
  const elapsed = Math.floor((Date.now() - new Date(st.startedAt).getTime()) / 1000);
  const remainingSec = st.paused ? st.pausedRemainingSec : Math.max(0, st.phaseDurationSec - elapsed);
  return {
    active: true,
    phase: st.phase,
    phaseLabel: PHASE_LABELS[st.phase],
    cycleCount: st.cycleCount,
    phaseDurationSec: st.phaseDurationSec,
    remainingSec,
    paused: !!st.paused,
    eventId: st.eventId,
    startedAt: st.startedAt
  };
}

async function sendPhasePush(st) {
  if (!process.env.VAPID_PRIVATE_KEY) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  if (!subs.length) return;
  const payload = JSON.stringify({
    title: 'Schedule Tracker',
    body: `Нова фаза: ${PHASE_LABELS[st.phase]}${st.phase === 'work' ? ` (цикл ${st.cycleCount}/4)` : ''}`
  });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(JSON.parse(sub.subscription), payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      }
    }
  }
}

module.exports = {
  DURATIONS, PHASE_LABELS,
  getActiveState, startCycle, stopCycle, pauseCycle, resumeCycle, skipPhase,
  checkAndAdvance, stateToJson, sendPhasePush
};
