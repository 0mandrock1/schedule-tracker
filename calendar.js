const ical = require('node-ical');
const { google } = require('googleapis');
const { getAuthedClient } = require('./auth');

const ICAL_URL = process.env.ICAL_URL;
if (!ICAL_URL) throw new Error('ICAL_URL env var required (Google Calendar → Settings → your calendar → "Secret address in iCal format")');
const CACHE_TTL = 60 * 1000;
const CALENDAR_ID = 'primary';

const DONE_PREFIX = '✅ ';
const SKIPPED_PREFIX = '❌ ';
const COLOR_DONE = '10';
const COLOR_SKIPPED = '11';

// TODO if a real 5th+ status is ever wanted (not a marker/tag): this title-prefix + colorId
// scheme is deliberately not extended for phase 4's markers feature, because Calendar
// colorId only has ~11 values and prefix-matching gets fragile past two states. A real
// new status needs its own design pass here (prefix table, color mapping, stripPrefix/
// applyPrefix rewrite) — don't bolt it onto markers silently.
function stripPrefix(title) {
  if (title.startsWith(DONE_PREFIX)) return { status: 'done', title: title.slice(DONE_PREFIX.length) };
  if (title.startsWith(SKIPPED_PREFIX)) return { status: 'skipped', title: title.slice(SKIPPED_PREFIX.length) };
  return { status: 'pending', title };
}

function applyPrefix(title, status) {
  const prefix = status === 'done' ? DONE_PREFIX : status === 'skipped' ? SKIPPED_PREFIX : '';
  return prefix + title;
}

function colorForStatus(status) {
  return status === 'done' ? COLOR_DONE : status === 'skipped' ? COLOR_SKIPPED : null;
}

// ---- read via iCal feed (fast, no quota) ----

let icalCache = { data: null, ts: 0 };

async function getIcalData() {
  const now = Date.now();
  if (icalCache.data && (now - icalCache.ts) < CACHE_TTL) return icalCache.data;
  const data = await ical.async.fromURL(ICAL_URL);
  icalCache = { data, ts: now };
  return data;
}

function descOf(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.trim();
  if (typeof d === 'object' && typeof d.val === 'string') return d.val.trim();
  return '';
}

function getRRuleCorrection(ev) {
  try {
    const s = ev.start;
    const dayStart = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate(), 0, 0, 0));
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    const occ = ev.rrule.between(dayStart, dayEnd, true);
    if (!occ.length) return 0;
    let best = occ[0], bestDiff = Math.abs(occ[0].getTime() - s.getTime());
    for (const o of occ) {
      const d = Math.abs(o.getTime() - s.getTime());
      if (d < bestDiff) { bestDiff = d; best = o; }
    }
    return s.getTime() - best.getTime();
  } catch (e) {
    return 0;
  }
}

async function getEventsInRange(fromStr, toStr) {
  const data = await getIcalData();
  const rangeStart = new Date(fromStr + 'T00:00:00Z');
  const rangeEnd = new Date(toStr + 'T23:59:59Z');
  const results = [];

  for (const k of Object.keys(data)) {
    const ev = data[k];
    if (!ev || ev.type !== 'VEVENT' || !ev.start || !ev.end) continue;
    const duration = ev.end.getTime() - ev.start.getTime();

    if (ev.rrule) {
      const correction = getRRuleCorrection(ev);
      let occs;
      try { occs = ev.rrule.between(rangeStart, rangeEnd, true); } catch (e) { occs = []; }
      for (const o of occs) {
        if (ev.exdate) {
          const excluded = Object.values(ev.exdate).some(ex => Math.abs(ex.getTime() - o.getTime()) < 60000);
          if (excluded) continue;
        }
        let summary = ev.summary, description = descOf(ev.description);
        if (ev.recurrences) {
          const dateKey = Object.keys(ev.recurrences).find(dk => Math.abs(new Date(dk).getTime() - o.getTime()) < 60000);
          if (dateKey) {
            const ov = ev.recurrences[dateKey];
            summary = ov.summary || summary;
            description = descOf(ov.description) || description;
          }
        }
        const realStart = new Date(o.getTime() + correction);
        results.push({ uid: ev.uid, start: realStart, end: new Date(realStart.getTime() + duration), summary, description, colorId: ev.color || null });
      }
    } else {
      if (ev.start < rangeEnd && ev.end > rangeStart) {
        results.push({ uid: ev.uid, start: ev.start, end: ev.end, summary: ev.summary, description: descOf(ev.description), colorId: ev.color || null });
      }
    }
  }
  return results;
}

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kiev', hour: '2-digit', minute: '2-digit', hour12: false });

