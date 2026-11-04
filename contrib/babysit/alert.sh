#!/bin/zsh
# Tell the operator something needs a human: a line in telemetry/babysit/ALERTS.md,
# and on a Mac a notification too (the GCP host has only the file).
# Usage: alert.sh "<title>" "<message>"
set -u
ROOT="${0:A:h:h:h}"
title="Factory: ${1:-alert}"
msg="${2:-}"
mkdir -p "$ROOT/telemetry/babysit"
printf '\n## %s — %s\n%s\n' "$(date -u +%FT%TZ)" "$title" "$msg" >> "$ROOT/telemetry/babysit/ALERTS.md"
command -v osascript >/dev/null 2>&1 || exit 0
osascript -e 'on run argv' \
  -e 'display notification (item 2 of argv) with title (item 1 of argv) subtitle "see telemetry/babysit/ALERTS.md" sound name "Basso"' \
  -e 'end run' "$title" "$msg"
