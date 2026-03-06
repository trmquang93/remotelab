# Contributing to remotelab

Thank you for your interest in contributing! This document explains how to get set up
for local development and how to submit changes.

## Development Environment

### Requirements

- macOS or Linux with `systemd --user`
- [Homebrew](https://brew.sh)
- Node.js 18+
- `ttyd`, `cloudflared`, `dtach` (installed by `setup.sh` on macOS; `setup-linux.sh` can install them automatically on supported Linux distros)
- Claude Code CLI and Codex CLI (installed automatically by `setup-linux.sh` when missing on supported Linux distros)

### First-time Setup

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/remotelab.git
cd remotelab

# Run the automated setup (will prompt for domain and credentials)
./setup.sh        # macOS
./setup-linux.sh  # Linux/systemd
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
./start.sh        # macOS LaunchAgents
./stop.sh

./start-linux.sh  # Linux systemd user services
./stop-linux.sh

# View live logs
tail -f ~/Library/Logs/auth-proxy.log
tail -f ~/Library/Logs/ttyd-claude.log
```

### Docker smoke test (Ubuntu 22.04)

Use the reusable Docker smoke test to validate Linux `systemd --user` localhost setup end-to-end:

```bash
bash tests/docker/run-ubuntu22-localhost-smoke.sh
```

What it covers:
- Starts a temporary Ubuntu 22.04 container with `systemd`
- Runs `setup-linux.sh` in localhost mode
- Verifies the login page and login flow
- Creates a shell session and checks `/api/sessions`

You can override the image when needed:

```bash
bash tests/docker/run-ubuntu22-localhost-smoke.sh <image>
```

### Reloading auth-proxy after code changes

```bash
launchctl unload ~/Library/LaunchAgents/com.authproxy.claude.plist
launchctl load  ~/Library/LaunchAgents/com.authproxy.claude.plist

# Linux
systemctl --user restart remotelab-auth-proxy.service
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

Linux systemd user-service support now lives in `setup-linux.sh`,
`start-linux.sh`, `stop-linux.sh`, and `templates/systemd/`. Follow the current
service model: `auth-proxy` and `cloudflared` are managed by the init system,
while ttyd is spawned per session by `auth-proxy`.

## Reporting Issues

Please open a GitHub Issue with:
- macOS version and architecture (Intel / Apple Silicon)
- Node.js version (`node --version`)
- Relevant log output from `~/Library/Logs/auth-proxy.error.log` or `ttyd-claude.error.log`
- Steps to reproduce the problem
