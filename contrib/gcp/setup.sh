#!/bin/bash
# Make this Ubuntu 24.04 VM a factory host: Docker, Node 24, gh, Claude Code,
# the factory checkout, and a cron entry for contrib/gcp/tick.sh. Runs as the
# login user (with sudo), from provision.sh; safe to re-run.
# Expects ~/vigil-factory/.env with GH_TOKEN (push-env.sh puts it there).
# FACTORY_BRANCH=<branch> checks out a branch other than main (see below).
set -euo pipefail
CLAUDE_VERSION="${FACTORY_CLAUDE_VERSION:-2.1.318}"
REPO="${FACTORY_REPO:-Vigil-SOC/vigil-factory}"
DIR="$HOME/vigil-factory"
export DEBIAN_FRONTEND=noninteractive
say() { echo "== setup: $*"; }

say "base packages"
sudo apt-get update -qq
# zsh: contrib/update.sh and the babysitter scripts are zsh.
sudo apt-get install -y -qq git zsh curl ca-certificates gnupg jq util-linux build-essential >/dev/null

if ! command -v docker >/dev/null; then
  say "Docker Engine"
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
sudo systemctl enable --now docker >/dev/null
# Takes effect at the next login; cron jobs get it, and tick.sh falls back to
# `sg docker` when run from a session that predates it.
sudo usermod -aG docker "$USER"

if ! node -v 2>/dev/null | grep -q '^v24\.'; then
  say "Node 24 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v gh >/dev/null; then
  say "gh"
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq gh >/dev/null
fi

# Claude Code in ~/.local, as on the Mac (FACTORY_CLAUDE_BIN=~/.local/bin/claude),
# pinned so the host and the review containers built from it run one version.
export PATH="$HOME/.local/bin:$PATH"
if [[ "$(claude --version 2>/dev/null | awk '{print $1}')" != "$CLAUDE_VERSION" ]]; then
  say "Claude Code $CLAUDE_VERSION"
  npm install -g --silent --prefix "$HOME/.local" "@anthropic-ai/claude-code@$CLAUDE_VERSION" \
    || { say "Claude Code $CLAUDE_VERSION failed to install; installing latest"; npm install -g --silent --prefix "$HOME/.local" @anthropic-ai/claude-code; }
fi
grep -q 'HOME/.local/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile"

# The token for the clone, the fetches and the agents' pushes: GH_TOKEN in
# .env, the VM's own (README). Nothing falls back to another login.
token="$(grep -E '^[[:space:]]*GH_TOKEN[[:space:]]*=' "$DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"' ")" || true

# Every two hours at :47, off the Actions schedule (17 */2). The tick's own
# lock makes one still running when the next is due skip; without GH_TOKEN it
# stops at once, so the entry can wait for the token.
install_cron() {
  [[ -x "$DIR/contrib/gcp/tick.sh" ]] || return 0
  say "cron"
  mkdir -p "$DIR/telemetry"
  local line="47 */2 * * * $DIR/contrib/gcp/tick.sh >> $DIR/telemetry/cron.stdout.log 2>&1"
  { crontab -l 2>/dev/null | grep -v 'contrib/gcp/tick.sh' || true; echo "$line"; } | crontab -
}

if [[ -z "$token" ]]; then
  install_cron
  say "versions: node $(node -v), $(claude --version), $(gh --version | head -1), $(docker --version)"
  echo "== setup: waiting for GH_TOKEN: append GH_TOKEN=<token> to $DIR/.env (see contrib/gcp/README.md), then re-run setup. Skipped: the checkout, npm ci." >&2
  exit 3
fi
export GH_TOKEN="$token"

# The checkout. .env is already in $DIR, so it is initialised in place rather
# than cloned. git reads GH_TOKEN at fetch time through this helper (the same
# one the worker gives its clones), so the token is never written into git.
helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
if [[ ! -d "$DIR/.git" ]]; then
  say "checkout of $REPO"
  git -C "$DIR" init -q -b main
  git -C "$DIR" remote add origin "https://github.com/$REPO"
fi
git -C "$DIR" config credential.helper "$helper"
git -C "$DIR" fetch -q origin
git -C "$DIR" remote set-head origin -a >/dev/null
# main, which update.sh then keeps on its newest green commit. FACTORY_BRANCH
# puts the host on another branch, e.g. to try a change to these scripts;
# update.sh leaves such a checkout alone, so re-run without it to go back.
branch="${FACTORY_BRANCH:-main}"
if [[ "$(git -C "$DIR" symbolic-ref -q --short HEAD)" != "$branch" ]] || ! git -C "$DIR" rev-parse -q --verify HEAD >/dev/null; then
  say "checking out $branch"
  if git -C "$DIR" rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
    git -C "$DIR" checkout -q "$branch"
  else
    git -C "$DIR" checkout -q -f -b "$branch" --track "origin/$branch"
  fi
fi
say "npm ci"
(cd "$DIR" && npm ci --silent)
install_cron

say "versions: node $(node -v), $(claude --version), $(gh --version | head -1), $(docker --version)"
say "ok"
