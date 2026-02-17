# Contributing to claude-code-remote

Thank you for your interest in contributing! This document explains how to get set up
for local development and how to submit changes.

## Development Environment

### Requirements

- macOS (primary platform; Linux/systemd support is a welcome contribution)
- [Homebrew](https://brew.sh)
- Node.js 18+
- `ttyd`, `cloudflared`, `dtach` (installed by `setup.sh` or manually via `brew install ttyd cloudflared dtach`)
- Claude Code CLI: `npm install -g @anthropic-ai/claude-code`

### First-time Setup

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/claude-code-remote.git
cd claude-code-remote

# Run the automated setup (will prompt for domain and credentials)
./setup.sh
```

## Architecture Overview

Three services work together to provide a secure, persistent terminal session:

```
[Browser] --HTTPS--> [Cloudflare Tunnel] --localhost--> [auth-proxy:7681]
                                                              |
                                        +---------------------+---------------------+
                                        |                     |                     |
                                   GET /              GET /api/*            /terminal/*
                                   Dashboard       Session APIs           Proxy to ttyd:7682
                                                                                    |
                                                                    claude-ttyd-session <name> <folder>
                                                                                    |
                                                                    dtach -A <socket> claude
```

- **`auth-proxy.mjs`** — Node.js HTTP server. Handles login, the multi-session dashboard UI,
  session management APIs (`/api/*`), and WebSocket proxy forwarding to ttyd.
- **ttyd** — Third-party tool that turns a PTY into a WebSocket terminal. Invokes
  `claude-ttyd-session` with URL arguments for session name and folder path.
- **`claude-ttyd-session`** — Shell wrapper. Sources the user's shell profile so PATH is
  correct, then calls `dtach -A <socket> claude` to attach or create a persistent session.
- **dtach** — Detachable process tool (similar to `screen`/`tmux` but minimal). Keeps
  the Claude process running when the browser disconnects.

## Testing Changes Locally

### Running auth-proxy directly

```bash
# Start with default ports
node auth-proxy.mjs

# Override ports via env vars
LISTEN_PORT=8081 TTYD_PORT=8082 node auth-proxy.mjs
```

### Testing the full stack

```bash
./start.sh   # Start ttyd, auth-proxy, and cloudflared
./stop.sh    # Stop all services

# View live logs
tail -f ~/Library/Logs/auth-proxy.log
tail -f ~/Library/Logs/ttyd-claude.log
```

### Reloading auth-proxy after code changes

```bash
launchctl unload ~/Library/LaunchAgents/com.authproxy.claude.plist
launchctl load  ~/Library/LaunchAgents/com.authproxy.claude.plist
```

## Submitting Changes

1. Fork the repository and create a descriptive branch:
   ```bash
   git checkout -b fix/script-dir-bug
   git checkout -b feat/linux-systemd-support
   ```
2. Make your changes, keeping commits focused and commit messages clear.
3. Verify no secrets are accidentally included:
   ```bash
   grep -r "password\|api.key\|token\|secret" . --include="*.sh" --include="*.mjs" --include="*.md" -i | grep -v "example\|placeholder\|your-"
   ```
4. Open a Pull Request with a description of what changed and why.

## Linux / systemd Support

The current implementation uses macOS LaunchAgents. Contributions that add a
`setup-linux.sh` with systemd unit files for the same three services would be very
welcome. The core scripts (`auth-proxy.mjs`, `claude-ttyd-session`) are already
portable — only the service management layer needs to change.

## Reporting Issues

Please open a GitHub Issue with:
- macOS version and architecture (Intel / Apple Silicon)
- Node.js version (`node --version`)
- Relevant log output from `~/Library/Logs/auth-proxy.error.log` or `ttyd-claude.error.log`
- Steps to reproduce the problem
