#!/bin/bash
set -euo pipefail

# Boot the restored disposable Omarchy VM, pre-stage the fcitx5 quickphrase
# fixture, drive the live Hyprland desktop through VNC with Midscene Test.
#
# Usage: run-omarchy-midscene.sh [omarchy-fcitx5]
#
# Requires a restored base VM (restore-omarchy-vm.sh) on a Linux host with
# /dev/kvm, and MIDSCENE_MODEL_* in the environment.

readonly ROOT_DIR="$PWD"
readonly MIDSCENE_PROJECT="${1:-omarchy-fcitx5}"
readonly WORK_DIR="$ROOT_DIR/.midscene-omarchy"
readonly HARNESS_DIR="$WORK_DIR/omarchy-iso"
# shellcheck source=omarchy-vm.env
source "$ROOT_DIR/tests/midscene/omarchy-vm.env"
readonly ISO_PATH="$WORK_DIR/omarchy-${OMARCHY_ISO_VERSION}.iso"
readonly BASE_DIR="$HARNESS_DIR/test-runs/omarchy-${OMARCHY_ISO_VERSION}"
readonly SSH_KEY="$BASE_DIR/id_ed25519"
readonly SSH_PORT=2222
# The files under test in this checkout, staged into the guest so the treatment
# executes the exact config and migration from the candidate change.
readonly FIXTURE_CONF="$ROOT_DIR/config/fcitx5/conf/quickphrase.conf"
readonly FIXTURE_MIGRATION="$ROOT_DIR/migrations/1789983273.sh"
export NODE_OPTIONS="${NODE_OPTIONS:-} --require=$ROOT_DIR/tests/midscene/node_modules/@computer-use/libnut/dist/import_libnut.js"
export OMARCHY_SSH_KEY="$SSH_KEY"

VM_PID=""
XVFB_PID=""

