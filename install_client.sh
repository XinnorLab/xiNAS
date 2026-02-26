#!/usr/bin/env bash
# xiNAS Client One-Shot Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/XinnorLab/xiNAS/main/install_client.sh | sudo bash
#    or: wget -qO- https://raw.githubusercontent.com/XinnorLab/xiNAS/main/install_client.sh | sudo bash

set -euo pipefail

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
    local n="$1" total="$2" msg="$3"
    echo ""
    echo -e "  ${CYAN}${BOLD}▶ Step ${n} / ${total}${NC}  ${WHITE}${BOLD}${msg}${NC}"
    echo -e "$SEP"
}
ok()    { echo -e "     ${GREEN}✓${NC}  $*"; }
skip()  { echo -e "     ${DIM}–${NC}  $*"; }
info()  { echo -e "     ${DIM}›${NC}  $*"; }
warn()  { echo -e "     ${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "     ${RED}✗${NC}  $*"; }

REPO_URL="https://github.com/XinnorLab/xiNAS.git"
INSTALL_DIR="/opt/xinas-client"

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
echo -e "  ${YELLOW}${BOLD}  NFS Client Installer${NC}"
echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Root check ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    fail "${RED}Must be run as root${NC}"
    echo ""
    echo -e "     Run:  ${CYAN}curl -fsSL https://raw.githubusercontent.com/XinnorLab/xiNAS/main/install_client.sh | sudo bash${NC}"
    echo ""
    exit 1
fi

# ── Step 1: Requirements ──────────────────────────────────────────────────────
step 1 4 "Checking system requirements"

if command -v apt-get &>/dev/null; then
    PKG_MGR="apt"
    PKG_UPDATE="apt-get update -qq"
    PKG_INSTALL="apt-get install -y -qq"
elif command -v dnf &>/dev/null; then
    PKG_MGR="dnf"
    PKG_UPDATE="dnf check-update || true"
    PKG_INSTALL="dnf install -y -q"
elif command -v yum &>/dev/null; then
    PKG_MGR="yum"
    PKG_UPDATE="yum check-update || true"
    PKG_INSTALL="yum install -y -q"
else
    fail "Unsupported package manager"
    echo ""
    echo -e "     ${DIM}Supported: apt (Debian/Ubuntu), dnf/yum (RHEL/CentOS/Fedora)${NC}"
    echo ""
    exit 1
fi

ok "Package manager: ${WHITE}${BOLD}${PKG_MGR}${NC}"
ok "Running as root"

# ── Step 2: Dependencies ──────────────────────────────────────────────────────
step 2 4 "Installing dependencies"

info "Refreshing package index..."
$PKG_UPDATE >/dev/null 2>&1 || true

if ! command -v git &>/dev/null; then
    info "Installing git..."
    $PKG_INSTALL git >/dev/null 2>&1
    ok "git installed"
else
    skip "git already present"
fi

if ! command -v whiptail &>/dev/null; then
    info "Installing whiptail..."
    if [[ "$PKG_MGR" == "apt" ]]; then
        $PKG_INSTALL whiptail >/dev/null 2>&1
    else
        $PKG_INSTALL newt >/dev/null 2>&1
    fi
    ok "whiptail installed"
else
    skip "whiptail already present"
fi

if ! command -v mount.nfs4 &>/dev/null; then
    info "Installing NFS tools..."
    if [[ "$PKG_MGR" == "apt" ]]; then
        $PKG_INSTALL nfs-common >/dev/null 2>&1
    else
        $PKG_INSTALL nfs-utils >/dev/null 2>&1
    fi
    ok "nfs-common installed"
else
    skip "NFS tools already present"
fi

# ── Step 3: Client package ────────────────────────────────────────────────────
step 3 4 "Downloading xiNAS client"

if [[ -d "$INSTALL_DIR" ]]; then
    info "Existing installation found — updating..."
    cd "$INSTALL_DIR"
    git pull --quiet origin main 2>/dev/null || true
    ok "Client updated"
else
    info "Cloning repository (sparse — client only)..."
    git clone --quiet --depth 1 --filter=blob:none --sparse "$REPO_URL" "$INSTALL_DIR" 2>/dev/null
    cd "$INSTALL_DIR"
    git sparse-checkout set client_repo 2>/dev/null
    ok "Client cloned to ${WHITE}${INSTALL_DIR}${NC}"
fi

if [[ ! -f "$INSTALL_DIR/client_repo/client_setup.sh" ]]; then
    fail "client_setup.sh not found — clone may have failed"
    exit 1
fi

chmod +x "$INSTALL_DIR/client_repo/client_setup.sh"

ln -sf "$INSTALL_DIR/client_repo/client_setup.sh" /usr/local/bin/xinas-client 2>/dev/null || true
ok "Command registered: ${WHITE}${BOLD}xinas-client${NC}"

# ── Step 4: NFS tuning ────────────────────────────────────────────────────────
step 4 4 "Configuring NFS client"

if [[ ! -f /etc/modprobe.d/nfsclient.conf ]]; then
    echo "options nfs max_session_slots=180" > /etc/modprobe.d/nfsclient.conf
    ok "NFS performance tuning applied ${DIM}(max_session_slots=180)${NC}"
else
    skip "NFS tuning already configured"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "  ${GREEN}║${NC}  ${GREEN}${BOLD}✓  xiNAS client installed successfully!${NC}              ${GREEN}║${NC}"
echo -e "  ${GREEN}║${NC}                                                       ${GREEN}║${NC}"
echo -e "  ${GREEN}║${NC}  ${DIM}Directory :${NC}  ${WHITE}${INSTALL_DIR}${NC}              ${GREEN}║${NC}"
echo -e "  ${GREEN}║${NC}  ${DIM}Command   :${NC}  ${CYAN}sudo xinas-client${NC}                    ${GREEN}║${NC}"
echo -e "  ${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${WHITE}${BOLD}Quick mount example:${NC}"
echo -e "  ${DIM}───────────────────────────────────────────────────────${NC}"
echo -e "     ${CYAN}sudo xinas-client${NC}  ${DIM}# interactive wizard${NC}"
echo -e "     ${CYAN}mount -t nfs -o vers=4.1,proto=rdma,port=20049 \\${NC}"
echo -e "           ${CYAN}<server-ip>:/mnt/data /mnt/nas${NC}  ${DIM}# manual mount${NC}"
echo -e "  ${DIM}───────────────────────────────────────────────────────${NC}"
echo ""

# ── Launch wizard ─────────────────────────────────────────────────────────────
if [[ -t 0 ]]; then
    echo -e "  ${YELLOW}Launch client setup now? [Y/n]${NC} "
    read -r -n 1 answer
    echo ""
    if [[ ! "${answer:-}" =~ ^[Nn]$ ]]; then
        exec "$INSTALL_DIR/client_repo/client_setup.sh"
    fi
else
    echo -e "     ${DIM}Run${NC} ${CYAN}sudo xinas-client${NC} ${DIM}to start the setup wizard${NC}"
    echo ""
fi
