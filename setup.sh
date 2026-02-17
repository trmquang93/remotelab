#!/bin/bash
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
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

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    print_error "This script only works on macOS"
    exit 1
fi

print_header "Claude Code Remote Access Setup"

echo "This script will help you set up remote browser access to Claude Code CLI."
echo "You'll be able to access Claude from any device via HTTPS."
echo ""
read -p "Press Enter to continue..."

# Step 1: Gather configuration
print_header "Step 1: Configuration"

# Get current user
CURRENT_USER=$(whoami)
USER_HOME="$HOME"

echo "Current user: $CURRENT_USER"
echo "Home directory: $USER_HOME"
echo ""

# Get domain
while true; do
    read -p "Enter your domain (e.g., example.com): " DOMAIN
    if [[ -z "$DOMAIN" ]]; then
        print_error "Domain cannot be empty"
    else
        break
    fi
done

# Get subdomain
read -p "Enter subdomain for Claude access (default: claude): " SUBDOMAIN
SUBDOMAIN=${SUBDOMAIN:-claude}
FULL_DOMAIN="${SUBDOMAIN}.${DOMAIN}"

print_success "Will configure: https://${FULL_DOMAIN}"

# Get username for authentication
read -p "Enter username for web login (default: claude): " WEB_USERNAME
WEB_USERNAME=${WEB_USERNAME:-claude}

# Generate password
print_info "Generating secure password..."
WEB_PASSWORD=$(openssl rand -base64 24)
print_success "Password generated: $WEB_PASSWORD"
echo ""
print_warning "Save this password! You'll need it to log in."
read -p "Press Enter to continue..."

# Generate auth hash
print_info "Generating authentication hash..."
node "$SCRIPT_DIR/hash-password.mjs" "$WEB_USERNAME" "$WEB_PASSWORD"
print_success "Authentication configured"

# Step 2: Check dependencies
print_header "Step 2: Checking Dependencies"

MISSING_DEPS=()

# Check Homebrew
if ! command -v brew &> /dev/null; then
    print_error "Homebrew not found"
    MISSING_DEPS+=("homebrew")
else
    print_success "Homebrew installed"
fi

# Check Claude CLI
if ! command -v claude &> /dev/null; then
    print_error "Claude CLI not found"
    MISSING_DEPS+=("claude")
else
    CLAUDE_PATH=$(which claude)
    print_success "Claude CLI installed at: $CLAUDE_PATH"
fi

# Check Node.js
if ! command -v node &> /dev/null; then
    print_error "Node.js not found"
    MISSING_DEPS+=("node")
else
    NODE_PATH=$(which node)
    print_success "Node.js installed at: $NODE_PATH"
fi

# Check dtach
if ! command -v dtach &> /dev/null; then
    print_warning "dtach not found, will install"
    INSTALL_DTACH=true
else
    print_success "dtach installed"
    INSTALL_DTACH=false
fi

# Check ttyd
if ! command -v ttyd &> /dev/null; then
    print_warning "ttyd not found, will install"
    INSTALL_TTYD=true
else
    print_success "ttyd installed"
    INSTALL_TTYD=false
fi

# Check cloudflared
if ! command -v cloudflared &> /dev/null; then
    print_warning "cloudflared not found, will install"
    INSTALL_CLOUDFLARED=true
else
    print_success "cloudflared installed"
    INSTALL_CLOUDFLARED=false
fi

# Check ANTHROPIC_API_KEY
if [[ -z "$ANTHROPIC_API_KEY" ]]; then
    print_warning "ANTHROPIC_API_KEY not set in environment"
    echo ""
    print_info "Make sure to set ANTHROPIC_API_KEY in your shell profile (~/.zshrc or ~/.bash_profile)"
    echo "Example: export ANTHROPIC_API_KEY='your-key-here'"
fi

# Exit if critical dependencies missing
if [[ ${#MISSING_DEPS[@]} -gt 0 ]]; then
    print_error "Missing critical dependencies: ${MISSING_DEPS[*]}"
    echo ""
    echo "Please install:"
    for dep in "${MISSING_DEPS[@]}"; do
        case $dep in
            homebrew)
                echo "  Homebrew: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
                ;;
            claude)
                echo "  Claude CLI: npm install -g @anthropic-ai/claude-code"
                ;;
            node)
                echo "  Node.js: brew install node (or download from https://nodejs.org)"
                ;;
        esac
    done
    exit 1
