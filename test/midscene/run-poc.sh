#!/bin/bash

set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
POC_DIR="$ROOT/test/midscene"
ISO_REPO="${OMARCHY_ISO_REPO:-$(cd -- "$ROOT/.." && pwd)/omarchy-iso}"
ISO_PATH="${1:-${OMARCHY_ISO:-}}"
RUNS="${OMARCHY_MIDSCENE_RUNS:-10}"
SSH_PORT="${OMARCHY_MIDSCENE_SSH_PORT:-2222}"
MEMORY="${OMARCHY_MIDSCENE_MEMORY_MB:-4096}"
ARTIFACTS="$POC_DIR/artifacts"
VM_DIR="$ARTIFACTS/vm"
QMP_SOCKET="/tmp/omarchy-midscene-qmp-$$.sock"
PIDFILE="$VM_DIR/qemu.pid"
SHIM_DIR=$(mktemp -d)

if [[ -z ${MIDSCENE_MODEL_API_KEY:-} ]]; then
  echo "ok - MIDSCENE_MODEL_API_KEY is not set; skipping optional Midscene PoC"
  exit 0
fi

for name in MIDSCENE_MODEL_NAME MIDSCENE_MODEL_FAMILY; do
  if [[ -z ${!name:-} ]]; then
    echo "$name is required when MIDSCENE_MODEL_API_KEY is set." >&2
    exit 1
  fi
done

if [[ -z $ISO_PATH || ! -f $ISO_PATH ]]; then
  echo "Pass an Omarchy ISO path or set OMARCHY_ISO." >&2
  echo "Usage: test/midscene/run-poc.sh /path/to/omarchy.iso" >&2
  exit 1
fi

if [[ ! -x $ISO_REPO/bin/omarchy-iso-test ]]; then
  echo "Clone https://github.com/omacom/omarchy-iso next to this checkout, or set OMARCHY_ISO_REPO." >&2
  exit 1
fi

if [[ ! -c /dev/kvm ]]; then
  echo "/dev/kvm is required to run the real Omarchy VM." >&2
  exit 1
fi

for command in qemu-img qemu-system-x86_64 socat ssh fluxbox vncviewer npm; do
  if ! command -v "$command" >/dev/null; then
    echo "Required host command is missing: $command" >&2
    exit 1
  fi
done

case $RUNS in
  '' | *[!0-9]*) echo "OMARCHY_MIDSCENE_RUNS must be an integer from 1 to 100." >&2; exit 1 ;;
esac
if ((RUNS < 1 || RUNS > 100)); then
  echo "OMARCHY_MIDSCENE_RUNS must be an integer from 1 to 100." >&2
  exit 1
fi

mkdir -p "$VM_DIR"

# The ISO harness installs its Arch dependencies through this Omarchy helper.
# Host CI installs the equivalent Ubuntu packages before invoking this script.
printf '#!/bin/bash\nexit 0\n' >"$SHIM_DIR/omarchy-pkg-add"
if ! command -v magick >/dev/null && command -v convert >/dev/null; then
  printf '#!/bin/bash\nexec convert "$@"\n' >"$SHIM_DIR/magick"
