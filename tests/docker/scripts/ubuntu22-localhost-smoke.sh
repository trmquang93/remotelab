#!/bin/bash
set -euo pipefail

trap 'status=$?; echo; echo "[smoke] failed with exit $status"; [ -f /tmp/remotelab-systemd-user.log ] && { echo "--- systemd-user log ---"; cat /tmp/remotelab-systemd-user.log; }; [ -f /tmp/remotelab-setup.log ] && { echo "--- setup log ---"; cat /tmp/remotelab-setup.log; }; exit $status' ERR

export DEBIAN_FRONTEND=noninteractive
export HOME=/root
export SHELL=/bin/bash
export XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp/run-user-$(id -u)}
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus

log() {
  printf '\n==> %s\n' "$1"
}

wait_for_http() {
  local url="$1"
  for _ in $(seq 1 40); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_user_systemd() {
  for _ in $(seq 1 20); do
    if systemctl --user show-environment >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

strip_ansi() {
  sed -r 's/\x1b\[[0-9;]*[A-Za-z]//g'
}

log "Installing Ubuntu packages"
apt-get update
apt-get install -y --no-install-recommends \
  bash ca-certificates curl dbus-user-session dtach jq lsof procps psmisc systemd systemd-container xz-utils

log "Installing Node.js 20"
ARCH="$(dpkg --print-architecture)"
case "$ARCH" in
  amd64) NODE_ARCH="x64" ;;
  arm64) NODE_ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
curl -fsSL "https://nodejs.org/dist/v20.19.0/node-v20.19.0-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
node --version
npm --version

log "Installing test stubs for claude and ttyd"
cat > /usr/local/bin/claude <<'STUB'
#!/bin/bash
if [[ "${1:-}" == "--version" ]]; then
  echo "claude test stub"
  exit 0
fi
exec /bin/bash
STUB
chmod +x /usr/local/bin/claude

cat > /usr/local/bin/ttyd <<'STUB'
#!/bin/bash
while [[ $# -gt 0 ]]; do
  shift
done
exec sleep 3600
STUB
chmod +x /usr/local/bin/ttyd

log "Starting dbus and systemd user manager"
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME/systemd/user"
chmod 700 "$XDG_RUNTIME_DIR"
rm -f "$XDG_RUNTIME_DIR/bus"
dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork --nopidfile
/usr/lib/systemd/systemd --user >/tmp/remotelab-systemd-user.log 2>&1 &

wait_for_user_systemd
systemctl --user show-environment >/dev/null

log "Running localhost setup-linux.sh"
SETUP_LOG=/tmp/remotelab-setup.log
printf '2\n\n\n\n' | bash /workspace/setup-linux.sh | tee "$SETUP_LOG"
PASSWORD="$(strip_ansi < "$SETUP_LOG" | sed -n 's/^.*Password generated: //p' | tail -1)"
if [[ -z "$PASSWORD" ]]; then
  echo "Failed to extract generated password" >&2
  exit 1
fi
printf 'Captured password length: %s\n' "${#PASSWORD}"

log "Checking auth-proxy systemd service"
systemctl --user status remotelab-auth-proxy.service --no-pager || true
systemctl --user is-active --quiet remotelab-auth-proxy.service

log "Fetching login page"
wait_for_http "http://127.0.0.1:7681/login"
curl -fsS http://127.0.0.1:7681/login | grep -q "Claude Code"

log "Logging in and checking dashboard"
COOKIE_JAR=/tmp/remotelab-cookies.txt
curl -fsS -c "$COOKIE_JAR" -b "$COOKIE_JAR" -o /tmp/login-response.html -D /tmp/login-headers.txt \
  -X POST http://127.0.0.1:7681/login \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "username=claude" \
  --data-urlencode "password=$PASSWORD"
grep -q '^Location: /' /tmp/login-headers.txt
curl -fsS -c "$COOKIE_JAR" -b "$COOKIE_JAR" http://127.0.0.1:7681/ | grep -q "Session Manager"

log "Creating a shell session"
mkdir -p /tmp/remotelab-project
CREATE_RESPONSE="$(curl -fsS -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke","folder":"/tmp/remotelab-project","type":"shell"}' \
  http://127.0.0.1:7681/api/sessions)"
echo "$CREATE_RESPONSE" | jq -e '.session.id and .session.tool == "shell"' >/dev/null
SESSION_ID="$(echo "$CREATE_RESPONSE" | jq -r '.session.id')"

log "Listing sessions"
curl -fsS -c "$COOKIE_JAR" -b "$COOKIE_JAR" http://127.0.0.1:7681/api/sessions | jq -e --arg id "$SESSION_ID" '.sessions[] | select(.id == $id)' >/dev/null

log "Smoke test passed"
