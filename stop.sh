#!/bin/bash
echo "Stopping Claude Code web services..."
launchctl unload ~/Library/LaunchAgents/com.ttyd.claude.plist 2>/dev/null || echo "ttyd not loaded"
launchctl unload ~/Library/LaunchAgents/com.authproxy.claude.plist 2>/dev/null || echo "auth-proxy not loaded"
launchctl unload ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared not loaded"
echo "Services stopped!"
