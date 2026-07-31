#!/usr/bin/env bash
# On-demand prep-day generation, triggered by the bot's /day command.
# Usage: scripts/prep-day-run.sh [mode]
# Dedup: at most one prep-day doc per Kyiv calendar day. Re-invoking the
# same day prints the already-generated Craft URL instead of re-running.
set -uo pipefail

MODE="${1:-}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$DIR/logs"
mkdir -p "$LOG_DIR"

DAY="$(TZ=Europe/Kyiv date +%F)"
MARKER="$LOG_DIR/prep-day-$DAY.done"
LOCK="$LOG_DIR/prep-day-$DAY.lock"
RUNLOG="$LOG_DIR/prep-day-$DAY.log"

if [ -f "$MARKER" ]; then
  cat "$MARKER"
  exit 0
fi

exec 9>"$LOCK"
if ! flock -n 9; then
  # another run is already in flight for today — wait for it instead of double-running
  flock 9
  if [ -f "$MARKER" ]; then
    cat "$MARKER"
    exit 0
  fi
fi

echo "[prep-day-run] mode=$MODE day=$DAY starting $(date -Is)" >> "$RUNLOG"

PROMPT="Прочитай /root/claude-config/skills/user/prep-day/SKILL.md і виконай цей скіл повністю для сьогоднішнього дня (режим: ${MODE:-auto}). Створи денний Craft-документ згідно зі скілом. ОСТАННІМ РЯДКОМ відповіді виведи лише URL створеного документа у форматі https://docs.craft.do/editor/d/... і нічого більше."
ATTEMPT=1
while :; do
  OUTPUT="$(cd "$DIR" && claude -p "$PROMPT" --model sonnet < /dev/null 2>>"$RUNLOG")"
  STATUS=$?
  if [ "$STATUS" -eq 0 ] && ! echo "$OUTPUT" | grep -qiE '529|overloaded|rate limit|usage limit'; then break; fi
  if [ "$ATTEMPT" -ge 3 ]; then break; fi
  echo "[prep-day-run] attempt $ATTEMPT failed (status=$STATUS), retrying in 60s" >> "$RUNLOG"
  ATTEMPT=$((ATTEMPT+1)); sleep 60
done
echo "$OUTPUT" >> "$RUNLOG"
echo "[prep-day-run] exit=$STATUS $(date -Is)" >> "$RUNLOG"

if [ "$STATUS" -ne 0 ]; then
  echo "FAILED: prep-day exited $STATUS — see $RUNLOG" >&2
  exit 1
fi

URL="$(echo "$OUTPUT" | grep -oE 'https://docs\.craft\.do/editor/d/[A-Za-z0-9./_-]+' | head -1)"
if [ -z "$URL" ]; then
  echo "FAILED: no Craft URL found in prep-day output — see $RUNLOG" >&2
  exit 1
fi

echo "$URL" > "$MARKER"
echo "$URL"