fi

# Step 3: Install missing packages
if [[ "$INSTALL_DTACH" == true ]] || [[ "$INSTALL_TTYD" == true ]] || [[ "$INSTALL_CLOUDFLARED" == true ]]; then
    print_header "Step 3: Installing Packages"

    PACKAGES=()
    [[ "$INSTALL_DTACH" == true ]] && PACKAGES+=("dtach")
    [[ "$INSTALL_TTYD" == true ]] && PACKAGES+=("ttyd")
    [[ "$INSTALL_CLOUDFLARED" == true ]] && PACKAGES+=("cloudflared")

    print_info "Installing: ${PACKAGES[*]}"
    brew install "${PACKAGES[@]}"
    print_success "Packages installed"
fi

# Step 4: Cloudflare setup
print_header "Step 4: Cloudflare Setup"

echo "You need to:"
echo "1. Have a Cloudflare account (free plan works)"
echo "2. Add your domain ($DOMAIN) to Cloudflare"
echo "3. Update nameservers at your registrar to point to Cloudflare"
echo ""
read -p "Have you completed these steps? (y/n): " CLOUDFLARE_READY

if [[ "$CLOUDFLARE_READY" != "y" ]]; then
    print_warning "Please complete Cloudflare setup first:"
    echo "  1. Go to https://dash.cloudflare.com"
    echo "  2. Add your domain: $DOMAIN"
    echo "  3. Update nameservers at your registrar"
    echo "  4. Wait for nameserver propagation (5-30 minutes)"
    echo ""
    echo "Run this script again when ready."
    exit 0
fi

# Authenticate cloudflared
print_info "Authenticating cloudflared..."
echo "A browser will open. Please select your domain: $DOMAIN"
read -p "Press Enter to continue..."

cloudflared tunnel login

if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
    print_error "Authentication failed. cert.pem not found."
    exit 1
fi

print_success "Cloudflared authenticated"

