# Oracle Cloud Deployment + CI/CD (Design Spec)

**Date:** 2026-06-08  **Status:** Approved (brainstorming)

## Context & goal
The app currently runs only on the dev laptop. Deploy it to an Always-Free Oracle Cloud (OCI)
Arm VM so the two long-running roles run 24/7, and add GitHub Actions CI/CD so pushes to `main` are
tested and auto-deployed. The app is **outbound-only** (WhatsApp WS, Anthropic, Neon) — it serves
nothing inbound.

## Approved decisions
- **Execution split:** I author the entire deploy kit + CI/CD + runbook and install OCI CLI; the
  user runs OCI login + provisioning + the one-time WhatsApp QR scan via the runbook.
- **CD:** a **self-hosted GitHub Actions runner on the VM** (outbound-only; no inbound port).
- **Process manager:** **systemd**, one unit per role.
- **Sizing:** `VM.Standard.A1.Flex`, 2 OCPU / 12 GB, Ubuntu 24.04 ARM64, ~50 GB boot, on-demand.
- **Defer `LISTEN/NOTIFY`** (Neon scale-to-zero optimization); ship tunable poll intervals + an OCI
  budget alert for now.

## Topology
- 1 VM, two systemd services: `wa-listener` (capture + daily scheduler + outbox/ack delivery) and
  `wa-worker` (extraction). The "scheduler" is inside the listener, so two roles, not three.
- **Networking (outbound-only):** security list ingress = TCP 22 from the user's IP only; egress
  allow-all. No 80/443.
- Secrets in `/opt/wa-app/.env` (gitignored, never in git, never touched by CD). WhatsApp session in
  `/opt/wa-app/auth_info/` (also gitignored) — survives deploys.

## Deliverables (committed to the repo)

### `deploy/provision-oci.sh`
OCI CLI script (parameterized via env vars: compartment OCID, AD, subnet/VCN names, SSH pubkey path).
Creates (idempotently where possible): VCN + public subnet + internet gateway + route table +
security list (ingress SSH from `MY_IP/32`, egress all), then `oci compute instance launch` with the
A1.Flex shape config (2 OCPU/12 GB), latest Ubuntu 24.04 ARM image (resolved via
`oci compute image list`), the SSH pubkey, and `cloud-init.yaml` as user-data. Prints the public IP.
Includes a comment block on retrying across ADs for A1 capacity.

### `deploy/cloud-init.yaml`
First-boot (`#cloud-config`): apt install git, build-essential, ca-certificates; install Node 20 via
NodeSource arm64; create `appuser`; `git clone` the repo to `/opt/wa-app` (owned by appuser);
`npm ci`; write a `.env` **template** (keys with empty values) if absent; install the two systemd
unit files (from `deploy/`); `systemctl daemon-reload` + `enable` (NOT start — needs `.env` + QR
first). Download the GitHub Actions runner tarball to `/opt/actions-runner` (config/registration is a
runbook step because the token is short-lived and repo-scoped). Add a sudoers drop-in letting
`appuser` run exactly `systemctl restart wa-listener wa-worker` without a password.

### `deploy/wa-listener.service` and `deploy/wa-worker.service`
```
[Unit]
Description=WhatsApp follow-up <role>
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=appuser
WorkingDirectory=/opt/wa-app
EnvironmentFile=/opt/wa-app/.env
ExecStart=/usr/bin/npm run start:<role>
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
```
(`<role>` = `listener` / `worker`.)

### `.github/workflows/ci.yml`
On `push` + `pull_request`: `ubuntu-latest`, Node 20, `npm ci`, `npm test`, `npx tsc --noEmit`.

### `.github/workflows/deploy.yml`
On `push` to `main`, `needs: ci`-style gating (call CI or re-run checks), `runs-on: [self-hosted,
oracle-a1]`: `cd /opt/wa-app && git fetch && git reset --hard origin/main && npm ci && sudo systemctl
restart wa-listener wa-worker`. Concurrency-guarded so overlapping pushes don't race. Never touches
`.env`/`auth_info/`.

### `deploy/RUNBOOK.md`
End-to-end: install OCI CLI; `oci session authenticate`; export the script's required OCIDs; run
`provision-oci.sh`; SSH in; fill `/opt/wa-app/.env`; register the self-hosted runner with a token
(`gh api ... /actions/runners/registration-token` or Settings UI) + label `oracle-a1` + install as a
service; run `npm run start:listener` once to scan the QR, Ctrl+C; `systemctl start wa-listener
wa-worker`; verify with `journalctl -u`; set an OCI budget alert ($1–5).

## Production config tweak (code)
- Make the listener's outbox poll interval env-configurable: `OUTBOX_POLL_MS` (default 5000), read
  via `config` (zod, `z.coerce.number().int().positive().default(5000)`). `WORKER_POLL_MS` already
  exists. `.env.example` documents both. This is the only code change; unit-test the config default.
- Note in code/docs: 24/7 polling keeps Neon warm (~180 compute-hours/mo, just under Free's 191.9);
  `LISTEN/NOTIFY` is the future fix to let it nap.

## Out of scope (future)
`LISTEN/NOTIFY` event-driven wakeups; OCI Vault for secrets; multi-worker `SELECT … FOR UPDATE SKIP
LOCKED` (single worker today, no contention); reverse proxy / dashboard (nothing inbound).

## Verification
- CI workflow runs green on the push (hosted runner).
- After the user provisions: `systemctl status wa-listener wa-worker` both active; `journalctl`
  shows "linked / listening" + "extraction worker started"; a test WhatsApp message yields an ack;
  a subsequent push to `main` triggers the self-hosted deploy job which restarts the services.
- `OUTBOX_POLL_MS` default test passes; `npm test` + `tsc` green.

## Files
New: `deploy/provision-oci.sh`, `deploy/cloud-init.yaml`, `deploy/wa-listener.service`,
`deploy/wa-worker.service`, `deploy/RUNBOOK.md`, `.github/workflows/ci.yml`,
`.github/workflows/deploy.yml`. Modified: `src/config.ts`, `src/listener.ts`, `.env.example`.
