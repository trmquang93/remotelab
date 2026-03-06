#!/bin/bash
set -euo pipefail

SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
AUTH_SERVICE="remotelab-auth-proxy.service"
CLOUDFLARED_SERVICE="remotelab-cloudflared.service"

echo "Stopping remotelab systemd user services..."
systemctl --user stop "$AUTH_SERVICE" 2>/dev/null || echo "auth-proxy not running"

if [ -f "$SERVICE_DIR/$CLOUDFLARED_SERVICE" ]; then
  systemctl --user stop "$CLOUDFLARED_SERVICE" 2>/dev/null || echo "cloudflared not running"
fi

echo "Services stopped!"