fi
chmod 0755 "$SHIM_DIR"/*

BASE_NAME=$(basename "$ISO_PATH" .iso)
BASE_DIR="$ISO_REPO/test-runs/$BASE_NAME"
BASE_DISK="$BASE_DIR/base.qcow2"
BASE_OVMF="$BASE_DIR/OVMF_VARS.4m.fd"
SSH_KEY="$BASE_DIR/id_ed25519"

cleanup() {
  local status=$?
  if [[ -f $PIDFILE ]]; then
    pid=$(<"$PIDFILE")
    if kill -0 "$pid" 2>/dev/null; then
      qmp '"system_powerdown"' >/dev/null || true
      for _wait in $(seq 1 15); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      kill "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$QMP_SOCKET"
  rm -rf "$SHIM_DIR"
  return $status
}
trap cleanup EXIT

qmp() {
  printf '{"execute":"qmp_capabilities"}\n{"execute":%s}\n' "$1" |
    timeout 5 socat -t 2 - "UNIX-CONNECT:$QMP_SOCKET" 2>/dev/null
}

press() {
  local part json=""
  local -a parts
  IFS='-' read -ra parts <<<"$1"
  for part in "${parts[@]}"; do
    json+="{\"type\":\"qcode\",\"data\":\"$part\"},"
  done
  qmp "\"send-key\", \"arguments\": {\"keys\": [${json%,}]}" >/dev/null
}

ssh_guest() {
  ssh -i "$SSH_KEY" -p "$SSH_PORT" \
    -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 \
    -o LogLevel=ERROR \
    omarchy@127.0.0.1 "$@" </dev/null
}

session_ready() {
  ssh_guest 'runtime=/run/user/$(id -u); signature=$(ls -t "$runtime/hypr" 2>/dev/null | head -1); test -n "$signature" && XDG_RUNTIME_DIR="$runtime" HYPRLAND_INSTANCE_SIGNATURE="$signature" hyprctl -j monitors >/dev/null'
}

echo "Preparing the reusable installed Omarchy base image."
PATH="$SHIM_DIR:$PATH" "$ISO_REPO/bin/omarchy-iso-test" "$ISO_PATH" --reuse-base --install-only --no-preview --memory "$MEMORY"

for file in "$BASE_DISK" "$BASE_OVMF" "$SSH_KEY"; do
  if [[ ! -s $file ]]; then
    echo "Omarchy ISO harness did not produce $file" >&2
    exit 1
  fi
done

rm -rf "$VM_DIR"
mkdir -p "$VM_DIR"
qemu-img create -f qcow2 -b "$BASE_DISK" -F qcow2 "$VM_DIR/run.qcow2" >/dev/null
cp "$BASE_OVMF" "$VM_DIR/OVMF_VARS.4m.fd"

echo "Booting a disposable Omarchy VM overlay."
qemu-system-x86_64 \
  -cpu host -enable-kvm -machine q35,accel=kvm \
  -smp "$(nproc)" \
  -m "$MEMORY" \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/edk2/x64/OVMF_CODE.4m.fd \
  -drive if=pflash,format=raw,file="$VM_DIR/OVMF_VARS.4m.fd" \
  -drive file="$VM_DIR/run.qcow2",format=qcow2,if=none,id=drive0 \
  -device virtio-blk-pci,drive=drive0,bootindex=1 \
  -device virtio-vga \
  -display none \
  -vnc 127.0.0.1:5 \
  -usb -device usb-tablet \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:"$SSH_PORT"-:22 \
  -device virtio-net-pci,netdev=net0 \
  -qmp "unix:$QMP_SOCKET,server,nowait" \
  -serial "file:$VM_DIR/serial.log" \
  -pidfile "$PIDFILE" \
  -daemonize

echo "Waiting for SSH and the real Hyprland session."
ssh_ready=false
for _attempt in $(seq 1 120); do
  if ssh_guest true 2>/dev/null; then
    ssh_ready=true
    break
  fi
  sleep 2
done
if [[ $ssh_ready != true ]]; then
  echo "VM did not expose SSH within 240 seconds." >&2
  exit 1
fi

session_started=false
for _attempt in $(seq 1 30); do
  if session_ready 2>/dev/null; then
    session_started=true
    break
  fi
  press "o-m-a-r-c-h-y"
  press ret
  sleep 10
done
if [[ $session_started != true ]]; then
  echo "Hyprland session did not start after SDDM login attempts." >&2
  exit 1
fi

export OMARCHY_QMP_SOCKET="$QMP_SOCKET"
export OMARCHY_MIDSCENE_RUNS="$RUNS"
export OMARCHY_MIDSCENE_ARTIFACT_DIR="$ARTIFACTS"
export MIDSCENE_COMPUTER_HEADLESS_LINUX=true
export MIDSCENE_RUN_DIR="$ARTIFACTS/midscene_run"

echo "Running $RUNS QMP-driven, Midscene-verified launcher scenarios."
npm --prefix "$POC_DIR" run run
