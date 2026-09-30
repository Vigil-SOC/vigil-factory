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
# next chance is 90 minutes out. Wait up to 90 minutes for it instead.
for _ in {1..45}; do
  busy=$(gh run list -R DeepTempo/deeptempo-factory -w factory-tick -L 5 --json status \
    -q '[.[] | select(.status != "completed")] | length' 2>/dev/null)
  [[ "$busy" == 0 ]] && break
  sleep 120
done

LOG="$DIR/pass-$(date -u +%Y%m%dT%H%MZ).log"
claude -p "$(cat "$ROOT/contrib/babysit/prompt.md")" --model opus --effort medium --dangerously-skip-permissions > "$LOG" 2>&1
rc=$?
if (( rc != 0 )) || [[ ! -s "$LOG" ]]; then
  "$ROOT/contrib/babysit/alert.sh" "babysitter pass failed" \
    "claude exited $rc; nothing was merged or dispatched this pass. Log: $LOG"
fi
find "$DIR" -name 'pass-*.log' -mtime +14 -delete
exit $rc
