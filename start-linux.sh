#!/bin/bash
set -euo pipefail

SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
AUTH_SERVICE="remotelab-auth-proxy.service"
CLOUDFLARED_SERVICE="remotelab-cloudflared.service"

echo "Starting remotelab systemd user services..."
systemctl --user daemon-reload
systemctl --user start "$AUTH_SERVICE"

if [ -f "$SERVICE_DIR/$CLOUDFLARED_SERVICE" ]; then
  systemctl --user start "$CLOUDFLARED_SERVICE"
fi

echo "Services started!"
echo ""
echo "Check status with:"
echo "  systemctl --user status $AUTH_SERVICE"
if [ -f "$SERVICE_DIR/$CLOUDFLARED_SERVICE" ]; then
  echo "  systemctl --user status $CLOUDFLARED_SERVICE"
fi
echo ""
echo "View logs with:"
echo "  journalctl --user -u $AUTH_SERVICE -f"
if [ -f "$SERVICE_DIR/$CLOUDFLARED_SERVICE" ]; then
  echo "  journalctl --user -u $CLOUDFLARED_SERVICE -f"
fi
