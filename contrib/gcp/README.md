# A GCP host for the claude-code worker

A VM in `prod-loglm` (us-west1-a) that runs a factory tick every two hours on the
`claude-code` worker, the same tick the Mac's launchd job runs
(`contrib/tick-claude-code.sh`), so scale-out work does not wait on a laptop being
awake. Ticks are idempotent and claim their work, so this host, the Mac and the
Actions backstop can all run at once.

What it is: an e2-standard-8 (8 vCPU, 32 GB), 200 GB pd-balanced disk, Ubuntu 24.04
LTS, network tag `factory`, OS Login on, **no service account** (the agents run with
`--dangerously-skip-permissions` and nothing here needs Google Cloud APIs). It has an
ephemeral external IP for egress only; the project firewall admits nothing inbound but
SSH from IAP. On it: Docker Engine (the review, deps and security runs use a
privileged container each), Node 24, `gh`, Claude Code pinned to the Mac's version in
`~/.local/bin/claude`, the checkout in `~/vigil-factory`, and a cron entry
(`47 */2 * * *`, off the Actions schedule `17 */2`) running `contrib/gcp/tick.sh`.

Cost: about $196/month on demand for the VM in us-west1 (e2-standard-8, ~$0.268/h
× 730 h), plus ~$20/month for the 200 GB pd-balanced disk and a few dollars for the
external IP: roughly **$220/month**. Stopping the VM stops the compute charge; the
disk is still billed.

## Files

- `provision.sh <name>`: create the VM (or start it, if stopped), wait for SSH, push
  `.env`, run `setup.sh`. Re-running against an existing VM just re-runs those steps;
  it is how you rebuild or repair one.
- `setup.sh`: runs on the VM as the login user; installs everything above and the
  cron entry. Safe to re-run.
- `push-env.sh <name>`: copies this machine's `.env` to the VM's
  `~/vigil-factory/.env`, mode 600. **This is the only way secrets reach the VM**;
  they never go in git. It never sends `GH_TOKEN` and keeps the one already on the VM.
- `tick.sh`: one tick, for cron. Exports `.env`, runs `contrib/update.sh`, then
  `npm run factory -- run` with `FACTORY_WORKER=claude-code FACTORY_MODEL=opus
  FACTORY_MAX_JOBS=6`, as the Mac does.

## GitHub credentials

The VM needs `GH_TOKEN` in `~/vigil-factory/.env`: `gh`, `update.sh`'s fetch, and the
agents' clones, pushes and PRs all use it. It is the VM's own: a fine-grained PAT (or
GitHub App token) scoped to `Vigil-SOC/vigil` and `Vigil-SOC/vigil-factory` with
contents, pull requests, issues and checks read/write, plus whatever the factory's
phases need on the target repo (Dependabot and code scanning alerts, security
advisories). Do **not** use anyone's personal `gh auth token`: everyone with OS Login
on this VM can read it (docs/threat-model.md already names the broad PAT as a risk).

It is added on the VM by hand, never through git or `push-env.sh`:

```bash
gcloud compute ssh factory-host-1 --zone us-west1-a --project prod-loglm --tunnel-through-iap
read -rs t && printf 'GH_TOKEN=%s\n' "$t" >> ~/vigil-factory/.env && unset t
```

Without it, `setup.sh` installs everything but stops before the checkout with
"waiting for GH_TOKEN", and `tick.sh` stops at once with "GH_TOKEN is unset". Nothing
falls back to another login.

## Getting on it

```bash
gcloud compute ssh factory-host-1 --zone us-west1-a --project prod-loglm --tunnel-through-iap
```

OS Login maps your Google identity to a Linux user (`sam@deeptempo.ai` is
`sam_deeptempo_ai`). You need `roles/compute.osLogin` (or `roles/compute.osAdminLogin`
for sudo) on the project or the instance, and `roles/iap.tunnelResourceAccessor` for
the tunnel. Anyone with OS Login can read the tokens in `.env`.

## Operating it

- A tick by hand: `~/vigil-factory/contrib/gcp/tick.sh` (foreground), or
  `nohup ~/vigil-factory/contrib/gcp/tick.sh >/dev/null 2>&1 &` and watch the log.
  A tick already running makes another skip.
- Read-only state: `cd ~/vigil-factory && npm run factory -- status`.
- Logs: `telemetry/tick-gcp-<UTC timestamp>.log` per tick; `telemetry/launchd.log`
  (the name update.sh logs to on every host) for tick start/end, skips and updates;
  `telemetry/cron.stdout.log` for anything cron itself caught.
- Updating: automatic. Each tick's `update.sh` fast-forwards the checkout to the
  newest green commit on main. A checkout on another branch is left alone, so a host
  provisioned with `FACTORY_BRANCH=<branch>` goes back to main with a plain
  `provision.sh <name>`.
- Rebuilding: `contrib/gcp/provision.sh <name>` again. For a fresh machine, delete the
  instance (`gcloud compute instances delete <name> --zone us-west1-a --project
  prod-loglm`), provision, and re-add `GH_TOKEN`.
- `update.sh`'s alerts (`contrib/babysit/alert.sh`) land in
  `telemetry/babysit/ALERTS.md` on the VM; the macOS notification does not exist here.