# Create tunnel
print_info "Creating Cloudflare tunnel..."
TUNNEL_NAME="claude-code-$(date +%s)"
TUNNEL_OUTPUT=$(cloudflared tunnel create "$TUNNEL_NAME")
TUNNEL_ID=$(echo "$TUNNEL_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')

if [[ -z "$TUNNEL_ID" ]]; then
    print_error "Failed to create tunnel"
    exit 1
fi

print_success "Tunnel created: $TUNNEL_NAME (ID: $TUNNEL_ID)"

# Route DNS
print_info "Routing DNS..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$FULL_DOMAIN"
print_success "DNS routed: $FULL_DOMAIN → tunnel"

# Step 5: Create configuration files
print_header "Step 5: Creating Configuration Files"

# Create directories
mkdir -p "$HOME/.local/bin"
mkdir -p "$HOME/.cloudflared"
mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs"

# Create cloudflared config
print_info "Creating cloudflared config..."
cat > "$HOME/.cloudflared/config.yml" << EOF
tunnel: $TUNNEL_NAME
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $FULL_DOMAIN
    service: http://localhost:7681
  - service: http_status:404
EOF
print_success "Created: ~/.cloudflared/config.yml"

# Create dtach wrapper script
print_info "Creating dtach wrapper script..."

cat > "$SCRIPT_DIR/claude-ttyd-session" << EOF
#!/bin/bash
# Accept session name and folder as CLI arguments (passed by ttyd via --url-arg)
SESSION_NAME="\${1:-claude-web}"
WORK_DIR="\${2:-\$HOME}"

# Source shell profile to get proper PATH and environment
if [ -f "\$HOME/.zshrc" ]; then
    source "\$HOME/.zshrc"
elif [ -f "\$HOME/.bash_profile" ]; then
    source "\$HOME/.bash_profile"
fi

# Validate folder exists, fall back to \$HOME if not
if [ ! -d "\$WORK_DIR" ]; then
    echo "Warning: Folder '\$WORK_DIR' does not exist, falling back to \$HOME"
    WORK_DIR="\$HOME"
fi

SOCKET_DIR="\$HOME/.config/claude-web/sockets"
mkdir -p "\$SOCKET_DIR"
SOCKET="\$SOCKET_DIR/\$SESSION_NAME.dtach"

cd "\$WORK_DIR"
exec dtach -A "\$SOCKET" -Ez claude
EOF

chmod +x "$SCRIPT_DIR/claude-ttyd-session"
ln -sf "$SCRIPT_DIR/claude-ttyd-session" "$HOME/.local/bin/claude-ttyd-session"
print_success "Created: claude-ttyd-session wrapper"

# Create ttyd launchd plist
print_info "Creating ttyd service..."
cat > "$HOME/Library/LaunchAgents/com.ttyd.claude.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ttyd.claude</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which ttyd)</string>
        <string>--writable</string>
        <string>--port</string>
        <string>7682</string>
        <string>--interface</string>
        <string>lo0</string>
        <string>--ping-interval</string>
        <string>30</string>
        <string>--max-clients</string>
        <string>0</string>
        <string>--url-arg</string>
        <string>--client-option</string>
        <string>scrollback=10000</string>
        <string>--base-path</string>
        <string>/terminal</string>
        <string>$HOME/.local/bin/claude-ttyd-session</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>$USER_HOME</string>
    <key>StandardOutPath</key>
    <string>$USER_HOME/Library/Logs/ttyd-claude.log</string>
    <key>StandardErrorPath</key>
    <string>$USER_HOME/Library/Logs/ttyd-claude.error.log</string>
</dict>
</plist>
EOF
print_success "Created: ~/Library/LaunchAgents/com.ttyd.claude.plist"

# Create auth-proxy launchd plist
print_info "Creating auth-proxy service..."
cat > "$HOME/Library/LaunchAgents/com.authproxy.claude.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.authproxy.claude</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which node)</string>
        <string>$SCRIPT_DIR/auth-proxy.mjs</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>$USER_HOME</string>
    <key>StandardOutPath</key>
    <string>$USER_HOME/Library/Logs/auth-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>$USER_HOME/Library/Logs/auth-proxy.error.log</string>
</dict>
</plist>
EOF
print_success "Created: ~/Library/LaunchAgents/com.authproxy.claude.plist"

# Create cloudflared launchd plist
print_info "Creating cloudflared service..."
cat > "$HOME/Library/LaunchAgents/com.cloudflared.tunnel.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cloudflared.tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which cloudflared)</string>
        <string>tunnel</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>$USER_HOME</string>
    <key>StandardOutPath</key>
    <string>$USER_HOME/Library/Logs/cloudflared.log</string>
    <key>StandardErrorPath</key>
    <string>$USER_HOME/Library/Logs/cloudflared.error.log</string>
</dict>
</plist>
EOF
print_success "Created: ~/Library/LaunchAgents/com.cloudflared.tunnel.plist"

# Create start script
print_info "Creating start.sh..."
cat > "$SCRIPT_DIR/start.sh" << 'EOF'
#!/bin/bash
echo "Starting Claude Code web services..."
launchctl load ~/Library/LaunchAgents/com.ttyd.claude.plist 2>/dev/null || echo "ttyd already loaded"
launchctl load ~/Library/LaunchAgents/com.authproxy.claude.plist 2>/dev/null || echo "auth-proxy already loaded"
launchctl load ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared already loaded"
echo "Services started!"
echo ""
echo "Check status with:"
echo "  launchctl list | grep -E 'ttyd|authproxy|cloudflared'"
echo ""
echo "View logs:"
echo "  tail -f ~/Library/Logs/ttyd-claude.log"
echo "  tail -f ~/Library/Logs/auth-proxy.log"
echo "  tail -f ~/Library/Logs/cloudflared.log"
EOF
chmod +x "$SCRIPT_DIR/start.sh"
print_success "Created: start.sh"

# Create stop script
print_info "Creating stop.sh..."
cat > "$SCRIPT_DIR/stop.sh" << 'EOF'
#!/bin/bash
echo "Stopping Claude Code web services..."
launchctl unload ~/Library/LaunchAgents/com.ttyd.claude.plist 2>/dev/null || echo "ttyd not loaded"
launchctl unload ~/Library/LaunchAgents/com.authproxy.claude.plist 2>/dev/null || echo "auth-proxy not loaded"
launchctl unload ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared not loaded"
echo "Services stopped!"
EOF
chmod +x "$SCRIPT_DIR/stop.sh"
print_success "Created: stop.sh"

# Create credentials file
print_info "Creating credentials.txt..."
cat > "$SCRIPT_DIR/credentials.txt" << EOF
# Claude Code Remote Access Credentials
# Generated: $(date)

URL: https://$FULL_DOMAIN
Username: $WEB_USERNAME
Password: $WEB_PASSWORD

Domain: $DOMAIN
Subdomain: $SUBDOMAIN
Tunnel Name: $TUNNEL_NAME
Tunnel ID: $TUNNEL_ID

# Configuration Files:
- Cloudflared config: ~/.cloudflared/config.yml
- Cloudflared credentials: ~/.cloudflared/$TUNNEL_ID.json
- ttyd service: ~/Library/LaunchAgents/com.ttyd.claude.plist
- cloudflared service: ~/Library/LaunchAgents/com.cloudflared.tunnel.plist

# Management:
Start services: $SCRIPT_DIR/start.sh
Stop services: $SCRIPT_DIR/stop.sh

# KEEP THIS FILE SECURE!
EOF
chmod 600 "$SCRIPT_DIR/credentials.txt"
print_success "Created: credentials.txt (saved securely)"

# Step 6: Start services
print_header "Step 6: Starting Services"

print_info "Loading services..."
launchctl load "$HOME/Library/LaunchAgents/com.ttyd.claude.plist"
launchctl load "$HOME/Library/LaunchAgents/com.authproxy.claude.plist"
launchctl load "$HOME/Library/LaunchAgents/com.cloudflared.tunnel.plist"

sleep 3

# Verify services
TTYD_RUNNING=$(launchctl list | grep ttyd.claude || echo "")
AUTHPROXY_RUNNING=$(launchctl list | grep authproxy.claude || echo "")
CLOUDFLARED_RUNNING=$(launchctl list | grep cloudflared.tunnel || echo "")

if [[ -n "$TTYD_RUNNING" ]]; then
    print_success "ttyd service running"
else
    print_error "ttyd service failed to start"
fi

if [[ -n "$AUTHPROXY_RUNNING" ]]; then
    print_success "auth-proxy service running"
else
    print_error "auth-proxy service failed to start"
fi

if [[ -n "$CLOUDFLARED_RUNNING" ]]; then
    print_success "cloudflared service running"
else
    print_error "cloudflared service failed to start"
fi

# Step 7: Verify tunnel
print_header "Step 7: Verification"

print_info "Checking tunnel status..."
sleep 2
cloudflared tunnel info "$TUNNEL_NAME" || print_warning "Tunnel info unavailable (this is sometimes normal)"

print_info "Checking DNS resolution..."
sleep 2
DNS_RESULT=$(dig @1.1.1.1 "$FULL_DOMAIN" +short | head -2)
if [[ -n "$DNS_RESULT" ]]; then
    print_success "DNS resolving: $FULL_DOMAIN → $DNS_RESULT"
else
    print_warning "DNS not yet propagated (can take 5-30 minutes)"
fi

# Final summary
print_header "Setup Complete!"

echo -e "${GREEN}✓ Claude Code is now accessible remotely!${NC}"
echo ""
echo "Access URL: ${BLUE}https://$FULL_DOMAIN${NC}"
echo "Username: ${BLUE}$WEB_USERNAME${NC}"
echo "Password: ${BLUE}$WEB_PASSWORD${NC}"
echo ""
print_warning "SAVE THESE CREDENTIALS! They're also in: $SCRIPT_DIR/credentials.txt"
echo ""
echo "Next steps:"
echo "  1. Wait 5-30 minutes for DNS to fully propagate"
echo "  2. Open https://$FULL_DOMAIN in your browser (or on your phone)"
echo "  3. Enter your username and password"
echo "  4. Start using Claude Code from anywhere!"
echo ""
echo "Management commands:"
echo "  Start: $SCRIPT_DIR/start.sh"
echo "  Stop:  $SCRIPT_DIR/stop.sh"
echo ""
echo "Logs:"
echo "  ttyd: ~/Library/Logs/ttyd-claude.log"
echo "  cloudflared: ~/Library/Logs/cloudflared.log"
echo ""
print_success "Setup completed successfully!"
