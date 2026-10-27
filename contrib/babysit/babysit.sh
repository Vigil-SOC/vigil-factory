#!/bin/zsh
# One babysitting pass, for launchd (see com.deeptempo.factory.babysit.plist):
# merge the factory's open PRs, dispatch the next factory-tick, and alert Sam if
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

# A tick still running would make this pass skip its merge and dispatch, and the
# next chance is 90 minutes out. Wait up to 90 minutes for it instead — but not
# for a ghost: on 2026-10-01 GitHub cancelled a tick's steps and never closed
# the run, which then read in_progress forever and stalled every pass behind
# it. A run is live while it is queued or one of its jobs still has work left.
live_ticks() {
  local id
  gh run list -R Vigil-SOC/vigil-factory -w factory-tick -L 5 --json databaseId,status \
    -q '.[] | select(.status != "completed") | "\(.databaseId) \(.status)"' 2>/dev/null |
  while read -r id run_status; do
    if [[ "$run_status" != in_progress ]]; then echo "$id"; continue; fi
    gh api "repos/Vigil-SOC/vigil-factory/actions/runs/$id/jobs" --jq \
      '[.jobs[] | select(.status != "completed") | select((.steps | length) == 0 or any(.steps[]; .status != "completed"))] | length' \
      2>/dev/null | grep -qv '^0$' && echo "$id"
  done
}
for _ in {1..45}; do
  [[ -z "$(live_ticks)" ]] && break
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
  # The tick needs no judgment to start, so a failed session still dispatches it.
  dispatched="nothing was dispatched"
  if [[ -z "$(live_ticks)" ]] && gh workflow run factory-tick -R Vigil-SOC/vigil-factory 2>/dev/null; then
    dispatched="a tick was dispatched anyway"
  fi
  "$ROOT/contrib/babysit/alert.sh" "babysitter pass failed" \
    "claude exited $rc; nothing was merged and $dispatched this pass. Log: $LOG"
fi
find "$DIR" -name 'pass-*.log' -mtime +14 -delete
exit $rc
