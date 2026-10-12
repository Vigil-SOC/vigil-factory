#!/bin/zsh
# One full factory tick on the Claude Code worker, for launchd (see
# contrib/com.deeptempo.factory.claude-code.plist). launchd gives a near-empty
# PATH, so this sets it; the lock keeps a slow tick from overlapping the next.
set -u
ROOT="/Users/armstrongflg/deeptempo-factory"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export FACTORY_WORKER=claude-code
# worker.model is Grok (a Cursor model); Claude Code runs the Opus alternative.
export FACTORY_MODEL=opus
# The subscription, not the Cursor budget, pays for these: run twice the jobs.
export FACTORY_MAX_JOBS=6
export FACTORY_CLAUDE_BIN="$HOME/.local/bin/claude"
cd "$ROOT" || exit 1

LOCK="$ROOT/telemetry/.tick.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    echo "[$(date -u +%FT%TZ)] tick already running (pid $(cat "$LOCK/pid")); skipping" >> telemetry/launchd.log
    exit 0
  fi
  rm -rf "$LOCK"; mkdir "$LOCK" || exit 1
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

LOG="telemetry/tick-claude-$(date -u +%Y%m%dT%H%M).log"
echo "[$(date -u +%FT%TZ)] tick start → $LOG" >> telemetry/launchd.log
npm run factory -- run >> "$LOG" 2>&1
rc=$?
echo "[$(date -u +%FT%TZ)] tick end rc=$rc → $LOG" >> telemetry/launchd.log
exit $rc
