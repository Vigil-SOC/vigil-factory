#!/bin/bash
# Copy this machine's .env to the VM's ~/vigil-factory/.env (mode 600). This is
# the only way secrets reach the VM; they are never committed.
#
# The VM's copy also gets GH_TOKEN, which `gh`, update.sh and the agents' git
# push use there. It is $FACTORY_VM_GH_TOKEN when set, else this machine's own
# `gh auth token`. The second is a personal token with the login's full scopes:
# a stopgap only. See contrib/gcp/README.md before anyone else gets on the VM.
# Usage: contrib/gcp/push-env.sh <instance-name>
set -euo pipefail
NAME="${1:?usage: push-env.sh <instance-name>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="${FACTORY_GCP_PROJECT:-prod-loglm}"
ZONE="${FACTORY_GCP_ZONE:-us-west1-a}"
G=(--project "$PROJECT" --zone "$ZONE" --tunnel-through-iap --quiet)

[[ -f "$ROOT/.env" ]] || { echo "no .env at $ROOT/.env" >&2; exit 1; }
token="${FACTORY_VM_GH_TOKEN:-$(gh auth token)}"
[[ -n "$token" ]] || { echo "no GitHub token: set FACTORY_VM_GH_TOKEN or log in with gh" >&2; exit 1; }

umask 077
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
grep -vE '^[[:space:]]*(GH_TOKEN|GITHUB_TOKEN)[[:space:]]*=' "$ROOT/.env" > "$tmp" || true
printf '\n# VM only (contrib/gcp/push-env.sh): gh, update.sh and agent pushes.\nGH_TOKEN=%s\n' "$token" >> "$tmp"

gcloud compute ssh "$NAME" "${G[@]}" --command 'mkdir -p ~/vigil-factory && rm -f /tmp/factory.env'
gcloud compute scp "$tmp" "$NAME:/tmp/factory.env" "${G[@]}"
gcloud compute ssh "$NAME" "${G[@]}" --command 'install -m 600 /tmp/factory.env ~/vigil-factory/.env && rm -f /tmp/factory.env'
echo "pushed .env to $NAME:~/vigil-factory/.env"
