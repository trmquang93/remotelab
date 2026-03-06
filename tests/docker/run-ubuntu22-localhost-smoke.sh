#!/bin/bash
set -euo pipefail

IMAGE="${1:-ubuntu:22.04}"
CONTAINER_NAME="${CONTAINER_NAME:-remotelab-ubuntu22-systemd-smoke-$$}"
WORKDIR="/workspace"
INNER_SCRIPT="tests/docker/scripts/ubuntu22-localhost-systemd-smoke.sh"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ ! -f "$INNER_SCRIPT" ]]; then
  echo "Missing inner smoke script: $INNER_SCRIPT" >&2
  exit 1
fi

echo "Starting systemd-enabled Ubuntu container: $CONTAINER_NAME"
docker run -d --rm \
  --name "$CONTAINER_NAME" \
  --privileged \
  --cgroupns=host \
  --tmpfs /run \
  --tmpfs /run/lock \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$PWD:$WORKDIR" \
  -w "$WORKDIR" \
  "$IMAGE" \
  bash -lc 'export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session dtach curl ca-certificates jq lsof procps psmisc xz-utils && exec /sbin/init' >/dev/null

for _ in $(seq 1 120); do
  if docker exec "$CONTAINER_NAME" bash -lc 'command -v systemctl >/dev/null 2>&1 && command -v curl >/dev/null 2>&1'; then
    break
  fi
  sleep 1
done

echo "Running localhost smoke test inside container"
docker exec "$CONTAINER_NAME" bash "$WORKDIR/$INNER_SCRIPT"

echo "Smoke test completed successfully"
