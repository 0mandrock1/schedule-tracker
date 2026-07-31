#!/usr/bin/env bash
# Mirrors today's day_items checklist into the "Заняття на день" section of
# today's prep-day Craft doc ("План дня — DD.MM.YYYY"). Craft is a mirror of
# the day_items table, not a source of truth — if this fails the Telegram
# checklist keeps working regardless.
# Usage: scripts/day-items-to-craft.sh [YYYY-MM-DD]   (default: today, Kyiv)
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$DIR/logs"
mkdir -p "$LOG_DIR"

DAY="${1:-$(TZ=Europe/Kyiv date +%F)}"
FAILLOG="$LOG_DIR/day-items-craft.log"
LOCK="$LOG_DIR/day-items-craft-$DAY.lock"
RUNLOG="$LOG_DIR/day-items-craft-$DAY.log"

# Serialize concurrent runs against the same day's doc (generate + evening
# reconciliation + slot taps can fire close together).
#
# Раніше тут був простий `flock -w 30`, і це був баг: сам прогін триває ~45-60 с
# (це повний `claude -p`), тобто таймаут очікування був КОРОТШИЙ за роботу, на яку
# він чекає. Два синки поспіль -> третій гарантовано падав з "lock timeout" і бот
# писав «у Craft не поїхало», хоча насправді все синхронізувалось.
#
# Тепер схема "один бігає + один чекає":
#   WAITLOCK — слот черги. Хто його не взяв, той третій-зайвий і виходить 0:
#              той, хто вже стоїть у черзі, все одно прочитає найсвіжіший стан,
#              коли до нього дійде. Це sync-to-current-state, а не черга подій.
#   LOCK     — власне робочий лок, чекаємо на нього щедро (5 хв).
WAITLOCK="$LOG_DIR/day-items-craft-$DAY.wait"

exec 8>"$WAITLOCK"
if ! flock -n 8; then
  echo "[day-items-to-craft] $(date -Is) already queued for $DAY, skipping (не помилка)" >> "$RUNLOG"
  echo "OK"
  exit 0
fi

exec 9>"$LOCK"
if ! flock -w 300 9; then
  echo "FAILED: lock timeout 300s for $DAY" | tee -a "$FAILLOG"
  exit 1
fi
flock -u 8   # звільняємо слот черги — з цього моменту наступний може ставати в неї

echo "[day-items-to-craft] day=$DAY starting $(date -Is)" >> "$RUNLOG"

PROMPT=$(cat <<PROMPT_EOF
Sync today's day_items checklist into the prep-day Craft doc for $DAY. No chat output needed, just do the work.

1. GET http://127.0.0.1:3464/schedule-tracker-api/day-items?day=$DAY with header
   x-api-token: \$SCHEDULE_API_TOKEN (read the token from systemd:
   \`systemctl show schedule-tracker -p Environment\` — field SCHEDULE_API_TOKEN).
   If the request fails or returns an empty array, stop and output exactly:
   FAILED: no day_items for $DAY

2. Build markdown grouped by slot, in this order: morning, day, evening, night,
   then items with no slot last. Skip items with kind "baseline" entirely (they
   are background, never shown). Within a group, item order = API order.
   Slot group headers (only emit a header if that group is non-empty):
   **Ранок**, **День**, **Вечір**, **Ніч**, **Без слоту**.
   Per item line:
   - kind icon: obligation=🎯 habit=🔁 theme=📌 hook=👆
   - done=yes -> "- [x] {icon} {title}"
   - done=partial -> "- [ ] {icon} {title} (~ пощупав)"
   - done=no or null -> "- [ ] {icon} {title}"

3. Find today's prep-day Craft doc via Craft:craft_read (search/list by title
   "План дня — $(TZ=Europe/Kyiv date -d "$DAY" +%d.%m.%Y 2>/dev/null || date -j -f %F "$DAY" +%d.%m.%Y 2>/dev/null || echo "$DAY")"
   in folder Dev (418c15d1) or Personal (b337b265) — check both. If not found,
   stop and output exactly: FAILED: no prep-day doc for $DAY

4. Inside that doc, find a block/section titled "Заняття на день". If it exists,
   replace its content with the markdown from step 2 (Craft:craft_write blocks
   update — do not touch other sections, do not duplicate the section). If it
   doesn't exist yet, append a new section with that title and the markdown
   from step 2 at the end of the doc.

5. On success output exactly: OK
PROMPT_EOF
)

ATTEMPT=1
while :; do
  OUTPUT="$(cd "$DIR" && claude -p "$PROMPT" --model sonnet < /dev/null 2>>"$RUNLOG")"
  STATUS=$?
  if [ "$STATUS" -eq 0 ] && ! echo "$OUTPUT" | grep -qiE '529|overloaded|rate limit|usage limit'; then break; fi
  if [ "$ATTEMPT" -ge 3 ]; then break; fi
  echo "[day-items-to-craft] attempt $ATTEMPT failed (status=$STATUS), retrying in 60s" >> "$RUNLOG"
  ATTEMPT=$((ATTEMPT+1)); sleep 60
done
echo "$OUTPUT" >> "$RUNLOG"
echo "[day-items-to-craft] exit=$STATUS $(date -Is)" >> "$RUNLOG"

RESULT="$(echo "$OUTPUT" | grep -oE '^(OK|FAILED:.*)$' | tail -1)"

if [ "$STATUS" -ne 0 ] || [ -z "$RESULT" ] || [[ "$RESULT" == FAILED:* ]]; then
  MSG="${RESULT:-FAILED: no result from claude -p, exit=$STATUS}"
  echo "$(date -Is) day=$DAY $MSG" >> "$FAILLOG"
  echo "$MSG"
  exit 1
fi

echo "OK"
