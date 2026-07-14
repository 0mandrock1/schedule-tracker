const fs = require('fs');
const path = require('path');
const { calendarByDate, setEventStatus } = require('./calendar');

const LEGACY_FILE = path.join(__dirname, 'legacy-import.json');
const TOLERANCE_MIN = 15;

function parseSlotKey(slotKey) {
  const m = slotKey.match(/^(\d{4}-\d{2}-\d{2})_([a-z]*)_(.+)$/);
  if (!m) return null;
  const [, date, kind, timeLabel] = m;
  const firstPart = timeLabel.split('-')[0];
  let startMin;
  if (firstPart.includes(':')) {
    const [h, mm] = firstPart.split(':').map(Number);
    startMin = h * 60 + mm;
  } else {
    startMin = parseInt(firstPart, 10) * 60;
  }
  return { date, kind, timeLabel, startMin };
}

async function main() {
  const legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
  const byDate = {};
  for (const [slotKey, status] of Object.entries(legacy)) {
    if (status !== 'done' && status !== 'skipped') continue;
    const parsed = parseSlotKey(slotKey);
    if (!parsed) { console.log('UNPARSED', slotKey); continue; }
    (byDate[parsed.date] = byDate[parsed.date] || []).push({ slotKey, status, ...parsed });
  }

  let matched = 0, unmatched = 0;
  const unmatchedKeys = [];

  for (const date of Object.keys(byDate).sort()) {
    const dayEvents = (await calendarByDate(date, date))[date] || [];
    for (const entry of byDate[date]) {
      let best = null, bestDiff = Infinity;
      for (const ev of dayEvents) {
        const diff = Math.abs(ev.startMin - entry.startMin);
        if (diff < bestDiff) { bestDiff = diff; best = ev; }
      }
      if (best && bestDiff <= TOLERANCE_MIN) {
        try {
          await setEventStatus(best.uid, best.start, entry.status);
          matched++;
          console.log(`OK ${entry.slotKey} -> "${best.title}" (${entry.status})`);
        } catch (err) {
          unmatched++;
          unmatchedKeys.push(entry.slotKey);
          console.log(`FAIL ${entry.slotKey}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 150));
      } else {
        unmatched++;
        unmatchedKeys.push(entry.slotKey);
        console.log(`NO MATCH ${entry.slotKey} (closest diff=${bestDiff})`);
      }
    }
  }

  console.log(`\nDone. matched=${matched} unmatched=${unmatched}`);
  if (unmatchedKeys.length) console.log('Unmatched:', unmatchedKeys.join(', '));
}

main().catch(err => { console.error(err); process.exit(1); });
