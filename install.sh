#!/bin/bash
# xiNAS Installation Script
# Usage: curl -fsSL https://raw.githubusercontent.com/XinnorLab/xiNAS/main/install.sh | sudo bash
#    or: wget -qO- https://raw.githubusercontent.com/XinnorLab/xiNAS/main/install.sh | sudo bash

set -e

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# ── Output helpers ─────────────────────────────────────────────────────────────
SEP="${DIM}     ──────────────────────────────────────────────────────${NC}"

step() {
    echo ""
    echo -e "  ${CYAN}${BOLD}▶ $1${NC}"
    echo -e "$SEP"
}
ok()   { echo -e "     ${GREEN}✓${NC}  $*"; }
info() { echo -e "     ${DIM}›${NC}  $*"; }
warn() { echo -e "     ${YELLOW}⚠${NC}  $*"; }
fail() { echo -e "     ${RED}✗${NC}  $*"; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e "${BLUE}"
cat << 'EOF'

    ██╗  ██╗██╗███╗   ██╗ █████╗ ███████╗
    ╚██╗██╔╝██║████╗  ██║██╔══██╗██╔════╝
     ╚███╔╝ ██║██╔██╗ ██║███████║███████╗
     ██╔██╗ ██║██║╚██╗██║██╔══██║╚════██║
    ██╔╝ ██╗██║██║ ╚████║██║  ██║███████║
    ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝
EOF
echo -e "${NC}"
echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${YELLOW}${BOLD}  High-Performance NAS Provisioning${NC}"
echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Quick Start Guide ─────────────────────────────────────────────────────────
echo -e "  ${WHITE}┌───────────────────────────────────────────────────────┐${NC}"
echo -e "  ${WHITE}│${NC}  ${CYAN}${BOLD}✨  Welcome to xiNAS — let's get you started!${NC}       ${WHITE}│${NC}"
echo -e "  ${WHITE}└───────────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "  ${WHITE}${BOLD}QUICK START GUIDE${NC}"
echo -e "  ${DIM}───────────────────────────────────────────────────────${NC}"
echo ""
echo -e "  ${CYAN}${BOLD}①${NC}  ${WHITE}📊 Collect System Data${NC}"
echo -e "      ${DIM}Gather hardware info and generate your licensing key${NC}"
echo ""
echo -e "  ${YELLOW}${BOLD}②${NC}  ${WHITE}🔑 Obtain & Enter License${NC}  ${RED}${BOLD}★ Required${NC}"
echo -e "      ${DIM}Send hardware key to${NC} ${CYAN}support@xinnor.io${NC}"
echo -e "      ${DIM}then enter the received license in the menu${NC}"
echo ""
echo -e "  ${CYAN}${BOLD}③${NC}  ${WHITE}🌐 Configure Network${NC}  ${DIM}(optional — skip for auto-detect)${NC}"
echo -e "      ${DIM}Set IP ranges and interfaces for your storage network${NC}"
echo ""
echo -e "  ${CYAN}${BOLD}④${NC}  ${WHITE}🚀 Run Installation${NC}"
echo -e "      ${DIM}Select your profile and let the installer do the rest${NC}"
echo ""
echo -e "  ${DIM}───────────────────────────────────────────────────────${NC}"
echo -e "  ${DIM}💬 Questions?${NC}  ${CYAN}support@xinnor.io${NC}"
echo -e "  ${DIM}───────────────────────────────────────────────────────${NC}"
echo ""

# ── Confirm ───────────────────────────────────────────────────────────────────
read -p "  Ready to begin? [Y/n] " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo ""
    warn "Installation cancelled. Run this script again when ready."
    echo ""
    exit 0
fi

# ── Step 1: Requirements ──────────────────────────────────────────────────────
step "Checking requirements"

if [[ $EUID -ne 0 ]]; then
    fail "${RED}Must be run as root${NC}"
    echo ""
    echo -e "     Run:  ${CYAN}sudo bash <(curl -fsSL URL)${NC}"
    echo ""
    exit 1
fi
ok "Running as root"

if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    if [[ "$ID" != "ubuntu" ]]; then
        warn "xiNAS is designed for Ubuntu — detected: ${BOLD}$PRETTY_NAME${NC}"
        read -p "     Continue anyway? [y/N] " -n 1 -r
        echo ""
        [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
    else
        ok "OS: ${BOLD}$PRETTY_NAME${NC}"
    fi
else
    warn "Could not detect OS version"
fi

# ── Step 1b: Root SSH access ──────────────────────────────────────────────────
step "Configuring root SSH access"

# Ubuntu cloud images (AWS/GCP/Azure) drop a cloud-init config that sets
# PermitRootLogin no. We override it with a lower-numbered drop-in so
# key-based root SSH works for the AI / MCP bridge.
_sshd_dropin="/etc/ssh/sshd_config.d/10-xinas-root-access.conf"
mkdir -p /etc/ssh/sshd_config.d
if [[ ! -f "$_sshd_dropin" ]]; then
    cat > "$_sshd_dropin" <<'SSHEOF'
# Managed by xiNAS installer
# Allows key-based root SSH login (for Claude Code MCP stdio transport)
# Password root login remains blocked by Ubuntu default policy
PermitRootLogin prohibit-password
SSHEOF
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    ok "Root SSH key-login enabled (password login stays blocked)"
else
    ok "Root SSH config already present"
fi

# Warn if root has no password — useful for console recovery and sudo auditing
_root_pw=$(passwd -S root 2>/dev/null | awk '{print $2}')
if [[ "$_root_pw" == "L" || "$_root_pw" == "NP" ]]; then
    warn "Root has no password set — run ${CYAN}xinas-menu${NC} → A → 4 to set one"
else
    ok "Root password is set"
fi

# ── Step 2: Repository ────────────────────────────────────────────────────────
INSTALL_DIR="/opt/xiNAS"
REPO_URL="https://github.com/XinnorLab/xiNAS.git"

step "Setting up repository"
info "Target: ${WHITE}${INSTALL_DIR}${NC}"

if ! command -v git &>/dev/null; then
    info "Installing git..."
    apt-get update -qq
    apt-get install -y git -qq
    ok "git installed"
else
    ok "git found"
fi

if [[ -d "$INSTALL_DIR" ]]; then
    info "Existing installation found — updating..."
    cd "$INSTALL_DIR"
    git fetch origin -q
    git reset --hard origin/main -q
    ok "Repository updated"
else
    info "Cloning repository..."
    git clone -q "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    ok "Repository cloned to ${WHITE}${INSTALL_DIR}${NC}"
fi

chmod +x ./*.sh 2>/dev/null || true

# ── Step 3: System preparation ────────────────────────────────────────────────
step "Launching setup wizard"
info "Installing Ansible, yq, and launching the provisioning menu..."
echo ""

./prepare_system.sh

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
_W=55
_bar() { printf '═%.0s' $(seq 1 $_W); }
_spc() { printf '%*s' "$1" ''; }
_dir_len=${#INSTALL_DIR}
echo -e "  ${GREEN}╔$(_bar)╗${NC}"
echo -e "  ${GREEN}║${NC}  ${GREEN}${BOLD}✓  xiNAS installed successfully!${NC}$(_spc $((_W - 34)))${GREEN}║${NC}"
echo -e "  ${GREEN}║${NC}$(_spc $_W)${GREEN}║${NC}"
echo -e "  ${GREEN}║${NC}  ${DIM}Directory :${NC}  ${WHITE}${INSTALL_DIR}${NC}$(_spc $((_W - 15 - _dir_len)))${GREEN}║${NC}"
echo -e "  ${GREEN}║${NC}  ${DIM}Management:${NC}  ${CYAN}sudo xinas-menu${NC}$(_spc $((_W - 29)))${GREEN}║${NC}"
echo -e "  ${GREEN}╚$(_bar)╝${NC}"
echo ""
