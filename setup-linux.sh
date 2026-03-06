#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SYSTEMD_TEMPLATE_DIR="$SCRIPT_DIR/templates/systemd"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_header() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}\n"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

escape_systemd_value() {
    printf '"%s"' "$(printf '%s' "$1" | sed 's/"/\\"/g')"
}

detect_package_manager() {
    for pm in apt-get dnf yum pacman zypper; do
        if command -v "$pm" >/dev/null 2>&1; then
            echo "$pm"
            return 0
        fi
    done
    return 1
}

print_linux_install_help() {
    local use_cloudflare="$1"
    local package_manager="${2:-}"

    echo ""
    echo "Install the missing Linux packages, then rerun ./setup-linux.sh"
    echo "Claude CLI: npm install -g @anthropic-ai/claude-code"

    case "$package_manager" in
        apt-get)
            echo "Common packages: sudo apt-get install -y nodejs npm dtach ttyd"
            ;;
        dnf)
            echo "Common packages: sudo dnf install -y nodejs npm dtach ttyd"
            ;;
        yum)
            echo "Common packages: sudo yum install -y nodejs npm dtach ttyd"
            ;;
        pacman)
            echo "Common packages: sudo pacman -S nodejs npm dtach ttyd"
            ;;
        zypper)
            echo "Common packages: sudo zypper install -y nodejs npm dtach ttyd"
            ;;
        *)
            echo "Install manually: node, npm, dtach, ttyd"
            ;;
    esac

    if [[ "$use_cloudflare" == true ]]; then
        echo "cloudflared: install the Cloudflare Tunnel client for your distro, then confirm 'cloudflared --version' works"
    fi
}

render_auth_proxy_unit() {
    local output_path="$1"
    local secure_cookies_line="$2"

    cat > "$output_path" <<UNIT
[Unit]
Description=remotelab auth proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$USER_HOME
ExecStart=$NODE_PATH $SCRIPT_DIR/auth-proxy.mjs
Restart=always
RestartSec=2
$secure_cookies_line

[Install]
WantedBy=default.target
UNIT
}

render_cloudflared_unit() {
    local output_path="$1"

    cat > "$output_path" <<UNIT
[Unit]
Description=remotelab Cloudflare tunnel
After=network-online.target remotelab-auth-proxy.service
Wants=network-online.target remotelab-auth-proxy.service

[Service]
Type=simple
WorkingDirectory=$USER_HOME
ExecStart=$CLOUDFLARED_PATH tunnel --config $HOME/.cloudflared/config.yml run
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT
}

if [[ "$(uname -s)" != "Linux" ]]; then
    print_error "This script only works on Linux"
    exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
    print_error "systemctl not found — this setup currently supports Linux distributions with systemd user services"
    exit 1
fi

print_header "Claude Code Remote Access Setup (Linux/systemd)"

if ! systemctl --user show-environment >/dev/null 2>&1; then
    print_error "Unable to reach your systemd user instance"
    echo ""
    echo "Open a normal desktop/login shell and confirm this works first:"
    echo "  systemctl --user status"
    exit 1
fi

echo "This script will help you set up remote browser access to Claude Code CLI on Linux."
echo ""
echo "Choose an access mode:"
echo "  1) Cloudflare  - HTTPS access from anywhere via a Cloudflare Tunnel"
echo "  2) Localhost   - HTTP access on this machine only (no Cloudflare needed)"
echo ""
read -r -p "Enter 1 or 2 [default: 1]: " MODE_CHOICE
MODE_CHOICE=${MODE_CHOICE:-1}

if [[ "$MODE_CHOICE" == "2" ]]; then
    USE_CLOUDFLARE=false
    print_success "Mode: Localhost only (http://localhost:7681)"
else
    USE_CLOUDFLARE=true
    print_success "Mode: Cloudflare HTTPS"
fi

echo ""
read -r -p "Press Enter to continue..."

print_header "Step 1: Configuration"

CURRENT_USER=$(id -un)
USER_HOME="$HOME"

echo "Current user: $CURRENT_USER"
echo "Home directory: $USER_HOME"
echo ""

