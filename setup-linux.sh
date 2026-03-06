#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SYSTEMD_TEMPLATE_DIR="$SCRIPT_DIR/templates/systemd"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NODE_LTS_MAJOR="24"

export PATH="$HOME/.local/bin:/snap/bin:$PATH"

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

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

refresh_command_cache() {
    hash -r 2>/dev/null || true
}

run_as_root() {
    if [[ "$(id -u)" -eq 0 ]]; then
        bash -lc "$1"
    elif command_exists sudo; then
        sudo bash -lc "$1"
    else
        print_error "This step requires root privileges. Please install sudo or rerun as root."
        exit 1
    fi
}

detect_package_manager() {
    for pm in apt-get dnf yum pacman zypper; do
        if command_exists "$pm"; then
            echo "$pm"
            return 0
        fi
    done
    return 1
}

detect_node_arch() {
    case "$(uname -m)" in
        x86_64|amd64)
            echo "x64"
            ;;
        aarch64|arm64)
            echo "arm64"
            ;;
        armv7l)
            echo "armv7l"
            ;;
        *)
            print_error "Unsupported CPU architecture for automatic Node.js install: $(uname -m)"
            exit 1
            ;;
    esac
}

ensure_installer_prerequisites() {
    case "$PACKAGE_MANAGER" in
        apt-get)
            run_as_root "apt-get update && apt-get install -y ca-certificates curl gnupg xz-utils openssl"
            ;;
        dnf)
            run_as_root "dnf install -y ca-certificates curl gnupg2 xz openssl"
            ;;
        yum)
            run_as_root "yum install -y ca-certificates curl gnupg2 xz openssl"
            ;;
        pacman)
            run_as_root "pacman -Sy --noconfirm ca-certificates curl gnupg xz openssl"
            ;;
        zypper)
            run_as_root "zypper --non-interactive install ca-certificates curl gpg2 xz openssl"
            ;;
        *)
            print_error "Unsupported package manager for bootstrapping installer prerequisites"
            exit 1
            ;;
    esac
}

wait_for_command() {
    local binary="$1"
    local attempts="${2:-12}"
    for _ in $(seq 1 "$attempts"); do
        if command_exists "$binary"; then
            return 0
        fi
        sleep 1
    done
    return 1
}

install_nodejs() {
    if command_exists node && command_exists npm; then
        return 0
    fi

    print_info "Installing Node.js ${NODE_LTS_MAJOR}.x LTS from nodejs.org..."
    ensure_installer_prerequisites

    local node_arch base_url filename tmpfile
    node_arch="$(detect_node_arch)"
    base_url="https://nodejs.org/dist/latest-v${NODE_LTS_MAJOR}.x"
    filename="$(curl -fsSL "$base_url/SHASUMS256.txt" | awk '/linux-.*\.tar\.xz$/ {print $2}' | grep "linux-${node_arch}.tar.xz" | head -1)"

    if [[ -z "$filename" ]]; then
        print_error "Failed to resolve a Node.js tarball for architecture ${node_arch}"
        exit 1
    fi

    tmpfile="/tmp/${filename}"
    curl -fsSL "$base_url/$filename" -o "$tmpfile"
    run_as_root "tar -xJf '$tmpfile' -C /usr/local --strip-components=1"
    rm -f "$tmpfile"
    refresh_command_cache

    if ! (command_exists node && command_exists npm); then
        print_error "Node.js install completed but node/npm are still unavailable"
        exit 1
    fi
}

install_dtach() {
    if command_exists dtach; then
        return 0
    fi

    print_info "Installing dtach from the system package manager..."
    case "$PACKAGE_MANAGER" in
        apt-get)
            run_as_root "apt-get update && apt-get install -y dtach"
            ;;
        dnf)
            run_as_root "dnf install -y dtach"
            ;;
        yum)
            run_as_root "yum install -y dtach"
            ;;
        pacman)
            run_as_root "pacman -Sy --noconfirm dtach"
            ;;
        zypper)
            run_as_root "zypper --non-interactive install dtach"
            ;;
        *)
            print_error "Automatic dtach install is unsupported on this Linux distribution"
            exit 1
            ;;
    esac
    refresh_command_cache
}

install_ttyd_from_package() {
    case "$PACKAGE_MANAGER" in
        apt-get)
            run_as_root "apt-get update && apt-get install -y ttyd" || return 1
            ;;
        dnf)
            run_as_root "dnf install -y ttyd" || return 1
            ;;
        yum)
            run_as_root "yum install -y ttyd" || return 1
            ;;
        pacman)
            run_as_root "pacman -Sy --noconfirm ttyd" || return 1
            ;;
        zypper)
            run_as_root "zypper --non-interactive install ttyd" || return 1
            ;;
        *)
            return 1
            ;;
    esac
}

