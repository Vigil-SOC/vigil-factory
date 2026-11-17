#!/bin/zsh
# Bring this deployment up to date before a tick, so every machine running the
# factory runs the same factory: the checkout to the newest commit on its
# default branch whose CI passed, and, where the engine is a package installed
# in it, the engine to the newest release its package.json asks for. Run at the
# start of a tick, before any of the factory's code loads; a tick already under
# way keeps the code it started with. A checkout on another branch, or with
# commits of its own, is someone's work: it is left alone, and the second is
# alerted. Never fails the tick: an update that cannot happen is logged and the
# tick runs on what it has.
set -u
# ENGINE is the factory's code and ROOT the deployment it runs: one checkout
# that is both, or the directory an engine is installed in as a package.
ENGINE="${0:A:h:h}"
ROOT="${ENGINE%%/node_modules/*}"
cd "$ROOT" || exit 0
mkdir -p telemetry
log() { echo "[$(date -u +%FT%TZ)] update: $1" >> telemetry/launchd.log; }
alert() { "$ENGINE/contrib/babysit/alert.sh" "$1" "$2" 2>/dev/null; log "$1: $2"; }

update_checkout() {
  local upstream branch repo target sha old
  upstream="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
  branch="${upstream#origin/}"
  [[ "$(git symbolic-ref -q --short HEAD)" == "$branch" ]] || { log "not on $branch; left alone"; return 0; }
  git fetch -q origin "$branch" || { log "fetch failed"; return 0; }

  if ! git merge-base --is-ancestor HEAD "$upstream"; then
    alert "factory checkout diverged" \
      "$ROOT has commits not on $upstream, so it no longer updates itself. Push them or reset to $upstream."
    return 0
  fi

  # Newest first; a commit whose CI is still running or red is passed over for
  # the one before it, so a bad push never reaches the fleet.
  repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" || { log "gh cannot see the repo"; return 0; }
  target=""
  for sha in $(git rev-list --max-count=20 "HEAD..$upstream"); do
    if [[ "$(gh api "repos/$repo/commits/$sha/check-runs?check_name=check" \
        --jq '[.check_runs[] | select(.status == "completed" and .conclusion == "success")] | length' 2>/dev/null)" -gt 0 ]]; then
      target="$sha"; break
    fi
  done
  [[ -n "$target" ]] || return 0

  old="$(git rev-parse HEAD)"
  if ! git merge -q --ff-only "$target" 2>>telemetry/launchd.log; then
    alert "factory update failed" \
      "$ROOT could not fast-forward to ${target:0:7} (uncommitted changes in the way?). It runs ${old:0:7} until that is cleared."
    return 0
  fi
  log "${old:0:7} → ${target:0:7}"
  # A deployment that tracks its engine keeps no lockfile; one that has a
  # lockfile is installed exactly as locked.
  if ! git diff --quiet "$old" "$target" -- package.json package-lock.json; then
    local install=install; [[ -f package-lock.json ]] && install=ci
    npm "$install" --silent >> telemetry/launchd.log 2>&1 || alert "factory update: npm $install failed" "at ${target:0:7}; see telemetry/launchd.log"
  fi
}

# An installed engine follows what the deployment's package.json names: a
# branch or dist-tag moves the engine with it, an exact version or commit pins
# it. What is installed is read from npm's own record, since a git dependency
# keeps its version number from one commit to the next.
update_engine() {
  [[ "$ENGINE" != "$ROOT" ]] || return 0
  local name was now
  name="${ENGINE#$ROOT/node_modules/}"
  installed() {
    node -e 'const p = require(process.argv[1]).packages["node_modules/" + process.argv[2]]; console.log(p.resolved || p.version)' \
      "$ROOT/node_modules/.package-lock.json" "$name" 2>/dev/null
  }
  was="$(installed)"
  if ! npm update "$name" --silent >> telemetry/launchd.log 2>&1; then
    alert "factory update: engine update failed" "npm update $name failed in $ROOT; the tick runs the engine it has. See telemetry/launchd.log"
    return 0
  fi
  now="$(installed)"
  was="${was##*[#/]}"; now="${now##*[#/]}"
  [[ "$was" == "$now" ]] || log "engine ${was:0:12} → ${now:0:12}"
}

update_checkout
update_engine
exit 0
