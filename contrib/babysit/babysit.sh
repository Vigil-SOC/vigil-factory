#!/bin/zsh
# One babysitting pass, for launchd (see com.deeptempo.factory.babysit.plist):
# merge the factory's open PRs, start the next local tick, and alert Sam if
# anything looks wrong. The judgment is a headless Claude session running
# prompt.md; this wrapper only alerts if the session itself fails.
set -u
# ENGINE is the factory's code and ROOT the deployment it runs: one checkout
# that is both, or the directory an engine is installed in as a package.
ENGINE="${0:A:h:h:h}"
ROOT="${ENGINE%%/node_modules/*}"
# The engine's scripts as the session will name them, from ROOT.
CONTRIB="${ENGINE#$ROOT/}/contrib"; [[ "$ENGINE" == "$ROOT" ]] && CONTRIB=contrib
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
# tick. A pass does not wait for a running tick: a local one awaits its agents
# for hours, and merging does not need it finished. The tick's lock holds its
# pid; a lock whose pid is gone is a tick that died.
# contrib/install-launchd.sh gives each checkout's jobs a prefix of their own.
TICK_LABEL="${FACTORY_LAUNCHD_PREFIX:-com.deeptempo.factory}.claude-code"
TICK_JOB="gui/$(id -u)/$TICK_LABEL"
live_tick() {
  kill -0 "$(cat "$ROOT/telemetry/.tick.lock/pid" 2>/dev/null)" 2>/dev/null
}

# The interactive login's OAuth session expires and stalled every pass for ~20h
# on 2026-10-08. A long-lived token from `claude setup-token` outlives it; it is
# kept in .env as CLAUDE_CODE_OAUTH_TOKEN, where the tick reads it too.
token="$(grep -E '^[[:space:]]*CLAUDE_CODE_OAUTH_TOKEN[[:space:]]*=' "$ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"' ")"
[[ -n "$token" ]] && export CLAUDE_CODE_OAUTH_TOKEN="$token"

LOG="$DIR/pass-$(date -u +%Y%m%dT%H%MZ).log"
# prompt.md is shared with the GCP host; the host-specific lines are filled here.
prompt="$(sed \
  -e "s|{{CONTRIB}}|$CONTRIB|g" \
  -e "s|{{TICK_HOW}}|\`$CONTRIB/tick-claude-code.sh\` under the launchd job \`$TICK_LABEL\`|g" \
  -e 's|{{TICK_LOG}}|telemetry/tick-claude-<UTC start>.log|g' \
  -e 's|{{TICK_PID}}|telemetry/.tick.lock/pid|g' \
  -e 's|{{TICK_LOCK}}|telemetry/.tick.lock|g' \
  -e "s|{{TICK_START}}|launchctl kickstart $TICK_JOB|g" \
  "$ENGINE/contrib/babysit/prompt.md")"
claude -p "$prompt" --model opus --effort medium --dangerously-skip-permissions > "$LOG" 2>&1
rc=$?
if (( rc != 0 )) || [[ ! -s "$LOG" ]]; then
  # The tick needs no judgment to start, so a failed session still starts it.
  dispatched="no tick was started"
  if ! live_tick && launchctl kickstart "$TICK_JOB" 2>/dev/null; then
    dispatched="a tick was started anyway"
  fi
  "$ENGINE/contrib/babysit/alert.sh" "babysitter pass failed" \
    "claude exited $rc; nothing was merged and $dispatched this pass. Log: $LOG"
fi
find "$DIR" -name 'pass-*.log' -mtime +14 -delete
exit $rc
