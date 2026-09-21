#!/bin/bash
set -euo pipefail

# Restore the prebuilt Omarchy base VM from GHCR into the local harness
# directory. Requires GITHUB_REPOSITORY_OWNER (Actions sets it automatically;
# locally export it, e.g. GITHUB_REPOSITORY_OWNER=quanru).

readonly ROOT_DIR="$PWD"
readonly WORK_DIR="$ROOT_DIR/.midscene-omarchy"

# shellcheck source=omarchy-vm.env
source "$ROOT_DIR/tests/midscene/omarchy-vm.env"

: "${GITHUB_REPOSITORY_OWNER:?Set GITHUB_REPOSITORY_OWNER, e.g. quanru}"

readonly BASE_DIR="$WORK_DIR/omarchy-iso/test-runs/omarchy-${OMARCHY_ISO_VERSION}"
readonly BUNDLE_DIR="$WORK_DIR/registry"
readonly IMAGE_TAG="${OMARCHY_ISO_VERSION}-${OMARCHY_ISO_SHA256:0:12}-${OMARCHY_ISO_HARNESS_SHA:0:12}"
readonly IMAGE="ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/omarchy-midscene-ci-base:${IMAGE_TAG}"

tests/midscene/prepare-omarchy-host.sh
mkdir -p "$BASE_DIR" "$BUNDLE_DIR"
oras pull --output "$BUNDLE_DIR" "$IMAGE"
(cd "$BUNDLE_DIR" && sha256sum --check --strict SHA256SUMS)
tar -C "$BASE_DIR" --use-compress-program=unzstd -xf "$BUNDLE_DIR/omarchy-base.tar.zst"

# In --reuse-base mode the official harness uses the ISO basename only to
# locate BASE_DIR; it does not read ISO contents.
printf 'restored-from=%s\n' "$IMAGE" >"$WORK_DIR/omarchy-${OMARCHY_ISO_VERSION}.iso"

for file in base.qcow2 OVMF_VARS.4m.fd id_ed25519 id_ed25519.pub; do
  test -s "$BASE_DIR/$file"
done
chmod 0600 "$BASE_DIR/id_ed25519"
qemu-img check "$BASE_DIR/base.qcow2"
rm -rf "$BUNDLE_DIR"
echo "PASS: restored $IMAGE"