cleanup() {
  if [[ -n $XVFB_PID ]]; then
    kill "$XVFB_PID" 2>/dev/null || true
  fi
  if [[ -n $VM_PID ]]; then
    kill "$VM_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

ssh_guest() {
  local status=255
  for _ssh_attempt in 1 2 3 4 5; do
    ssh -i "$SSH_KEY" -p "$SSH_PORT" \
      -o BatchMode=yes \
      -o IdentitiesOnly=yes \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=10 \
      -o LogLevel=ERROR \
      omarchy@127.0.0.1 "$@" && return 0
    status=$?
    if ((status != 255)); then
      return "$status"
    fi
    echo "Guest SSH connection attempt $_ssh_attempt failed; retrying." >&2
    sleep 3
  done
  return "$status"
}

ssh_session() {
  local command="$1"
  ssh_guest "export XDG_RUNTIME_DIR=/run/user/\$(id -u); \
    export DBUS_SESSION_BUS_ADDRESS=unix:path=\$XDG_RUNTIME_DIR/bus; \
    export HYPRLAND_INSTANCE_SIGNATURE=\$(ls -t \$XDG_RUNTIME_DIR/hypr | head -1); \
    export WAYLAND_DISPLAY=\$(find \$XDG_RUNTIME_DIR -maxdepth 1 -name 'wayland-*' ! -name '*.lock' -printf '%f\\n' | head -1); \
    export OMARCHY_PATH=/usr/share/omarchy; \
    export PATH=\$OMARCHY_PATH/bin:\$PATH; \
    $command" </dev/null
}

ssh_session_tty() {
  local command="$1"
  ssh -tt -i "$SSH_KEY" -p "$SSH_PORT" \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    omarchy@127.0.0.1 "export XDG_RUNTIME_DIR=/run/user/\$(id -u); \
    export DBUS_SESSION_BUS_ADDRESS=unix:path=\$XDG_RUNTIME_DIR/bus; \
    export OMARCHY_PATH=/usr/share/omarchy; \
    export PATH=\$OMARCHY_PATH/bin:\$PATH; \
    $command"
}

test -s "$ISO_PATH"
test -s "$BASE_DIR/base.qcow2"
test -s "$SSH_KEY"
test -s "$FIXTURE_CONF"
test -s "$FIXTURE_MIGRATION"

# Reuse the pinned official harness's VM, login and session routines. Replace
# only its post-login acceptance body so this job can hand the live desktop to
# Midscene instead of running Omarchy's upstream acceptance suite.
readonly SESSION_HARNESS="$HARNESS_DIR/bin/omarchy-midscene-session"
cp "$HARNESS_DIR/bin/omarchy-iso-test" "$SESSION_HARNESS"
sed -i '/^acceptance_phase() {/,/^}/c\
acceptance_phase() {\
  log "Booting Omarchy session for Midscene fcitx5 regression"\
  qemu-img create -f qcow2 -b "$BASE_DISK" -F qcow2 "$RUN_DIR/run.qcow2" >/dev/null\
  start_vm "$RUN_DIR/run.qcow2" "$RUN_DIR/serial.log"\
  establish_session\
  capture_console "success-session-ready-for-midscene"\
}' "$SESSION_HARNESS"

readonly SHIM_DIR="$(mktemp -d)"
trap 'rm -rf "$SHIM_DIR"' EXIT
printf '#!/bin/sh\nexit 0\n' >"$SHIM_DIR/omarchy-pkg-add"
printf '#!/bin/sh\nexec convert "$@"\n' >"$SHIM_DIR/magick"
chmod 0755 "$SHIM_DIR/omarchy-pkg-add" "$SHIM_DIR/magick"

PATH="$SHIM_DIR:$PATH" "$SESSION_HARNESS" "$ISO_PATH" \
  --reuse-base \
  --keep-running \
  --memory 4096 \
  --no-preview

readonly RUN_DIR="$(find "$BASE_DIR/runs" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
VM_PID="$(cat "$RUN_DIR/qemu.pid")"
kill -0 "$VM_PID"
ssh_guest true

# The harness creates this QMP server socket (bin/omarchy-iso-test,
# QMP_SOCK under /tmp). QMP send-key is a real hardware-keyboard path through
# Hyprland's keybinding and fcitx5's input-method filter, unlike the virtual
# keyboard wtype uses, which bypasses compositor chords.
export OMARCHY_QMP_SOCK="$(ls -t /tmp/omarchy-iso-test-qmp.*.sock 2>/dev/null | head -1)"
[[ -S $OMARCHY_QMP_SOCK ]] || { echo "QMP socket not found" >&2; exit 1; }
echo "Using QMP socket $OMARCHY_QMP_SOCK"

echo "Pre-staging the QuickPhrase config and migration into the guest."
scp -i "$SSH_KEY" -P "$SSH_PORT" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=10 \
  -o LogLevel=ERROR \
  "$FIXTURE_CONF" "$FIXTURE_MIGRATION" omarchy@127.0.0.1:/tmp/

# The disposable account created by the official harness uses password
# "omarchy". Authorize sudo in a PTY and place the files under test at their
# real shipped paths so the treatment exercises the exact update migration.
ssh_session_tty "printf '%s\\n' omarchy | sudo -S -p '' install -d -m 0755 /usr/share/omarchy/config/fcitx5/conf && \
  printf '%s\\n' omarchy | sudo -S -p '' install -d -m 0755 /usr/share/omarchy/migrations && \
  printf '%s\\n' omarchy | sudo -S -p '' install -m 0644 /tmp/quickphrase.conf /usr/share/omarchy/config/fcitx5/conf/quickphrase.conf && \
  printf '%s\\n' omarchy | sudo -S -p '' install -m 0644 /tmp/1789983273.sh /usr/share/omarchy/migrations/1789983273.sh && \
  test -s /usr/share/omarchy/config/fcitx5/conf/quickphrase.conf && \
  test -s /usr/share/omarchy/migrations/1789983273.sh"

# Start every case from a pristine fcitx5 state with no user override.
ssh_session "rm -f \"\$HOME/.config/fcitx5/conf/quickphrase.conf\" ; \
  systemctl --user reset-failed omarchy-fcitx5.service 2>/dev/null || true ; \
  systemctl --user restart omarchy-fcitx5.service"

# First-run Omarchy notifications visually overlap the bottom of the screen
# where fcitx5's QuickPhrase strip appears.
ssh_session "omarchy-shell notifications dismissAll"

# Start the host display ourselves and verify it before libnut connects. The
# ComputerAgent's built-in Xvfb launcher only waits a fixed 500 ms, which can
# race on busy runners and crash before a report can be written.
export DISPLAY=
for _display_number in {99..198}; do
  if [[ ! -e /tmp/.X"$_display_number"-lock && ! -S /tmp/.X11-unix/X"$_display_number" ]]; then
    export DISPLAY=:"$_display_number"
    break
  fi
done
if [[ -z ${DISPLAY:-} ]]; then
  echo "No free host X11 display found." >&2
  exit 1
fi
echo "Starting host Xvfb on $DISPLAY."
Xvfb "$DISPLAY" -screen 0 1280x800x24 -ac -nolisten tcp \
  >"$WORK_DIR/xvfb.log" 2>&1 &
XVFB_PID=$!
for _xvfb_attempt in {1..200}; do
  if xset -display "$DISPLAY" q >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    cat "$WORK_DIR/xvfb.log" >&2
    echo "Host Xvfb exited before becoming ready." >&2
    exit 1
  fi
  if ((_xvfb_attempt == 200)); then
    cat "$WORK_DIR/xvfb.log" >&2
    echo "Host Xvfb did not become ready." >&2
    exit 1
  fi
  sleep 0.2
done

case "$MIDSCENE_PROJECT" in
  omarchy-fcitx5)
    npm --prefix tests/midscene test -- --project "$MIDSCENE_PROJECT"
    ;;
  *)
    echo "Unsupported Midscene project: $MIDSCENE_PROJECT" >&2
    exit 2
    ;;
esac
