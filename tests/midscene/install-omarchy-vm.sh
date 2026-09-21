#!/bin/bash
set -euo pipefail

# One-time base image build: install a complete Omarchy VM from the verified
# official ISO through the omacom/omarchy-iso harness (~14 minutes on a
# KVM-enabled GitHub runner). Publish it afterwards with publish-omarchy-vm.sh.
# This is deliberately a real Omarchy installation, not an Arch container.

readonly ROOT_DIR="$PWD"
readonly WORK_DIR="$ROOT_DIR/.midscene-omarchy"

# shellcheck source=omarchy-vm.env
source "$ROOT_DIR/tests/midscene/omarchy-vm.env"

readonly ISO_PATH="$WORK_DIR/omarchy-${OMARCHY_ISO_VERSION}.iso"
readonly HARNESS_DIR="$WORK_DIR/omarchy-iso"

tests/midscene/prepare-omarchy-host.sh
df -h "$WORK_DIR"

curl --fail --location --retry 5 --retry-all-errors \
  "https://iso.omarchy.org/omarchy-${OMARCHY_ISO_VERSION}.iso" \
  --output "$ISO_PATH"
printf '%s  %s\n' "$OMARCHY_ISO_SHA256" "$ISO_PATH" | sha256sum --check --strict

readonly SHIM_DIR="$(mktemp -d)"
trap 'rm -rf "$SHIM_DIR"' EXIT
printf '#!/bin/sh\nexit 0\n' >"$SHIM_DIR/omarchy-pkg-add"
printf '#!/bin/sh\nexec convert "$@"\n' >"$SHIM_DIR/magick"
chmod 0755 "$SHIM_DIR/omarchy-pkg-add" "$SHIM_DIR/magick"

PATH="$SHIM_DIR:$PATH" "$HARNESS_DIR/bin/omarchy-iso-test" \
  "$ISO_PATH" \
  --install-only \
  --memory 4096 \
  --timeout 3000 \
  --no-preview

test -s "$HARNESS_DIR/test-runs/omarchy-${OMARCHY_ISO_VERSION}/base.qcow2"
echo "PASS: a complete Omarchy ${OMARCHY_ISO_VERSION} base VM was installed"
