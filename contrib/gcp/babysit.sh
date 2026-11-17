#!/bin/bash
# One babysitting pass on the GCP host, for cron (contrib/gcp/setup.sh installs
# the entry, every 90 minutes). The Linux sibling of contrib/babysit/babysit.sh:
# the same prompt.md with this host's tick filled in, merging the factory's PRs
# with the VM's own GH_TOKEN, starting the next tick through contrib/gcp/tick.sh
# instead of launchd, and alerting only into telemetry/babysit/ALERTS.md.
{
set -u
# ENGINE is the factory's code and ROOT the deployment it runs: one checkout
# that is both, or the directory an engine is installed in as a package.
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="${ENGINE%%/node_modules/*}"
# The engine's scripts as the session will name them, from ROOT.
CONTRIB="${ENGINE#"$ROOT"/}/contrib"; [[ "$ENGINE" == "$ROOT" ]] && CONTRIB=contrib
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd "$ROOT" || exit 1
DIR="$ROOT/telemetry/babysit"
mkdir -p "$DIR"

exec 9>"$DIR/.lock-gcp"
flock -n 9 || exit 0

# .env: GH_TOKEN for the merges, CLAUDE_CODE_OAUTH_TOKEN for the session. Same
# parsing as tick.sh; real env wins.
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
  key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
  value="${value#[\"\']}"; value="${value%[\"\']}"
  [[ -n "${!key+x}" ]] || export "$key=$value"
done < <(cat .env 2>/dev/null)
if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "[$(date -u +%FT%TZ)] babysit not started: GH_TOKEN is unset in $ROOT/.env" >> telemetry/launchd.log
  exit 3
fi
export DISABLE_AUTOUPDATER=1

live_tick() {
  kill -0 "$(cat "$ROOT/telemetry/.tick-gcp.pid" 2>/dev/null)" 2>/dev/null
}
start_tick() {
  nohup "$ENGINE/contrib/gcp/tick.sh" >/dev/null 2>&1 &
}

# What a babysitter may do is the deployment's call. Its own babysit.md, when
# it has one, is the session's prompt in place of the engine's (the same
# {{...}} lines are filled in), and FACTORY_BABYSIT_MERGES=0 in .env takes
# merging and approving out of the session's reach, whatever the prompt says.
PROMPT="$ENGINE/contrib/babysit/prompt.md"; [[ -f "$ROOT/babysit.md" ]] && PROMPT="$ROOT/babysit.md"
deny=(); [[ "${FACTORY_BABYSIT_MERGES:-1}" == 0 ]] && deny=(--disallowedTools "Bash(gh pr merge:*)" "Bash(gh pr review:*)")

prompt="$(sed \
  -e "s|{{CONTRIB}}|$CONTRIB|g" \
  -e "s|{{TICK_HOW}}|\`$CONTRIB/gcp/tick.sh\` under cron on this GCP host (it runs \`$CONTRIB/update.sh\` first)|g" \
  -e 's|{{TICK_LOG}}|telemetry/tick-gcp-<UTC start>.log|g' \
  -e 's|{{TICK_PID}}|telemetry/.tick-gcp.pid|g' \
  -e 's|{{TICK_LOCK}}|telemetry/.tick-gcp.lock|g' \
  -e "s|{{TICK_START}}|nohup $CONTRIB/gcp/tick.sh >/dev/null 2>\&1 \&|g" \
  "$PROMPT")"

LOG="$DIR/pass-gcp-$(date -u +%Y%m%dT%H%MZ).log"
echo "[$(date -u +%FT%TZ)] babysit pass start → $LOG" >> telemetry/launchd.log
claude -p "$prompt" --model opus --effort medium --dangerously-skip-permissions ${deny[@]+"${deny[@]}"} > "$LOG" 2>&1
rc=$?
echo "[$(date -u +%FT%TZ)] babysit pass end rc=$rc → $LOG" >> telemetry/launchd.log
if (( rc != 0 )) || [[ ! -s "$LOG" ]]; then
  dispatched="no tick was started"
  if ! live_tick; then start_tick; dispatched="a tick was started anyway"; fi
  "$ENGINE/contrib/babysit/alert.sh" "babysitter pass failed" \
    "claude exited $rc; nothing was merged and $dispatched this pass. Log: $LOG"
fi
find "$DIR" -name 'pass-gcp-*.log' -mtime +14 -delete
exit $rc
}
