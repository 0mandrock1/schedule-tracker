#!/usr/bin/env bash
# Superseded 2026-08-06 by scripts/generate-day.sh (cron-driven day-plan generator:
# day_items + planer calendar events + rendered day_plans row + header image — no
# Craft doc during the day any more, the live surface is mandrock-tools/day/ now).
# Kept as a thin compat wrapper, not deleted, so existing callers (e.g. the bot's
# /day command) that still invoke this path don't break. Old interface took an
# optional mode ($1, e.g. "hands"); mode selection is now fully automatic
# (store.pickMode), so a mode-shaped $1 is silently ignored. A YYYY-MM-DD $1 is
# treated as an explicit target day and passed through.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARG="${1:-}"

if [[ "$ARG" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  exec "$DIR/scripts/generate-day.sh" "$ARG"
fi

exec "$DIR/scripts/generate-day.sh"
