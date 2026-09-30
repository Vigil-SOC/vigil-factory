#!/bin/zsh
# Tell Sam something needs a human: a macOS notification, and a line in
# telemetry/babysit/ALERTS.md so it outlives the notification.
# Usage: alert.sh "<title>" "<message>"
set -u
ROOT="/Users/armstrongflg/deeptempo-factory"
title="Factory: ${1:-alert}"
msg="${2:-}"
mkdir -p "$ROOT/telemetry/babysit"
printf '\n## %s — %s\n%s\n' "$(date -u +%FT%TZ)" "$title" "$msg" >> "$ROOT/telemetry/babysit/ALERTS.md"
osascript -e 'on run argv' \
  -e 'display notification (item 2 of argv) with title (item 1 of argv) subtitle "see telemetry/babysit/ALERTS.md" sound name "Basso"' \
  -e 'end run' "$title" "$msg"