if [[ "$USE_CLOUDFLARE" == true ]]; then
    while true; do
        read -r -p "Enter your domain (e.g., example.com): " DOMAIN
        if [[ -z "$DOMAIN" ]]; then
            print_error "Domain cannot be empty"
        else
            break
        fi
    done

    read -r -p "Enter subdomain for Claude access (default: claude): " SUBDOMAIN
    SUBDOMAIN=${SUBDOMAIN:-claude}
    FULL_DOMAIN="${SUBDOMAIN}.${DOMAIN}"

    print_success "Will configure: https://${FULL_DOMAIN}"
fi

read -r -p "Enter username for web login (default: claude): " WEB_USERNAME
WEB_USERNAME=${WEB_USERNAME:-claude}

print_info "Generating secure password..."
WEB_PASSWORD=$(openssl rand -base64 24)
print_success "Password generated: $WEB_PASSWORD"
echo ""
print_warning "Save this password now! It will NOT be stored in the credentials file."
read -r -p "Press Enter to continue once you have saved it..."

print_info "Generating authentication hash..."
node "$SCRIPT_DIR/hash-password.mjs" "$WEB_USERNAME" "$WEB_PASSWORD"
print_success "Authentication configured"

print_header "Step 2: Checking Dependencies"

PACKAGE_MANAGER=$(detect_package_manager || true)
MISSING_DEPS=()

if ! command -v claude >/dev/null 2>&1; then
    print_error "Claude CLI not found"
    MISSING_DEPS+=("claude")
else
    print_success "Claude CLI installed at: $(command -v claude)"
fi

if ! command -v node >/dev/null 2>&1; then
    print_error "Node.js not found"
    MISSING_DEPS+=("node")
else
    NODE_PATH=$(command -v node)
    print_success "Node.js installed at: $NODE_PATH"
fi

if ! command -v dtach >/dev/null 2>&1; then
    print_error "dtach not found"
    MISSING_DEPS+=("dtach")
else
    print_success "dtach installed"
fi

if ! command -v ttyd >/dev/null 2>&1; then
    print_error "ttyd not found"
    MISSING_DEPS+=("ttyd")
else
    print_success "ttyd installed"
fi

if [[ "$USE_CLOUDFLARE" == true ]]; then
    if ! command -v cloudflared >/dev/null 2>&1; then
        print_error "cloudflared not found"
        MISSING_DEPS+=("cloudflared")
    else
        CLOUDFLARED_PATH=$(command -v cloudflared)
        print_success "cloudflared installed at: $CLOUDFLARED_PATH"
    fi
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    print_warning "ANTHROPIC_API_KEY not set in environment"
    echo ""
    print_info "Make sure to export ANTHROPIC_API_KEY in ~/.zshrc, ~/.bashrc, or ~/.profile"
fi