install_ttyd_from_binary() {
    local arch url tmpfile dst

    case "$(uname -m)" in
        x86_64|amd64)
            arch="x86_64" ;;
        aarch64|arm64)
            arch="aarch64" ;;
        *)
            print_warning "Unsupported CPU architecture for automatic ttyd binary install: $(uname -m)"
            return 1 ;;
    esac

    # Use a specific, known-good ttyd release to avoid surprises.
    url="https://github.com/tsl0922/ttyd/releases/download/1.7.4/ttyd.${arch}"
    tmpfile="/tmp/ttyd.${arch}"
    dst="$HOME/.local/bin/ttyd"

    print_info "Installing ttyd ${url##*/} to $dst..."
    mkdir -p "$(dirname "$dst")"
    if ! curl -fsSL "$url" -o "$tmpfile"; then
        print_warning "Failed to download ttyd binary from $url"
        return 1
    fi
    chmod +x "$tmpfile"
    mv "$tmpfile" "$dst"
}

install_ttyd() {
    # If ttyd is already present, prefer the existing installation.
    if command_exists ttyd; then
        print_success "ttyd installed at: $(command -v ttyd)"
        return 0
    fi

    print_info "ttyd not found; attempting to install from package manager..."
    if install_ttyd_from_package; then
        refresh_command_cache
        if command_exists ttyd; then
            print_success "ttyd installed via $PACKAGE_MANAGER: $(command -v ttyd)"
            return 0
        fi
        print_warning "Package manager reported success but ttyd is still missing from PATH."
    else
        print_warning "Package manager does not provide ttyd or installation failed."
    fi

    print_info "Attempting to install ttyd from official binary release..."
    if install_ttyd_from_binary; then
        refresh_command_cache
        if command_exists ttyd; then
            print_success "ttyd installed from official binary: $(command -v ttyd)"
            return 0
        fi
        print_warning "Binary ttyd install completed but ttyd is not on PATH."
    else
        print_warning "Automatic ttyd binary install failed."
    fi

    print_error "ttyd is not installed."
    echo ""
    echo "Please install ttyd manually (for example from your distribution packages or"
    echo "from the official releases at: https://github.com/tsl0922/ttyd/releases) and"
    echo "ensure 'ttyd' is on your PATH, then re-run this setup script."
    exit 1
}

install_claude() {
    if command_exists claude; then
        return 0
    fi

    print_info "Installing Claude Code using Anthropic's Linux installer..."
    ensure_installer_prerequisites
    bash -lc 'curl -fsSL https://claude.ai/install.sh | bash'
    refresh_command_cache
    wait_for_command claude 20 || {
        print_error "Claude Code install completed but the claude command is still unavailable"
        exit 1
    }
}

install_codex() {
    if command_exists codex; then
        return 0
    fi

    print_info "Installing OpenAI Codex CLI with npm..."
    mkdir -p "$HOME/.local/bin"
    NPM_CONFIG_PREFIX="$HOME/.local" npm install -g @openai/codex
    refresh_command_cache
    wait_for_command codex 20 || {
        print_error "Codex install completed but the codex command is still unavailable"
        exit 1
    }
}

install_cloudflared() {
    if command_exists cloudflared; then
        return 0
    fi

    print_info "Installing cloudflared from Cloudflare's Linux packages..."
    ensure_installer_prerequisites

    case "$PACKAGE_MANAGER" in
        apt-get)
            run_as_root "mkdir -p --mode=0755 /usr/share/keyrings"
            run_as_root "curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | gpg --dearmor --yes -o /usr/share/keyrings/cloudflare-main.gpg"
            run_as_root "echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list"
            run_as_root "apt-get update && apt-get install -y cloudflared"
            ;;
        dnf)
            run_as_root "curl -fsSL https://pkg.cloudflare.com/cloudflared-ascii.repo -o /etc/yum.repos.d/cloudflared.repo"
            run_as_root "dnf install -y cloudflared"
            ;;
        yum)
            run_as_root "curl -fsSL https://pkg.cloudflare.com/cloudflared-ascii.repo -o /etc/yum.repos.d/cloudflared.repo"
            run_as_root "yum install -y cloudflared"
            ;;
        pacman)
            run_as_root "pacman -Sy --noconfirm cloudflared"
            ;;
        *)
            print_error "Automatic cloudflared install is unsupported on this Linux distribution"
            exit 1
            ;;
    esac
    refresh_command_cache
}

print_linux_install_help() {
    local use_cloudflare="$1"
    local package_manager="${2:-}"

    echo ""
    echo "Automatic installation is built in for Node.js, dtach, ttyd, Claude Code, Codex, and cloudflared."
    echo "If an install still fails, verify your Linux distribution has sudo/root access and outbound internet access."

    case "$package_manager" in
        apt-get)
            echo "Ubuntu/Debian note: the script uses nodejs.org, snap (ttyd), Anthropic's installer, npm, and Cloudflare's package repository."
            ;;
        dnf|yum|pacman|zypper)
            echo "This distro uses a best-effort mix of official installers and package managers."
            ;;
        *)
            echo "Install manually: node, dtach, ttyd, claude, codex, and optionally cloudflared."
            ;;
    esac

    if [[ "$use_cloudflare" == true ]]; then
        echo "Cloudflare Tunnel mode also requires successful cloudflared login and tunnel creation."
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

