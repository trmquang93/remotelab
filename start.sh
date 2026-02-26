#!/bin/bash
echo "Starting Claude Code web services..."
# Unload legacy shared ttyd plist if present (ttyd is now managed per-session by auth-proxy)
if launchctl list | grep -q 'com.ttyd.claude'; then
  launchctl unload ~/Library/LaunchAgents/com.ttyd.claude.plist 2>/dev/null || true
  echo "Unloaded legacy shared ttyd service"
fi
launchctl load ~/Library/LaunchAgents/com.authproxy.claude.plist 2>/dev/null || echo "auth-proxy already loaded"
if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
  launchctl load ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared already loaded"
fi
echo "Services started!"
echo ""
echo "Check status with:"
echo "  launchctl list | grep -E 'authproxy|cloudflared'"
echo ""
echo "View logs:"
echo "  tail -f ~/Library/Logs/auth-proxy.log"
if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
  echo "  tail -f ~/Library/Logs/cloudflared.log"
fi