if [[ ${#MISSING_DEPS[@]} -gt 0 ]]; then
    print_error "Missing dependencies: ${MISSING_DEPS[*]}"
    print_linux_install_help "$USE_CLOUDFLARE" "$PACKAGE_MANAGER"
    exit 1
fi

print_header "Step 3: Cloudflare Setup"

if [[ "$USE_CLOUDFLARE" == true ]]; then
    mkdir -p "$HOME/.cloudflared"

    if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
        print_info "Cloudflared needs to authenticate with your Cloudflare account"
        echo "A browser may open. Please select your domain: $DOMAIN"
        read -r -p "Press Enter to continue..."

        cloudflared tunnel login

        if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
            print_error "Authentication failed. cert.pem not found."
            exit 1
        fi
    fi

    print_success "Cloudflared authenticated"
    print_info "Creating Cloudflare tunnel..."
    TUNNEL_NAME="claude-code-$(date +%s)"
    TUNNEL_OUTPUT=$(cloudflared tunnel create "$TUNNEL_NAME")
    TUNNEL_ID=$(echo "$TUNNEL_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)

    if [[ -z "$TUNNEL_ID" ]]; then
        print_error "Failed to create tunnel"
        exit 1
    fi

    print_success "Tunnel created: $TUNNEL_NAME (ID: $TUNNEL_ID)"
    print_info "Routing DNS..."
    cloudflared tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$FULL_DOMAIN"
    print_success "DNS routed: $FULL_DOMAIN → tunnel"
else
    print_info "Cloudflare step skipped for localhost-only mode"
fi

print_header "Step 4: Creating Configuration Files"

mkdir -p "$HOME/.local/bin"
mkdir -p "$SYSTEMD_USER_DIR"

if [[ "$USE_CLOUDFLARE" == true ]]; then
    print_info "Creating cloudflared config..."
    cat > "$HOME/.cloudflared/config.yml" <<CONFIG
 tunnel: $TUNNEL_NAME
 credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
 
 ingress:
   - hostname: $FULL_DOMAIN
     service: http://localhost:7681
   - service: http_status:404
CONFIG
    sed -i.bak 's/^ //' "$HOME/.cloudflared/config.yml"
    rm -f "$HOME/.cloudflared/config.yml.bak"
    print_success "Created: ~/.cloudflared/config.yml"
fi

print_info "Installing claude-ttyd-session wrapper..."
chmod +x "$SCRIPT_DIR/claude-ttyd-session"
ln -sf "$SCRIPT_DIR/claude-ttyd-session" "$HOME/.local/bin/claude-ttyd-session"
print_success "Installed: ~/.local/bin/claude-ttyd-session"

if [[ ! -f "$SYSTEMD_TEMPLATE_DIR/remotelab-auth-proxy.service" ]]; then
    print_error "Missing systemd template: $SYSTEMD_TEMPLATE_DIR/remotelab-auth-proxy.service"
    exit 1
fi

AUTH_SERVICE_PATH="$SYSTEMD_USER_DIR/remotelab-auth-proxy.service"
SECURE_COOKIES_LINE=""
if [[ "$USE_CLOUDFLARE" == false ]]; then
    SECURE_COOKIES_LINE='Environment="SECURE_COOKIES=0"'
fi

print_info "Creating auth-proxy systemd unit..."
render_auth_proxy_unit "$AUTH_SERVICE_PATH" "$SECURE_COOKIES_LINE"
chmod 644 "$AUTH_SERVICE_PATH"
print_success "Created: $AUTH_SERVICE_PATH"

CLOUDFLARED_SERVICE_PATH="$SYSTEMD_USER_DIR/remotelab-cloudflared.service"
if [[ "$USE_CLOUDFLARE" == true ]]; then
    if [[ ! -f "$SYSTEMD_TEMPLATE_DIR/remotelab-cloudflared.service" ]]; then
        print_error "Missing systemd template: $SYSTEMD_TEMPLATE_DIR/remotelab-cloudflared.service"
        exit 1
    fi

    print_info "Creating cloudflared systemd unit..."
    render_cloudflared_unit "$CLOUDFLARED_SERVICE_PATH"
    chmod 644 "$CLOUDFLARED_SERVICE_PATH"
    print_success "Created: $CLOUDFLARED_SERVICE_PATH"
else
    if [[ -f "$CLOUDFLARED_SERVICE_PATH" ]]; then
        systemctl --user disable --now remotelab-cloudflared.service >/dev/null 2>&1 || true
        rm -f "$CLOUDFLARED_SERVICE_PATH"
        print_success "Removed old cloudflared systemd unit"
    fi
fi

print_info "Creating credentials.txt..."
if [[ "$USE_CLOUDFLARE" == true ]]; then
    cat > "$SCRIPT_DIR/credentials.txt" <<CREDENTIALS
# Claude Code Remote Access Credentials
# Generated: $(date)

URL: https://$FULL_DOMAIN
Username: $WEB_USERNAME
Password: [shown during setup - not saved for security]

Domain: $DOMAIN
Subdomain: $SUBDOMAIN
Tunnel Name: $TUNNEL_NAME
Tunnel ID: $TUNNEL_ID

# Configuration Files:
- Cloudflared config: ~/.cloudflared/config.yml
- Cloudflared credentials: ~/.cloudflared/$TUNNEL_ID.json
- auth-proxy service: $AUTH_SERVICE_PATH
- cloudflared service: $CLOUDFLARED_SERVICE_PATH

# Management:
Start services: $SCRIPT_DIR/start-linux.sh
Stop services: $SCRIPT_DIR/stop-linux.sh

# KEEP THIS FILE SECURE!
CREDENTIALS
else
    cat > "$SCRIPT_DIR/credentials.txt" <<CREDENTIALS
# Claude Code Local Access Credentials
# Generated: $(date)
# Mode: Localhost only (no Cloudflare)

URL: http://localhost:7681
Username: $WEB_USERNAME
Password: [shown during setup - not saved for security]

# Configuration Files:
- auth-proxy service: $AUTH_SERVICE_PATH

# Management:
Start services: $SCRIPT_DIR/start-linux.sh
Stop services: $SCRIPT_DIR/stop-linux.sh

# KEEP THIS FILE SECURE!
CREDENTIALS
fi
chmod 600 "$SCRIPT_DIR/credentials.txt"
print_success "Created: credentials.txt (saved securely)"

print_header "Step 5: Starting Services"

print_info "Stopping any existing services..."
systemctl --user stop remotelab-auth-proxy.service >/dev/null 2>&1 || true
if [[ "$USE_CLOUDFLARE" == true ]]; then
    systemctl --user stop remotelab-cloudflared.service >/dev/null 2>&1 || true
fi

print_info "Reloading systemd user units..."
systemctl --user daemon-reload
systemctl --user enable remotelab-auth-proxy.service >/dev/null
systemctl --user restart remotelab-auth-proxy.service
if [[ "$USE_CLOUDFLARE" == true ]]; then
    systemctl --user enable remotelab-cloudflared.service >/dev/null
    systemctl --user restart remotelab-cloudflared.service
fi

sleep 2

if systemctl --user is-active --quiet remotelab-auth-proxy.service; then
    print_success "auth-proxy service running"
else
    print_error "auth-proxy service failed to start — check: journalctl --user -u remotelab-auth-proxy.service -n 50"
fi

if [[ "$USE_CLOUDFLARE" == true ]]; then
    if systemctl --user is-active --quiet remotelab-cloudflared.service; then
        print_success "cloudflared service running"
    else
        print_error "cloudflared service failed to start — check: journalctl --user -u remotelab-cloudflared.service -n 50"
    fi
fi

if command -v loginctl >/dev/null 2>&1; then
    LINGER_STATE=$(loginctl show-user "$CURRENT_USER" -p Linger --value 2>/dev/null || true)
    if [[ "$LINGER_STATE" != "yes" ]]; then
        print_warning "systemd lingering is disabled; services may stop after logout or reboot"
        echo "Enable it once with: sudo loginctl enable-linger $CURRENT_USER"
    else
        print_success "systemd lingering already enabled"
    fi
fi

if [[ "$USE_CLOUDFLARE" == true ]]; then
    print_header "Step 6: Verification"

    print_info "Checking tunnel status..."
    sleep 2
    cloudflared tunnel info "$TUNNEL_NAME" || print_warning "Tunnel info unavailable (this is sometimes normal)"

    if command -v dig >/dev/null 2>&1; then
        print_info "Checking DNS resolution..."
        DNS_RESULT=$(dig @1.1.1.1 "$FULL_DOMAIN" +short | head -2)
        if [[ -n "$DNS_RESULT" ]]; then
            print_success "DNS resolving: $FULL_DOMAIN → $DNS_RESULT"
        else
            print_warning "DNS not yet propagated (can take 5-30 minutes)"
        fi
    fi
fi

print_header "Setup Complete!"

if [[ "$USE_CLOUDFLARE" == true ]]; then
    echo -e "${GREEN}✓ Claude Code is now accessible remotely from Linux!${NC}"
    echo ""
    echo "Access URL: ${BLUE}https://$FULL_DOMAIN${NC}"
else
    echo -e "${GREEN}✓ Claude Code is now accessible locally from Linux!${NC}"
    echo ""
    echo "Access URL: ${BLUE}http://localhost:7681${NC}"
fi

echo "Username: ${BLUE}$WEB_USERNAME${NC}"
echo "Password: ${BLUE}$WEB_PASSWORD${NC}"
echo ""
print_warning "SAVE THESE CREDENTIALS! They're also in: $SCRIPT_DIR/credentials.txt"
echo ""
echo "Management commands:"
echo "  Start: $SCRIPT_DIR/start-linux.sh"
echo "  Stop:  $SCRIPT_DIR/stop-linux.sh"
echo ""
echo "systemd commands:"
echo "  systemctl --user status remotelab-auth-proxy.service"
echo "  journalctl --user -u remotelab-auth-proxy.service -f"
if [[ "$USE_CLOUDFLARE" == true ]]; then
    echo "  systemctl --user status remotelab-cloudflared.service"
    echo "  journalctl --user -u remotelab-cloudflared.service -f"
fi
echo ""
print_success "Setup completed successfully!"
