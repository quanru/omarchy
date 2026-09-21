#!/bin/bash
set -euo pipefail

# Prepare a Linux host (GitHub runner or local KVM box) for the Omarchy
# disposable-VM Midscene runs. Mirrors the harness preparation proven in the
# doubao-say repository: pin the official omacom/omarchy-iso harness commit and
# work around its installer wording drift for the 4.0.3 ISO.

readonly ROOT_DIR="$PWD"
readonly WORK_DIR="$ROOT_DIR/.midscene-omarchy"
readonly HARNESS_DIR="$WORK_DIR/omarchy-iso"

# shellcheck source=omarchy-vm.env
source "$ROOT_DIR/tests/midscene/omarchy-vm.env"

if [[ ! -c /dev/kvm ]]; then
  echo "::error::This host does not expose /dev/kvm; a real Omarchy VM cannot be started."
  exit 1
fi

if [[ -n ${GITHUB_ACTIONS:-} ]]; then
  sudo chmod 0666 /dev/kvm
  sudo rm -rf /usr/local/lib/android /usr/share/dotnet /opt/ghc
fi

if ! command -v qemu-system-x86_64 >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends \
    curl git imagemagick ovmf qemu-system-x86 qemu-utils socat \
    tesseract-ocr tesseract-ocr-eng zstd
fi

# socat drives QMP key injection; make sure it is present even if QEMU was
# already on the host.
if ! command -v socat >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends socat
fi

if ! command -v fluxbox >/dev/null 2>&1 || ! command -v vncviewer >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends \
    fluxbox tigervnc-viewer x11-xserver-utils xvfb
fi

mkdir -p "$WORK_DIR"

if [[ ! -d $HARNESS_DIR/.git ]]; then
  git init --quiet "$HARNESS_DIR"
  git -C "$HARNESS_DIR" remote add origin https://github.com/omacom/omarchy-iso.git
fi
git -C "$HARNESS_DIR" fetch --quiet --depth 1 origin "$OMARCHY_ISO_HARNESS_SHA"
git -C "$HARNESS_DIR" checkout --quiet --detach FETCH_HEAD

# The pinned harness waits for an installer screen label that changed in 4.0.3.
if grep -q 'wait_for_screen "Opinionated"' "$HARNESS_DIR/bin/omarchy-iso-test"; then
  sed -i 's/wait_for_screen "Opinionated"/wait_for_screen "Agentic"/g' \
    "$HARNESS_DIR/bin/omarchy-iso-test"
fi

sudo mkdir -p /usr/share/edk2/x64
sudo ln -sf /usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/edk2/x64/OVMF_CODE.4m.fd
sudo ln -sf /usr/share/OVMF/OVMF_VARS_4M.fd /usr/share/edk2/x64/OVMF_VARS.4m.fd
