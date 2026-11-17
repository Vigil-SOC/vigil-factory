#!/bin/bash
# Copy this machine's .env to the VM's ~/<repo name>/.env (mode 600), the repo
# being the one this checkout's `origin` names (FACTORY_REPO overrides). This is
# the only way secrets reach the VM; they are never committed.
#
# GH_TOKEN is the VM's own: a token scoped to the factory's repos, appended on
# the VM by hand (see contrib/gcp/README.md). This script never sends one, and
# keeps the one already on the VM when it replaces the rest of the file.
# Usage: contrib/gcp/push-env.sh <instance-name>
set -euo pipefail
NAME="${1:?usage: push-env.sh <instance-name>}"
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
# The deployment: this checkout, or the one this engine is installed in.
ROOT="${ENGINE%%/node_modules/*}"
REPO="${FACTORY_REPO:-$(git -C "$ROOT" remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#(\.git)?/?$##')}"
[[ "$REPO" == */* ]] || { echo "cannot tell which factory repo this is from origin; set FACTORY_REPO=<owner/name>" >&2; exit 1; }
DIR_NAME="${REPO##*/}"
PROJECT="${FACTORY_GCP_PROJECT:-prod-loglm}"
ZONE="${FACTORY_GCP_ZONE:-us-west1-a}"
G=(--project "$PROJECT" --zone "$ZONE" --tunnel-through-iap --quiet)

[[ -f "$ROOT/.env" ]] || { echo "no .env at $ROOT/.env" >&2; exit 1; }
umask 077
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
grep -vE '^[[:space:]]*(GH_TOKEN|GITHUB_TOKEN)[[:space:]]*=' "$ROOT/.env" > "$tmp" || true

gcloud compute ssh "$NAME" "${G[@]}" --command "mkdir -p ~/$DIR_NAME && rm -f /tmp/factory.env"
gcloud compute scp "$tmp" "$NAME:/tmp/factory.env" "${G[@]}"
gcloud compute ssh "$NAME" "${G[@]}" --command "f=~/$DIR_NAME/.env"'
  set -e; umask 077
  { cat /tmp/factory.env; grep -E "^[[:space:]]*GH_TOKEN[[:space:]]*=" "$f" 2>/dev/null || true; } > "$f.new"
  install -m 600 "$f.new" "$f"; rm -f "$f.new" /tmp/factory.env
  grep -qE "^[[:space:]]*GH_TOKEN[[:space:]]*=[[:space:]]*[^[:space:]]" "$f" \
    && echo "kept the GH_TOKEN already on the VM" \
    || echo "no GH_TOKEN on the VM yet: append GH_TOKEN=<token> to $f (see contrib/gcp/README.md)"'
echo "pushed .env to $NAME:~/$DIR_NAME/.env"
