#!/bin/bash
# Create (or refresh) a GCP VM that runs the factory's claude-code worker on a
# cron: create the instance if it does not exist, start it if it is stopped,
# copy .env to it (push-env.sh), then run setup.sh on it. Re-running against an
# existing instance just pushes .env and re-runs setup, which is idempotent.
# Usage: contrib/gcp/provision.sh <instance-name>
# FACTORY_GCP_PROJECT / FACTORY_GCP_ZONE override the project and zone;
# FACTORY_BRANCH puts the host's checkout on a branch other than main.
set -euo pipefail
NAME="${1:?usage: provision.sh <instance-name>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${FACTORY_GCP_PROJECT:-prod-loglm}"
ZONE="${FACTORY_GCP_ZONE:-us-west1-a}"
G=(--project "$PROJECT" --zone "$ZONE")
# The project's firewall admits SSH only from IAP's range, so every ssh/scp
# goes through an IAP tunnel.
SSH=(gcloud compute ssh "$NAME" "${G[@]}" --tunnel-through-iap --quiet)

status="$(gcloud compute instances describe "$NAME" "${G[@]}" --format='value(status)' 2>/dev/null || true)"
if [[ -z "$status" ]]; then
  echo "creating $NAME in $PROJECT/$ZONE"
  # No service account: the agents run with --dangerously-skip-permissions, and
  # nothing on this machine needs Google Cloud APIs, so it gets no GCP identity.
  # The ephemeral external IP is for egress only (GitHub, npm, Anthropic); the
  # firewall admits nothing inbound but IAP SSH.
  gcloud compute instances create "$NAME" "${G[@]}" \
    --machine-type=e2-standard-16 \
    --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
    --boot-disk-size=200GB --boot-disk-type=pd-balanced \
    --tags=factory \
    --labels=role=vigil-factory \
    --metadata=enable-oslogin=TRUE \
    --no-service-account --no-scopes
elif [[ "$status" != RUNNING ]]; then
  echo "$NAME is $status; starting it"
  gcloud compute instances start "$NAME" "${G[@]}"
else
  echo "$NAME exists and is running; re-running setup"
fi

echo "waiting for SSH"
for i in $(seq 1 40); do
  "${SSH[@]}" --command true >/dev/null 2>&1 && break
  (( i == 40 )) && { echo "SSH to $NAME never came up" >&2; exit 1; }
  sleep 10
done

"$HERE/push-env.sh" "$NAME"
gcloud compute scp "$HERE/setup.sh" "$NAME:/tmp/factory-setup.sh" "${G[@]}" --tunnel-through-iap --quiet
rc=0
"${SSH[@]}" --command "FACTORY_BRANCH=${FACTORY_BRANCH:-main} bash /tmp/factory-setup.sh" || rc=$?
if (( rc == 3 )); then
  echo "$NAME is built but waiting for GH_TOKEN: append it to ~/vigil-factory/.env on the VM, then re-run: $0 $NAME" >&2
  exit 3
fi
(( rc == 0 )) || { echo "setup on $NAME failed (exit $rc)" >&2; exit "$rc"; }
echo "done: $NAME is set up. Get on it with: gcloud compute ssh $NAME --zone $ZONE --project $PROJECT --tunnel-through-iap"
