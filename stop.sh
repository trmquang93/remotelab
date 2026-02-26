#!/bin/bash
echo "Stopping Claude Code web services..."
# Unload legacy shared ttyd plist if present
launchctl unload ~/Library/LaunchAgents/com.ttyd.claude.plist 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/com.authproxy.claude.plist 2>/dev/null || echo "auth-proxy not loaded"
if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
  launchctl unload ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared not loaded"
fi
echo "Services stopped!"
