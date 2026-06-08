# Oracle Deploy + CI/CD — Implementation Plan

> Spec: `docs/superpowers/specs/2026-06-08-oci-deploy-design.md`.
> Mostly authored config artifacts + one small code change. Tests where code exists; a correctness
> review over the CI/CD workflows + provisioning script (easy to get subtly wrong).

**Goal:** Ship a complete OCI Always-Free Arm deployment kit + GitHub Actions CI/CD (self-hosted
runner) + runbook, plus a `OUTBOX_POLL_MS` config tweak. User provisions via the runbook.

---

## Task 1: `OUTBOX_POLL_MS` config (TDD)
**Files:** `src/config.ts`, `src/listener.ts`, `.env.example`, `test/config-defaults.test.ts` (new).
- [ ] config.ts: add `OUTBOX_POLL_MS: z.coerce.number().int().positive().default(5000),`.
- [ ] listener.ts: replace the hardcoded `}, 5000);` on the outbox `setInterval` with `}, config.OUTBOX_POLL_MS);`.
- [ ] `.env.example`: add `WORKER_POLL_MS=4000` and `OUTBOX_POLL_MS=5000` (documented; both optional).
- [ ] Test `test/config-defaults.test.ts`: import `config`, assert `config.OUTBOX_POLL_MS === 5000`
  (default, since test/setup doesn't set it) and it's a number.
- [ ] `npm test` + `tsc` green. Commit `feat: make outbox poll interval configurable (OUTBOX_POLL_MS)`.

## Task 2: systemd units + cloud-init + provision script
**Files:** `deploy/wa-listener.service`, `deploy/wa-worker.service`, `deploy/cloud-init.yaml`, `deploy/provision-oci.sh`.
- [ ] Two `.service` units exactly as in the spec (User=appuser, EnvironmentFile, ExecStart=`npm run
  start:listener`/`start:worker`, Restart=always, RestartSec=5, multi-user.target).
- [ ] `cloud-init.yaml` (`#cloud-config`): packages git/build-essential/curl/ca-certificates; Node 20
  NodeSource arm64 runcmd; create appuser; clone repo to /opt/wa-app; `npm ci`; write `.env` template
  if missing; copy unit files + daemon-reload + enable (not start); download actions-runner arm64
  tarball to /opt/actions-runner; sudoers drop-in for `appuser` to restart only the two units.
- [ ] `provision-oci.sh`: bash, `set -euo pipefail`, env-parameterized; create VCN/subnet/IG/route/
  security-list (ingress 22 from `${MY_IP}/32`, egress all), resolve Ubuntu 24.04 arm64 image, launch
  A1.Flex (ocpus=2, memory=12) with cloud-init user-data + ssh key; poll for + print the public IP;
  comment block on A1 capacity AD-retry.

## Task 3: GitHub Actions CI + CD
**Files:** `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`.
- [ ] `ci.yml`: on push + pull_request; ubuntu-latest; actions/checkout; setup-node 20 w/ npm cache;
  `npm ci`; `npm test`; `npx tsc --noEmit`.
- [ ] `deploy.yml`: on push to `main`; job `runs-on: [self-hosted, oracle-a1]`; checkout NOT needed
  (deploys the on-box checkout) — steps run `cd /opt/wa-app && git fetch origin main && git reset
  --hard origin/main && npm ci && sudo systemctl restart wa-listener wa-worker`; `concurrency` group
  to serialize; a guard so it no-ops cleanly if `/opt/wa-app` is absent. Gate on CI (reuse via
  `workflow_run` or a `needs` within a single combined workflow — pick `workflow_run` on CI success).

## Task 4 (controller): install OCI CLI + RUNBOOK + push
- [ ] Install OCI CLI locally (official installer).
- [ ] Author `deploy/RUNBOOK.md` (the ~20-min user flow from the spec, copy-paste commands incl. the
  runner registration-token via `gh api`).
- [ ] `npm test` + `tsc` green; commit everything; review pass over workflows + provision script;
  push branch; (merge to main is the user's call after review).

## Verification
- `npm test` + `tsc` green; `OUTBOX_POLL_MS` default test passes.
- `ci.yml` is valid (yaml) and will run on push.
- `deploy.yml` only runs on self-hosted; safe no-op until the runner exists.
- Provision script + cloud-init reviewed for correctness (shape config, image resolution, SSH-only
  ingress, secret-safety: no secrets committed).
