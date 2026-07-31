const ical = require('node-ical');

const ICAL_URL = process.env.ICAL_URL;
if (!ICAL_URL) throw new Error('ICAL_URL env var required (Google Calendar → Settings → your calendar → "Secret address in iCal format")');
const CACHE_TTL = 60 * 1000;

// ---- read via iCal feed (Calendar is read-only post-2026-07-31: meetings only, see store.js for the task/theme source of truth) ----

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
    const allDay = ev.datetype === 'date' || Boolean(ev.start?.dateOnly);

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
        results.push({ uid: ev.uid, start: realStart, end: new Date(realStart.getTime() + duration), summary, description, allDay, hasAttendees: Boolean(ev.attendee) });
      }
    } else {
      if (ev.start < rangeEnd && ev.end > rangeStart) {
        results.push({ uid: ev.uid, start: ev.start, end: ev.end, summary: ev.summary, description: descOf(ev.description), allDay, hasAttendees: Boolean(ev.attendee) });
      }
    }
  }
  return results;
}

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' });

// ---- meetings (the only thing Calendar remains source-of-truth for, post-2026-07-31) ----
// A "real meeting" is an event with attendees or an explicit [meet] tag in the title —
// everything else in the calendar is noise from the retired task-tracking era.
function isMeeting(ev) {
  return Boolean(ev.hasAttendees) || /\[meet\]/i.test(ev.summary || '');
}

async function getMeetingsInRange(hours = 24) {
  const now = new Date();
  const fromStr = dateFmt.format(now);
  const toStr = dateFmt.format(new Date(now.getTime() + hours * 3600 * 1000));
  const events = await getEventsInRange(fromStr, toStr);
  const rangeEnd = new Date(now.getTime() + hours * 3600 * 1000);
  return events
    .filter(e => !e.allDay && isMeeting(e) && e.start >= now && e.start <= rangeEnd)
    .map(e => ({ uid: e.uid, start: e.start.toISOString(), end: e.end.toISOString(), summary: e.summary, description: e.description || '' }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

// isMeeting is exported so GET /calendar can flag meetings with exactly the same
// predicate getMeetingsInRange filters by — two copies of "what counts as a meeting"
// would drift apart the first time the [meet] convention changes.
module.exports = { getEventsInRange, getMeetingsInRange, isMeeting };
