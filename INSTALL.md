# Installation Guide

Access Claude Code CLI from any browser on any device via HTTPS.

## Prerequisites

### Required
- **macOS** (tested on macOS 11+)
- **Linux** with `systemd --user`
- **Homebrew** on macOS, or your Linux distro package manager
- **Node.js 18+**
- **Claude Code CLI / Codex CLI** — optional to preinstall; `setup-linux.sh` can install missing Linux dependencies automatically
- **Claude authentication** — run `claude login` or add your API key to your shell profile:
  ```bash
  echo 'export ANTHROPIC_API_KEY="your-key-here"' >> ~/.zshrc
  source ~/.zshrc
  ```
  The session wrapper (`claude-ttyd-session`) sources your shell profile at startup, so
  whichever auth method works in your terminal will work here.

### Domain Setup
- A domain name (can be cheap: $1–12/year from Namecheap, Porkbun, etc.)
- Cloudflare account (free plan works)
- Domain added to Cloudflare with nameservers updated

## Quick Start

### 1. Install your CLI tools

```bash
npm install -g @anthropic-ai/claude-code
# Then authenticate:
claude login
# OR add ANTHROPIC_API_KEY to ~/.zshrc / ~/.bash_profile
```

### 2. Set Up Cloudflare

1. Buy a domain (if you don't have one): Namecheap, Porkbun, etc.
2. Create an account at [Cloudflare](https://dash.cloudflare.com)
3. Add your domain to Cloudflare (free plan)
4. Update nameservers at your registrar to Cloudflare's nameservers
5. Wait for nameserver propagation (5–30 minutes)

### 3. Run Setup Script

```bash
cd /path/to/remotelab

# macOS
./setup.sh

# Linux
./setup-linux.sh
```

The script will:
- Check for required dependencies and auto-install missing Linux packages/tools (`node`, `dtach`, `ttyd`, `claude`, `codex`, and `cloudflared` in tunnel mode)
- Authenticate with Cloudflare (`cloudflared tunnel login`)
- Create and configure a named tunnel
- Generate a secure random password and create `~/.config/claude-web/auth.json`
- Create LaunchAgent plists on macOS or systemd user units on Linux
- Start all services and verify they are running
- Display your access URL and credentials

### 4. Access Claude Code

Once setup completes:

1. Open `https://yoursubdomain.yourdomain.com` in any browser
2. Enter the username and password shown at the end of setup
3. Create a session from the dashboard and start using Claude Code

**Credentials are also saved in `credentials.txt` — keep that file secure and do not commit it.**

## What Gets Installed

| Tool | Purpose |
|------|---------|
| `ttyd` | Terminal over HTTP/WebSockets |
| `cloudflared` | Cloudflare Tunnel client |
| `dtach` | Session persistence (keeps Claude running after disconnect) |

## Architecture

```
[Browser] --HTTPS--> [Cloudflare Tunnel] --localhost--> [auth-proxy:7681]
                                                              |
                                        +---------------------+---------------------+
                                        |                     |                     |
                                   GET /              GET /api/*            /terminal/*
                                   Dashboard       Session APIs          Proxy to ttyd:7682
                                                                                    |
                                                                    claude-ttyd-session <name> <folder>
                                                                                    |
                                                                    dtach -A <socket> claude
```

## Security Features

1. **HTTPS encryption** via Cloudflare edge
2. **scrypt-hashed passwords** (salt stored in `~/.config/claude-web/auth.json`)
3. **HttpOnly, Secure, SameSite=Strict session cookies** (24 h expiry by default)
4. **Localhost-only binding** — only `cloudflared` can reach auth-proxy; only auth-proxy can reach ttyd
5. **Session-based authentication** — all routes require a valid session cookie

## Post-Installation

### Start / Stop Services

```bash
# macOS
./start.sh
./stop.sh

# Linux
./start-linux.sh
./stop-linux.sh
```

### Check Status

```bash
# macOS
launchctl list | grep -E 'ttyd|authproxy|cloudflared'

# Linux
systemctl --user status remotelab-auth-proxy.service
systemctl --user status remotelab-cloudflared.service

lsof -i :7681   # auth-proxy
lsof -i :7682   # ttyd
cloudflared tunnel info <tunnel-name>
```

### View Logs

```bash
# macOS
tail -f ~/Library/Logs/auth-proxy.log
tail -f ~/Library/Logs/auth-proxy.error.log
tail -f ~/Library/Logs/ttyd-claude.log
tail -f ~/Library/Logs/ttyd-claude.error.log
tail -f ~/Library/Logs/cloudflared.log

# Linux
journalctl --user -u remotelab-auth-proxy.service -f
journalctl --user -u remotelab-cloudflared.service -f
```

### Change Password

```bash
node hash-password.mjs <username> <new-password>

# macOS reload
launchctl unload ~/Library/LaunchAgents/com.authproxy.claude.plist
launchctl load  ~/Library/LaunchAgents/com.authproxy.claude.plist

# Linux reload
systemctl --user restart remotelab-auth-proxy.service
```

### Uninstall

```bash
# macOS
./stop.sh
rm ~/Library/LaunchAgents/com.authproxy.claude.plist
rm ~/Library/LaunchAgents/com.cloudflared.tunnel.plist

# Linux
./stop-linux.sh
rm ~/.config/systemd/user/remotelab-auth-proxy.service
rm ~/.config/systemd/user/remotelab-cloudflared.service
systemctl --user daemon-reload

cloudflared tunnel delete <tunnel-name>
rm -rf ~/.cloudflared
rm -rf ~/.config/claude-web
```

## Troubleshooting

### DNS Not Resolving

**Problem**: Can't access the domain
**Solution**:
- Wait 5–30 minutes for DNS propagation
- Verify nameservers: `dig NS yourdomain.com +short`
- Should show Cloudflare nameservers (e.g., `kyra.ns.cloudflare.com`)

### "execvp failed" Error

**Problem**: Terminal shows "execvp failed: No such file or directory"
**Solution**:
- Verify Claude CLI is installed: `which claude`
- Verify authentication: `claude --version`
- Restart services: macOS `./stop.sh && ./start.sh`; Linux `./stop-linux.sh && ./start-linux.sh`

### Services Not Starting

```bash
tail -50 ~/Library/Logs/auth-proxy.error.log
tail -50 ~/Library/Logs/ttyd-claude.error.log

launchctl unload ~/Library/LaunchAgents/com.authproxy.claude.plist
launchctl load  ~/Library/LaunchAgents/com.authproxy.claude.plist

# Linux alternative
systemctl --user restart remotelab-auth-proxy.service
```

### Login Page Not Showing

```bash
lsof -i :7681
tail -f ~/Library/Logs/auth-proxy.error.log
cat ~/.config/claude-web/auth.json
```

### Can't Connect on Local Machine

**Problem**: Works on phone but not on Mac
**Solution**: Local DNS cache issue
```bash
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder
```

### Port Already in Use

```bash
lsof -i :7681   # find what's using auth-proxy port
lsof -i :7682   # find what's using ttyd port
```

## Mobile Access

Works on:
- iOS Safari
- Android Chrome
- Tablets
- Any modern browser

Features:
- Auto-resizing terminal (xterm.js)
- Session persistence across disconnects (dtach)
- Low latency via Cloudflare edge network

## Cost

- **Cloudflare**: free (tunnels are on the free plan)
- **Domain**: $1–12/year depending on TLD
- **Hosting**: free (runs on your own machine)
- **Claude API**: pay-per-use

## License

MIT — see [LICENSE](LICENSE).
