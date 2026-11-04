#!/bin/bash
# One full factory tick on the Claude Code worker, for cron on the GCP host
# (contrib/gcp/setup.sh installs the entry). The Linux sibling of
# contrib/tick-claude-code.sh: the same worker selection, a PATH for cron's
# near-empty one, a lock so a slow tick does not overlap the next (or have the
# checkout updated under it), and .env exported for update.sh's gh and git.
# The body is one block, so bash has read all of it before update.sh can
# fast-forward this file.
{
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd "$ROOT" || exit 1
mkdir -p telemetry

# A shell from before setup added this user to the docker group lacks it; a
# cron job, a fresh login, or this re-exec has it.
if ! docker info >/dev/null 2>&1 && [[ -z "${FACTORY_SG:-}" ]]; then
  exec sg docker -c "FACTORY_SG=1 $(printf '%q' "$0")"
fi

exec 9>telemetry/.tick-gcp.lock
if ! flock -n 9; then
  echo "[$(date -u +%FT%TZ)] tick already running (pid $(cat telemetry/.tick-gcp.pid 2>/dev/null)); skipping" >> telemetry/launchd.log
  exit 0
fi
echo $$ > telemetry/.tick-gcp.pid

# The factory loads .env itself, but update.sh runs gh and git first. Same
# parsing as loadDotEnv: KEY=value, no expansion, real env wins.
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
  key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
  value="${value#[\"\']}"; value="${value%[\"\']}"
  [[ -n "${!key+x}" ]] || export "$key=$value"
done < <(cat .env 2>/dev/null)

export FACTORY_WORKER=claude-code
# worker.model is Grok (a Cursor model); Claude Code runs the Opus alternative.
export FACTORY_MODEL=opus
# The subscription, not the Cursor budget, pays for these: run twice the jobs.
export FACTORY_MAX_JOBS=6
export FACTORY_CLAUDE_BIN="$HOME/.local/bin/claude"
# setup.sh pins Claude Code; the host and its review containers stay on it.
export DISABLE_AUTOUPDATER=1

"$ROOT/contrib/update.sh"

LOG="telemetry/tick-gcp-$(date -u +%Y%m%dT%H%M).log"
echo "[$(date -u +%FT%TZ)] tick start (gcp $(hostname)) → $LOG" >> telemetry/launchd.log
npm run factory -- run >> "$LOG" 2>&1
rc=$?
echo "[$(date -u +%FT%TZ)] tick end rc=$rc → $LOG" >> telemetry/launchd.log
exit $rc
}
