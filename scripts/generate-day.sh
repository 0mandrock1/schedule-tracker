#!/usr/bin/env bash
# Generates the day plan: day_items + planer calendar events + rendered day_plans
# row, via an internal `claude -p` agent following config/generate-day-prompt.md.
# Usage: scripts/generate-day.sh [YYYY-MM-DD] [--force]
# Dedup: at most one generation per Kyiv day (marker file). --force re-runs anyway.
# Also kicks off the jokediagram-whimsical subagent in the background, ahead of the
# main call, so it has a head start on its own ~5min budget.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$DIR/logs"
mkdir -p "$LOG_DIR"

FORCE=0
DAY=""
for a in "$@"; do
  if [ "$a" = "--force" ]; then FORCE=1; else DAY="$a"; fi
done
DAY="${DAY:-$(TZ=Europe/Kyiv date +%F)}"

MARKER="$LOG_DIR/generate-day-$DAY.done"
LOCK="$LOG_DIR/generate-day.lock"
RUNLOG="$LOG_DIR/generate-day.log"
DAYLOG="$LOG_DIR/generate-day-$DAY.log"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[generate-day] lock busy, another run is in flight — exiting $(date -Is)" | tee -a "$RUNLOG" >&2
  exit 0
fi

if [ -f "$MARKER" ] && [ "$FORCE" -ne 1 ]; then
  echo "[generate-day] day=$DAY already generated (marker present), skipping" >> "$RUNLOG"
  cat "$MARKER"
  exit 0
fi

echo "[generate-day] day=$DAY starting $(date -Is)" >> "$RUNLOG"

# Fire the jokediagram subagent in the background, before the main call, so it has
# the full ~5min budget the prompt polls for. Own log/done files, own failure mode —
# a jokediagram failure never blocks or fails the main run (the prompt just gives up
# on it after 5 minutes and leaves joke_diagram empty).
JOKE_DONE="$LOG_DIR/jokediagram-$DAY.done"
JOKE_OUT="$LOG_DIR/jokediagram-$DAY.out"
JOKE_ERR="$LOG_DIR/jokediagram-$DAY.err"
rm -f "$JOKE_DONE" "$JOKE_OUT"
(
  cd "$DIR" || exit 1
  JOKE_PROMPT="Виклич субагента jokediagram-whimsical (через Task tool, subagent_type=jokediagram-whimsical) для дня $DAY. Режим дня і список тасок субагент бере сам через локальне API, як описано в його інструкції — просто передай йому день $DAY. Виведи РІВНО фінальний блок відповіді субагента (рядок JOKEDIAGRAM: ... і далі CONTENT: ...) і більше нічого."
  claude -p "$JOKE_PROMPT" --model sonnet --allowedTools "Task Bash Read mcp__claude_ai_Whimsical" < /dev/null > "$JOKE_OUT" 2>> "$JOKE_ERR"
  touch "$JOKE_DONE"
) &

PROMPT_TEMPLATE="$(cat "$DIR/config/generate-day-prompt.md")"
PROMPT="${PROMPT_TEMPLATE//\{\{DAY\}\}/$DAY}"

ATTEMPT=1
STATUS=1
OUTPUT=""
while :; do
  # 2>&1: claude prints the session-limit notice on stderr, so stdout-only capture
  # missed it and burned all three retries on a wall we cannot get past.
  OUTPUT="$(cd "$DIR" && claude -p "$PROMPT" --model sonnet --allowedTools "Bash Edit Write Read Glob Grep mcp__claude_ai_Google_Calendar mcp__claude_ai_Craft" < /dev/null 2>&1)"
  STATUS=$?
  printf '%s\n' "$OUTPUT" >> "$DAYLOG"

  # Session limit is NOT a task failure and retrying cannot help — the quota resets
  # on its own clock. Bail out immediately with 75 (EX_TEMPFAIL = "try again later").
  if printf '%s' "$OUTPUT" | grep -qiF 'hit your session limit'; then
    echo "[generate-day] day=$DAY session limit reached — не помилка задачі, прийди пізніше (exit 75) $(date -Is)" | tee -a "$RUNLOG" >&2
    exit 75
  fi

  if [ "$STATUS" -eq 0 ] && ! printf '%s' "$OUTPUT" | grep -qiE '529|overloaded|rate limit|usage limit'; then break; fi
  if [ "$ATTEMPT" -ge 3 ]; then break; fi
  echo "[generate-day] attempt $ATTEMPT failed (status=$STATUS), retrying in 60s" >> "$RUNLOG"
  ATTEMPT=$((ATTEMPT + 1))
  sleep 60
done
echo "[generate-day] exit=$STATUS $(date -Is)" >> "$RUNLOG"

if [ "$STATUS" -ne 0 ]; then
  echo "FAILED: generate-day exited $STATUS — see $DAYLOG" >&2
  exit 1
fi

echo "$DAY" > "$MARKER"
echo "$OUTPUT"
