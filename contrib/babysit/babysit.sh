#!/bin/zsh
# One babysitting pass, for launchd (see com.deeptempo.factory.babysit.plist):
# merge the factory's open PRs, start the next local tick, and alert Sam if
# anything looks wrong. The judgment is a headless Claude session running
# prompt.md; this wrapper only waits out a running tick and alerts if the
# session itself fails.
set -u
ROOT="/Users/armstrongflg/deeptempo-factory"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$ROOT" || exit 1
DIR="$ROOT/telemetry/babysit"
mkdir -p "$DIR"

LOCK="$DIR/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then exit 0; fi
  rm -rf "$LOCK"; mkdir "$LOCK" || exit 1
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# The tick runs on this Mac (contrib/tick-claude-code.sh under launchd) while
# Cursor is out of usage; a pass starts it rather than dispatching the Actions
# tick. A tick still running would make this pass skip its start, and the next
# chance is 90 minutes out, so wait up to 90 minutes for it. The tick's lock
# holds its pid; a lock whose pid is gone is a tick that died.
TICK_JOB="gui/$(id -u)/com.deeptempo.factory.claude-code"
live_tick() {
  kill -0 "$(cat "$ROOT/telemetry/.tick.lock/pid" 2>/dev/null)" 2>/dev/null
}
for _ in {1..45}; do
  live_tick || break
  sleep 120
done

# The interactive login's OAuth session expires and stalled every pass for ~20h
# on 2026-10-08. A long-lived token from `claude setup-token`, kept in this file,
# outlives it.
TOKEN_FILE="$HOME/.config/deeptempo-factory/claude-oauth-token"
[[ -r "$TOKEN_FILE" ]] && export CLAUDE_CODE_OAUTH_TOKEN="$(<"$TOKEN_FILE")"

LOG="$DIR/pass-$(date -u +%Y%m%dT%H%MZ).log"
claude -p "$(cat "$ROOT/contrib/babysit/prompt.md")" --model opus --effort medium --dangerously-skip-permissions > "$LOG" 2>&1
rc=$?
if (( rc != 0 )) || [[ ! -s "$LOG" ]]; then
  # The tick needs no judgment to start, so a failed session still starts it.
  dispatched="no tick was started"
  if ! live_tick && launchctl kickstart "$TICK_JOB" 2>/dev/null; then
    dispatched="a tick was started anyway"
  fi
  "$ROOT/contrib/babysit/alert.sh" "babysitter pass failed" \
    "claude exited $rc; nothing was merged and $dispatched this pass. Log: $LOG"
fi
find "$DIR" -name 'pass-*.log' -mtime +14 -delete
exit $rc