async function calendarByDate(fromStr, toStr) {
  const events = await getEventsInRange(fromStr, toStr);
  const byDate = {};
  for (const e of events) {
    const dateKey = dateFmt.format(e.start);
    const [sh, sm] = timeFmt.format(e.start).split(':').map(Number);
    const [eh, em] = timeFmt.format(e.end).split(':').map(Number);
    const { status, title } = stripPrefix(e.summary || '');
    (byDate[dateKey] = byDate[dateKey] || []).push({
      uid: e.uid,
      start: e.start.toISOString(),
      end: e.end.toISOString(),
      startMin: sh * 60 + sm,
      endMin: eh * 60 + em,
      title,
      status,
      description: e.description || ''
    });
  }
  return byDate;
}

// ---- write via Calendar API (mutations only, low volume, quota-safe) ----

async function getCalendarClient() {
  const auth = getAuthedClient();
  return google.calendar({ version: 'v3', auth });
}

// iCal gives us a stable UID (same across all recurrence instances); the
// Calendar API needs the per-instance event id, which differs per
// occurrence. Resolve it by listing events matching that iCalUID within a
// tight window around the known occurrence start.
async function resolveInstanceEventId(cal, calendarId, uid, startISO) {
  const start = new Date(startISO);
  const timeMin = new Date(start.getTime() - 24 * 3600 * 1000).toISOString();
  const timeMax = new Date(start.getTime() + 24 * 3600 * 1000).toISOString();
  const { data } = await cal.events.list({ calendarId, iCalUID: uid, timeMin, timeMax, singleEvents: true });
  const items = data.items || [];
  let best = null, bestDiff = Infinity;
  for (const it of items) {
    const s = new Date(it.start.dateTime || it.start.date);
    const diff = Math.abs(s.getTime() - start.getTime());
    if (diff < bestDiff) { bestDiff = diff; best = it; }
  }
  if (!best) throw new Error(`no calendar instance found for uid=${uid} near ${startISO}`);
  return best.id;
}

async function setEventStatus(uid, startISO, status, calendarId = CALENDAR_ID) {
  const cal = await getCalendarClient();
  const eventId = await resolveInstanceEventId(cal, calendarId, uid, startISO);
  const { data: ev } = await cal.events.get({ calendarId, eventId });
  const { title: bareTitle } = stripPrefix(ev.summary || '');
  const newTitle = applyPrefix(bareTitle, status);
  const color = colorForStatus(status);
  const { data } = await cal.events.patch({
    calendarId,
    eventId,
    requestBody: { summary: newTitle, colorId: color || undefined }
  });
  icalCache = { data: null, ts: 0 };
  return data;
}

async function setEventMarkers(uid, startISO, markers, calendarId = CALENDAR_ID) {
  const cal = await getCalendarClient();
  const eventId = await resolveInstanceEventId(cal, calendarId, uid, startISO);
  const { data } = await cal.events.patch({
    calendarId,
    eventId,
    requestBody: { extendedProperties: { private: { markers: JSON.stringify(markers) } } }
  });
  return data;
}

async function createTask({ title, start, end }, calendarId = CALENDAR_ID) {
  const cal = await getCalendarClient();
  const { data } = await cal.events.insert({
    calendarId,
    requestBody: { summary: title, start: { dateTime: start }, end: { dateTime: end } }
  });
  icalCache = { data: null, ts: 0 };
  return data;
}

async function deleteTask(uid, startISO, calendarId = CALENDAR_ID) {
  const cal = await getCalendarClient();
  const eventId = await resolveInstanceEventId(cal, calendarId, uid, startISO);
  await cal.events.delete({ calendarId, eventId });
  icalCache = { data: null, ts: 0 };
}

async function rescheduleTask(uid, startISO, newStart, newEnd, calendarId = CALENDAR_ID) {
  const cal = await getCalendarClient();
  const eventId = await resolveInstanceEventId(cal, calendarId, uid, startISO);
  const { data } = await cal.events.patch({
    calendarId,
    eventId,
    requestBody: { start: { dateTime: newStart }, end: { dateTime: newEnd } }
  });
  icalCache = { data: null, ts: 0 };
  return data;
}

module.exports = {
  calendarByDate, getEventsInRange, setEventStatus, setEventMarkers, stripPrefix,
  createTask, deleteTask, rescheduleTask
};
