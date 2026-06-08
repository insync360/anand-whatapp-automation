# Deploy Runbook — Oracle Cloud (OCI) Always-Free Arm VM

End-to-end, ~20 minutes. The app is **outbound-only**; the VM opens only inbound SSH from your IP.
Two systemd services run 24/7: `wa-listener` (capture + daily reminders + ack delivery) and
`wa-worker` (extraction). CI/CD: pushes to `main` are tested by GitHub Actions, then a self-hosted
runner **on this VM** pulls and restarts the services.

> Prereqs: an OCI account (PAYG/upgraded gets A1 capacity far more reliably than free), an SSH
> keypair (`ssh-keygen -t ed25519`), and a real `.env` (your Neon `DATABASE_URL` + `ANTHROPIC_API_KEY`).

---

## 1. Install + authenticate the OCI CLI (on your machine)
```bash
# Install (Linux/macOS):
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"
# Windows: see https://docs.oracle.com/iaas/Content/API/SDKDocs/cliinstall.htm

oci session authenticate          # opens a browser; pick your region (e.g. ap-mumbai-1)
```

## 2. Gather the inputs the provision script needs
```bash
# Compartment (root compartment = your tenancy OCID is fine to start):
oci iam compartment list --all --query 'data[].{name:name,id:id}' --output table
# Availability domains in your region:
oci iam availability-domain list --query 'data[].name' --raw-output
# Your public IP:
curl -s https://ifconfig.me ; echo
```

## 3. Provision the VM
```bash
cd /path/to/anand-whatapp-automation
export COMPARTMENT_ID=ocid1.compartment.oc1..xxxx   # or tenancy OCID
export AD="abCD:AP-MUMBAI-1-AD-1"                    # from step 2
export SSH_PUBKEY=~/.ssh/id_ed25519.pub
export MY_IP=203.0.113.4                             # from step 2
# optional: export OCPUS=2 MEMORY_GB=12 BOOT_GB=50
bash deploy/provision-oci.sh
```
It prints the **public IP**. If launch fails with **"Out of host capacity"**, re-run with a
different AD (`AD=...-AD-2`, `-AD-3`) or retry later.

> **Console alternative** (if you prefer point-and-click): create a VCN with the "VCN with Internet
> Connectivity" wizard, edit its security list to allow ingress TCP 22 from `<your-ip>/32` only,
> then *Create Instance* → shape `VM.Standard.A1.Flex` (2 OCPU / 12 GB), image Ubuntu 24.04, paste
> `deploy/cloud-init.yaml` into **Advanced → cloud-init**, add your SSH key.

## 4. SSH in and wait for first-boot setup
```bash
ssh ubuntu@<PUBLIC_IP>
cloud-init status --wait          # wait until "status: done" (~2-4 min)
```

## 5. Fill in secrets
```bash
sudo -u appuser nano /opt/wa-app/.env
```
Set at least:
```
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require
USER_NAME=Anand
TIMEZONE=Asia/Kolkata
REMINDER_HOUR=8
WORKER_POLL_MS=10000
OUTBOX_POLL_MS=10000
```

## 6. Register the GitHub Actions self-hosted runner
Get a registration token (needs `gh` authed with admin on the repo, or use the GitHub UI:
**Repo → Settings → Actions → Runners → New self-hosted runner**, which shows exact commands):
```bash
# On your laptop, print a token:
gh api -X POST repos/insync360/anand-whatapp-automation/actions/runners/registration-token --jq .token
```
Then on the VM, as appuser:
```bash
sudo -iu appuser
mkdir -p /opt/actions-runner && cd /opt/actions-runner
# Use the version shown on the "New runner" page; arm64 example:
curl -fsSL -o r.tgz https://github.com/actions/runner/releases/download/v2.319.1/actions-runner-linux-arm64-2.319.1.tar.gz
tar xzf r.tgz
./config.sh --url https://github.com/insync360/anand-whatapp-automation \
  --token <REGISTRATION_TOKEN> --labels oracle-a1 --name oracle-a1 --unattended
exit
# Install + start it as a service (runs as appuser so the CD sudoers rule applies):
cd /opt/actions-runner && sudo ./svc.sh install appuser && sudo ./svc.sh start
```
Confirm it shows **Idle** under Settings → Actions → Runners.

## 7. One-time WhatsApp link (scan the QR)
```bash
sudo -iu appuser
cd /opt/wa-app
npm run start:listener            # a QR prints in the terminal
# Scan it: WhatsApp > Settings > Linked Devices > Link a Device
# Wait for "linked / listening", then Ctrl+C. Credentials persist in /opt/wa-app/auth_info/.
exit
```

## 8. Start the services
```bash
sudo systemctl start wa-listener wa-worker
systemctl status wa-listener wa-worker --no-pager
journalctl -u wa-listener -f      # expect: linked / listening, scheduler started, outbox poller started
journalctl -u wa-worker -f        # expect: extraction worker started
```
(They're already `enable`d for start-on-boot by cloud-init.)

## 9. Cost guardrail — OCI budget alert
OCI Console → **Billing → Budgets → Create Budget** on your compartment, amount **$5**, alert at
**80%**. The free shape/storage/egress are $0; this catches anything unexpected. (Anthropic is the
only real spend — cents/month at this volume.)

## 10. Verify CI/CD
- Push any commit to `main` → the **CI** workflow runs on GitHub (test + tsc).
- On CI success, the **Deploy** workflow runs on the `oracle-a1` self-hosted runner: it does
  `git reset --hard origin/main`, `npm ci`, and restarts both services. `.env` and `auth_info/`
  are gitignored, so secrets and your WhatsApp session survive.

---

## Troubleshooting
- **A1 "Out of host capacity":** retry across ADs or later; PAYG accounts get it far more easily.
- **Runner offline:** `sudo ./svc.sh status` in `/opt/actions-runner`; re-run `./config.sh` with a
  fresh token if the registration expired.
- **QR didn't link / logged out:** `rm -rf /opt/wa-app/auth_info` and redo step 7.
- **Neon stays warm 24/7:** expected with constant polling (~180 compute-hours/mo, just under Free's
  191.9). Raise `WORKER_POLL_MS`/`OUTBOX_POLL_MS` to reduce chatter; the real fix (future) is
  Postgres `LISTEN/NOTIFY`.
- **Service won't start:** `journalctl -u wa-listener -n 50 --no-pager` — usually a missing/invalid
  `.env` value (config fails fast on a bad `DATABASE_URL` or missing `ANTHROPIC_API_KEY`).
