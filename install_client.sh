#!/usr/bin/env bash
# xiNAS Client One-Shot Installer
# Usage: curl -fsSL https://xinnor.io/install_client.sh | sudo bash
#    or: wget -qO- https://xinnor.io/install_client.sh | sudo bash

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

REPO_URL="https://github.com/XinnorLab/xiNAS.git"
INSTALL_DIR="/opt/xinas-client"

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
echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}     NFS Client Installer${NC}"
echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check root
if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}Error: This script must be run as root${NC}"
    echo "Usage: curl -fsSL https://xinnor.io/install_client.sh | sudo bash"
    exit 1
fi

echo -e "${CYAN}[1/4]${NC} Checking system requirements..."

# Detect package manager
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
    echo -e "${RED}Error: Unsupported package manager${NC}"
    echo "Supported: apt (Debian/Ubuntu), dnf/yum (RHEL/CentOS/Fedora)"
    exit 1
fi

echo -e "       Package manager: ${GREEN}$PKG_MGR${NC}"

# Install dependencies
echo -e "${CYAN}[2/4]${NC} Installing dependencies..."

$PKG_UPDATE >/dev/null 2>&1 || true

# Install git if not present
if ! command -v git &>/dev/null; then
    echo "       Installing git..."
    $PKG_INSTALL git >/dev/null 2>&1
fi

# Install whiptail if not present
if ! command -v whiptail &>/dev/null; then
    echo "       Installing whiptail..."
    if [[ "$PKG_MGR" == "apt" ]]; then
        $PKG_INSTALL whiptail >/dev/null 2>&1
    else
        $PKG_INSTALL newt >/dev/null 2>&1
    fi
fi

# Install NFS client tools
if ! command -v mount.nfs4 &>/dev/null; then
    echo "       Installing NFS tools..."
    if [[ "$PKG_MGR" == "apt" ]]; then
        $PKG_INSTALL nfs-common >/dev/null 2>&1
    else
        $PKG_INSTALL nfs-utils >/dev/null 2>&1
    fi
fi

echo -e "       ${GREEN}Dependencies installed${NC}"

# Clone or update repository
echo -e "${CYAN}[3/4]${NC} Downloading xiNAS client..."

if [[ -d "$INSTALL_DIR" ]]; then
    echo "       Updating existing installation..."
    cd "$INSTALL_DIR"
    git pull --quiet origin main 2>/dev/null || true
else
    echo "       Cloning repository..."
    git clone --quiet --depth 1 --filter=blob:none --sparse "$REPO_URL" "$INSTALL_DIR" 2>/dev/null
    cd "$INSTALL_DIR"
    git sparse-checkout set client_repo 2>/dev/null
fi

# Verify client_setup.sh exists
if [[ ! -f "$INSTALL_DIR/client_repo/client_setup.sh" ]]; then
    echo -e "${RED}Error: client_setup.sh not found${NC}"
    exit 1
fi

chmod +x "$INSTALL_DIR/client_repo/client_setup.sh"

# Create symlink for easy access
ln -sf "$INSTALL_DIR/client_repo/client_setup.sh" /usr/local/bin/xinas-client 2>/dev/null || true

echo -e "       ${GREEN}Client installed to $INSTALL_DIR${NC}"

# Configure NFS client for performance
echo -e "${CYAN}[4/4]${NC} Configuring NFS client..."

if [[ ! -f /etc/modprobe.d/nfsclient.conf ]]; then
    echo "options nfs max_session_slots=180" > /etc/modprobe.d/nfsclient.conf
    echo "       ${GREEN}NFS performance tuning applied${NC}"
else
    echo "       NFS already configured"
fi

# Done
echo ""
echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}    Installation complete!${NC}"
echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "    ${WHITE}To connect to your xiNAS server:${NC}"
echo ""
echo -e "    ${CYAN}sudo xinas-client${NC}"
echo ""
echo -e "    ${DIM}Or run directly:${NC}"
echo -e "    ${CYAN}sudo $INSTALL_DIR/client_repo/client_setup.sh${NC}"
echo ""
echo -e "    ${WHITE}Quick mount example:${NC}"
echo -e "    ${CYAN}sudo xinas-client --mount 10.10.1.1:/mnt/data /mnt/nas${NC}"
echo ""

# Ask to launch setup now
if [[ -t 0 ]]; then
    # Interactive terminal - ask user
    echo -e "    ${YELLOW}Launch client setup now? [Y/n]${NC} "
    read -r -n 1 answer
    echo ""
    if [[ ! "$answer" =~ ^[Nn]$ ]]; then
        exec "$INSTALL_DIR/client_repo/client_setup.sh"
    fi
else
    # Piped input - show instructions
    echo -e "    ${DIM}Run 'sudo xinas-client' to start the setup wizard${NC}"
    echo ""
fi
