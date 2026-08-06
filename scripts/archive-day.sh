#!/usr/bin/env bash
# Archives a day's rendered plan (day_plans.md, with day_items completion marks) into
# a single Craft doc under folder Archive/days — "День — DD.MM.YYYY". Default: yesterday
# (Kyiv). The live plan on mandrock-tools is the only daytime source of truth; this is
# a cold-storage copy, not a duplicate live surface.
# Usage: scripts/archive-day.sh [YYYY-MM-DD]
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$DIR/logs"
mkdir -p "$LOG_DIR"

DAY="${1:-$(TZ=Europe/Kyiv date -d 'yesterday' +%F)}"
MARKER="$LOG_DIR/archive-day-$DAY.done"
LOCK="$LOG_DIR/archive-day-$DAY.lock"
RUNLOG="$LOG_DIR/archive-day.log"

if [ -f "$MARKER" ]; then
  cat "$MARKER"
  exit 0
fi

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[archive-day] lock busy for $DAY, another run in flight — exiting $(date -Is)" | tee -a "$RUNLOG" >&2
  exit 0
fi

if [ -f "$MARKER" ]; then
  cat "$MARKER"
  exit 0
fi

echo "[archive-day] day=$DAY starting $(date -Is)" >> "$RUNLOG"

TITLE_DATE="$(date -d "$DAY" +%d.%m.%Y 2>/dev/null || echo "$DAY")"

PROMPT="Архівуй план дня $DAY у Craft. Working directory /root/projects/schedule-tracker.
1. Токен: TOKEN=\$(systemctl show schedule-tracker -p Environment --value | tr ' ' '\n' | sed -n 's/^SCHEDULE_API_TOKEN=//p') — ніколи не друкуй значення.
2. GET http://127.0.0.1:3464/schedule-tracker-api/day-plan/$DAY з заголовком x-api-token: \$TOKEN. Якщо 404 — плану на цей день немає, зупинись і виведи рівно 'NO PLAN FOR $DAY', нічого в Craft не пиши.
3. Якщо є — візьми поле md (готовий markdown плану дня, включно з блоком Магія і рештою).
4. GET http://127.0.0.1:3464/schedule-tracker-api/day-items?day=$DAY з тим самим токеном — познач у копії тексту плану виконання по кожній таску (done=yes -> ✅ перед назвою, done=no -> ❌, done=partial -> 〜, done=null/невизначено -> без позначки), не змінюючи решту форматування.
5. Через Craft MCP (mcp__claude_ai_Craft__craft_read / craft_write): переконайся, що існує тека 'Archive', а в ній підтека 'days' (шукай craft_read, створи craft_write якщо відсутня — не дублюй, якщо вже є).
6. Створи в 'Archive/days' новий документ з назвою рівно 'День — $TITLE_DATE' і вмістом — той самий md-текст із позначками виконання з кроку 4.
7. Останнім рядком виведи рівно URL створеного документа (https://docs.craft.do/editor/d/...) і нічого більше."

ATTEMPT=1
STATUS=1
OUTPUT=""
while :; do
  OUTPUT="$(cd "$DIR" && claude -p "$PROMPT" --model sonnet --allowedTools "Bash Read mcp__claude_ai_Craft" < /dev/null 2>>"$RUNLOG")"
  STATUS=$?
  if [ "$STATUS" -eq 0 ] && ! echo "$OUTPUT" | grep -qiE '529|overloaded|rate limit|usage limit'; then break; fi
  if [ "$ATTEMPT" -ge 3 ]; then break; fi
  echo "[archive-day] attempt $ATTEMPT failed (status=$STATUS), retrying in 60s" >> "$RUNLOG"
  ATTEMPT=$((ATTEMPT + 1))
  sleep 60
done
echo "$OUTPUT" >> "$RUNLOG"
echo "[archive-day] exit=$STATUS $(date -Is)" >> "$RUNLOG"

if [ "$STATUS" -ne 0 ]; then
  echo "FAILED: archive-day exited $STATUS — see $RUNLOG" >&2
  exit 1
fi

if echo "$OUTPUT" | grep -q "^NO PLAN FOR $DAY$"; then
  echo "NO PLAN FOR $DAY"
  exit 0
fi

URL="$(echo "$OUTPUT" | grep -oE 'https://docs\.craft\.do/editor/d/[A-Za-z0-9./_-]+' | tail -1)"
if [ -z "$URL" ]; then
  echo "FAILED: no Craft URL found in archive-day output — see $RUNLOG" >&2
  exit 1
fi

echo "$URL" > "$MARKER"
echo "$URL"
