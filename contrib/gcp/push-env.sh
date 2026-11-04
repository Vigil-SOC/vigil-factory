#!/bin/bash
# Copy this machine's .env to the VM's ~/vigil-factory/.env (mode 600). This is
# the only way secrets reach the VM; they are never committed.
#
# GH_TOKEN is the VM's own: a token scoped to the factory's repos, appended on
# the VM by hand (see contrib/gcp/README.md). This script never sends one, and
# keeps the one already on the VM when it replaces the rest of the file.
# Usage: contrib/gcp/push-env.sh <instance-name>
set -euo pipefail
NAME="${1:?usage: push-env.sh <instance-name>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="${FACTORY_GCP_PROJECT:-prod-loglm}"
ZONE="${FACTORY_GCP_ZONE:-us-west1-a}"
G=(--project "$PROJECT" --zone "$ZONE" --tunnel-through-iap --quiet)

[[ -f "$ROOT/.env" ]] || { echo "no .env at $ROOT/.env" >&2; exit 1; }
umask 077
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
grep -vE '^[[:space:]]*(GH_TOKEN|GITHUB_TOKEN)[[:space:]]*=' "$ROOT/.env" > "$tmp" || true

gcloud compute ssh "$NAME" "${G[@]}" --command 'mkdir -p ~/vigil-factory && rm -f /tmp/factory.env'
gcloud compute scp "$tmp" "$NAME:/tmp/factory.env" "${G[@]}"
gcloud compute ssh "$NAME" "${G[@]}" --command '
  set -e; umask 077; f=~/vigil-factory/.env
  { cat /tmp/factory.env; grep -E "^[[:space:]]*GH_TOKEN[[:space:]]*=" "$f" 2>/dev/null || true; } > "$f.new"
  install -m 600 "$f.new" "$f"; rm -f "$f.new" /tmp/factory.env
  grep -qE "^[[:space:]]*GH_TOKEN[[:space:]]*=[[:space:]]*[^[:space:]]" "$f" \
    && echo "kept the GH_TOKEN already on the VM" \
    || echo "no GH_TOKEN on the VM yet: append GH_TOKEN=<token> to $f (see contrib/gcp/README.md)"'
echo "pushed .env to $NAME:~/vigil-factory/.env"