PACKAGE_MANAGER=$(detect_package_manager || true)
if [[ -z "$PACKAGE_MANAGER" ]]; then
    print_error "No supported package manager detected (apt-get, dnf, yum, pacman, zypper)"
    exit 1
fi

if ! command_exists openssl; then
    print_info "openssl not found; installing installer prerequisites first..."
    ensure_installer_prerequisites
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

print_header "Step 2: Checking and Installing Dependencies"

MISSING_DEPS=()

if ! command_exists node; then
    MISSING_DEPS+=("node")
fi
if ! command_exists npm; then
    MISSING_DEPS+=("npm")
fi
if ! command_exists dtach; then
    MISSING_DEPS+=("dtach")
fi
if ! command_exists ttyd; then
    MISSING_DEPS+=("ttyd")
fi
if ! command_exists claude; then
    MISSING_DEPS+=("claude")
fi
if ! command_exists codex; then
    MISSING_DEPS+=("codex")
fi
if [[ "$USE_CLOUDFLARE" == true ]] && ! command_exists cloudflared; then
    MISSING_DEPS+=("cloudflared")
fi

if [[ ${#MISSING_DEPS[@]} -gt 0 ]]; then
    print_info "Missing dependencies detected: ${MISSING_DEPS[*]}"
    install_nodejs
    install_dtach
    install_ttyd
    install_claude
    install_codex
    if [[ "$USE_CLOUDFLARE" == true ]]; then
        install_cloudflared
    fi
else
    print_success "All required dependencies are already installed"
fi

refresh_command_cache

NODE_PATH="$(command -v node)"
print_success "Node.js installed at: $NODE_PATH"
print_success "dtach installed at: $(command -v dtach)"
print_success "ttyd installed at: $(command -v ttyd)"
print_success "Claude Code installed at: $(command -v claude)"
print_success "Codex installed at: $(command -v codex)"
if [[ "$USE_CLOUDFLARE" == true ]]; then
    CLOUDFLARED_PATH="$(command -v cloudflared)"
    print_success "cloudflared installed at: $CLOUDFLARED_PATH"
fi

print_info "Generating authentication hash..."
node "$SCRIPT_DIR/hash-password.mjs" "$WEB_USERNAME" "$WEB_PASSWORD"
print_success "Authentication configured"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    print_warning "ANTHROPIC_API_KEY not set in environment"
    print_info "Claude Code may prompt you to run 'claude login' or export ANTHROPIC_API_KEY later"
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    print_warning "OPENAI_API_KEY not set in environment"
    print_info "Codex may prompt you to run 'codex login' or export OPENAI_API_KEY later"
fi

print_header "Step 3: Cloudflare Setup"

if [[ "$USE_CLOUDFLARE" == true ]]; then
    mkdir -p "$HOME/.cloudflared"
    TUNNEL_NAME=""
    TUNNEL_ID=""
    TUNNEL_CREDENTIALS_FILE=""

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
    if [[ -f "$HOME/.cloudflared/config.yml" ]]; then
        EXISTING_TUNNEL=$(awk -F': *' '$1=="tunnel"{print $2; exit}' "$HOME/.cloudflared/config.yml")
        EXISTING_CREDENTIALS_FILE=$(awk -F': *' '$1=="credentials-file"{print $2; exit}' "$HOME/.cloudflared/config.yml")

        if [[ -n "$EXISTING_TUNNEL" && -n "$EXISTING_CREDENTIALS_FILE" && -f "$EXISTING_CREDENTIALS_FILE" ]]; then
            if cloudflared tunnel info "$EXISTING_TUNNEL" >/dev/null 2>&1; then
                TUNNEL_NAME="$EXISTING_TUNNEL"
                TUNNEL_CREDENTIALS_FILE="$EXISTING_CREDENTIALS_FILE"
                TUNNEL_ID=$(basename "$TUNNEL_CREDENTIALS_FILE" .json)
                print_success "Reusing existing tunnel: $TUNNEL_NAME (ID: $TUNNEL_ID)"
            else
                print_warning "Existing tunnel '$EXISTING_TUNNEL' from ~/.cloudflared/config.yml is not accessible; creating a new one"
            fi
        fi
    fi

    if [[ -z "$TUNNEL_NAME" || -z "$TUNNEL_ID" ]]; then
        print_info "Creating Cloudflare tunnel..."
        TUNNEL_NAME="claude-code-$(date +%s)"
        TUNNEL_OUTPUT=$(cloudflared tunnel create "$TUNNEL_NAME")
        TUNNEL_ID=$(echo "$TUNNEL_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)

        if [[ -z "$TUNNEL_ID" ]]; then
            print_error "Failed to create tunnel"
            exit 1
        fi

        TUNNEL_CREDENTIALS_FILE="$HOME/.cloudflared/$TUNNEL_ID.json"
        print_success "Tunnel created: $TUNNEL_NAME (ID: $TUNNEL_ID)"
    fi

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
 credentials-file: $TUNNEL_CREDENTIALS_FILE
 
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
- Cloudflared credentials: $TUNNEL_CREDENTIALS_FILE
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
