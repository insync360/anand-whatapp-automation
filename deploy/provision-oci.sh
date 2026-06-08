#!/usr/bin/env bash
#
# Provision the Always-Free Oracle Cloud (OCI) Arm VM for the WhatsApp follow-up assistant.
# Outbound-only app: opens ONLY inbound SSH (22) from your IP; egress allow-all.
#
# Prereqs:
#   - OCI CLI installed and authenticated:  oci session authenticate   (or ~/.oci/config)
#   - jq installed
#   - An SSH public key
#
# Required environment variables (export before running):
#   COMPARTMENT_ID   ocid1.compartment.oc1..xxxx   (or your tenancy OCID for the root compartment)
#   AD               availability domain name, e.g. "abCD:AP-MUMBAI-1-AD-1"
#                    (list with: oci iam availability-domain list --query 'data[].name' --raw-output)
#   SSH_PUBKEY       path to your SSH public key, e.g. ~/.ssh/id_ed25519.pub
#   MY_IP            your public IPv4 for the SSH allow-rule, e.g. 203.0.113.4
#
# Optional:
#   OCPUS=2  MEMORY_GB=12  BOOT_GB=50  VM_NAME=wa-vm  CIDR=10.0.0.0/16  SUBNET_CIDR=10.0.0.0/24
#
# A1 CAPACITY NOTE: Ampere free capacity is often scarce. If instance launch fails with
# "Out of host capacity", re-run targeting a different AD (set AD=...-AD-2 / -AD-3), or retry
# later. A PAYG (upgraded) account gets capacity far more reliably than a free account.

set -euo pipefail

: "${COMPARTMENT_ID:?set COMPARTMENT_ID}"
: "${AD:?set AD (availability domain name)}"
: "${SSH_PUBKEY:?set SSH_PUBKEY (path to your .pub key)}"
: "${MY_IP:?set MY_IP (your public IPv4)}"
OCPUS="${OCPUS:-2}"
MEMORY_GB="${MEMORY_GB:-12}"
BOOT_GB="${BOOT_GB:-50}"
VM_NAME="${VM_NAME:-wa-vm}"
CIDR="${CIDR:-10.0.0.0/16}"
SUBNET_CIDR="${SUBNET_CIDR:-10.0.0.0/24}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> Creating VCN"
VCN_ID=$(oci network vcn create --compartment-id "$COMPARTMENT_ID" --cidr-blocks "[\"$CIDR\"]" \
  --display-name wa-vcn --wait-for-state AVAILABLE --query 'data.id' --raw-output)

echo "==> Creating internet gateway"
IG_ID=$(oci network internet-gateway create --compartment-id "$COMPARTMENT_ID" --vcn-id "$VCN_ID" \
  --is-enabled true --display-name wa-ig --wait-for-state AVAILABLE --query 'data.id' --raw-output)

echo "==> Creating route table (default route -> internet gateway)"
RT_ID=$(oci network route-table create --compartment-id "$COMPARTMENT_ID" --vcn-id "$VCN_ID" \
  --display-name wa-rt \
  --route-rules "$(jq -nc --arg ig "$IG_ID" '[{destination:"0.0.0.0/0",destinationType:"CIDR_BLOCK",networkEntityId:$ig}]')" \
  --wait-for-state AVAILABLE --query 'data.id' --raw-output)

echo "==> Creating security list (ingress: SSH from ${MY_IP}/32 only; egress: all)"
INGRESS=$(jq -nc --arg ip "${MY_IP}/32" '[{
  protocol:"6", source:$ip, isStateless:false,
  tcpOptions:{destinationPortRange:{min:22,max:22}}
}]')
EGRESS='[{"protocol":"all","destination":"0.0.0.0/0","isStateless":false}]'
SL_ID=$(oci network security-list create --compartment-id "$COMPARTMENT_ID" --vcn-id "$VCN_ID" \
  --display-name wa-sl --ingress-security-rules "$INGRESS" --egress-security-rules "$EGRESS" \
  --wait-for-state AVAILABLE --query 'data.id' --raw-output)

echo "==> Creating public subnet"
SUBNET_ID=$(oci network subnet create --compartment-id "$COMPARTMENT_ID" --vcn-id "$VCN_ID" \
  --cidr-block "$SUBNET_CIDR" --display-name wa-subnet --route-table-id "$RT_ID" \
  --security-list-ids "[\"$SL_ID\"]" --wait-for-state AVAILABLE --query 'data.id' --raw-output)

echo "==> Resolving latest Ubuntu 24.04 Arm64 image"
IMAGE_ID=$(oci compute image list --compartment-id "$COMPARTMENT_ID" \
  --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
  --shape "VM.Standard.A1.Flex" --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0].id' --raw-output)
[ -n "$IMAGE_ID" ] && [ "$IMAGE_ID" != "null" ] || { echo "No Ubuntu 24.04 Arm image found"; exit 1; }

echo "==> Launching ${VM_NAME} (A1.Flex ${OCPUS} OCPU / ${MEMORY_GB} GB / ${BOOT_GB} GB boot)"
INSTANCE_ID=$(oci compute instance launch \
  --compartment-id "$COMPARTMENT_ID" --availability-domain "$AD" \
  --shape "VM.Standard.A1.Flex" \
  --shape-config "$(jq -nc --argjson o "$OCPUS" --argjson m "$MEMORY_GB" '{ocpus:$o,memoryInGBs:$m}')" \
  --image-id "$IMAGE_ID" --subnet-id "$SUBNET_ID" --assign-public-ip true \
  --boot-volume-size-in-gbs "$BOOT_GB" \
  --ssh-authorized-keys-file "$SSH_PUBKEY" \
  --user-data-file "$HERE/cloud-init.yaml" \
  --display-name "$VM_NAME" \
  --wait-for-state RUNNING --query 'data.id' --raw-output)

echo "==> Fetching public IP"
PUBLIC_IP=$(oci compute instance list-vnics --instance-id "$INSTANCE_ID" \
  --query 'data[0]."public-ip"' --raw-output)

echo ""
echo "============================================================"
echo " VM is RUNNING."
echo "   Instance: $INSTANCE_ID"
echo "   Public IP: $PUBLIC_IP"
echo "   SSH:       ssh ubuntu@${PUBLIC_IP}"
echo " cloud-init takes ~2-4 min to finish. Then follow deploy/RUNBOOK.md."
echo "============================================================"
