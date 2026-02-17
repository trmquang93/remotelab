#!/bin/bash
echo "Starting Claude Code web services..."
launchctl load ~/Library/LaunchAgents/com.ttyd.claude.plist 2>/dev/null || echo "ttyd already loaded"
launchctl load ~/Library/LaunchAgents/com.authproxy.claude.plist 2>/dev/null || echo "auth-proxy already loaded"
if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
  launchctl load ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared already loaded"
fi
echo "Services started!"
echo ""
echo "Check status with:"
echo "  launchctl list | grep -E 'ttyd|authproxy|cloudflared'"
echo ""
echo "View logs:"
echo "  tail -f ~/Library/Logs/ttyd-claude.log"
echo "  tail -f ~/Library/Logs/auth-proxy.log"
if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
  echo "  tail -f ~/Library/Logs/cloudflared.log"
fi
