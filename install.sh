#!/bin/bash
# xiNAS Installation Script
# Usage: curl -fsSL https://yourwebsite.com/xiNAS_install.sh | bash
#    or: wget -qO- https://yourwebsite.com/xiNAS_install.sh | bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
cat << 'EOF'
          _ _   _    _    ____
         (_) \ | |  / \  / ___|
         | |  \| | / _ \ \___ \
         | | |\  |/ ___ \ ___) |
         |_|_| \_/_/   \_\____/

    High-Performance NAS Provisioning
EOF
echo -e "${NC}"

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}Error: This script must be run as root${NC}"
   echo "Please run: sudo bash -c \"\$(curl -fsSL URL)\""
   exit 1
fi

# Check Ubuntu version
if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    if [[ "$ID" != "ubuntu" ]]; then
        echo -e "${YELLOW}Warning: xiNAS is designed for Ubuntu. Detected: $ID${NC}"
        read -p "Continue anyway? [y/N] " -n 1 -r
        echo
        [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
    fi
    echo -e "${GREEN}Detected: $PRETTY_NAME${NC}"
else
    echo -e "${YELLOW}Warning: Could not detect OS version${NC}"
fi

# Installation directory
INSTALL_DIR="/opt/xiNAS"
REPO_URL="https://github.com/XinnorLab/xiNAS.git"

echo -e "${BLUE}Installing xiNAS to ${INSTALL_DIR}...${NC}"

# Install git if not present
if ! command -v git &> /dev/null; then
    echo -e "${YELLOW}Installing git...${NC}"
    apt-get update -qq
    apt-get install -y git
fi

# Clone or update repository
if [[ -d "$INSTALL_DIR" ]]; then
    echo -e "${YELLOW}Existing installation found. Updating...${NC}"
    cd "$INSTALL_DIR"
    git fetch origin
    git reset --hard origin/main
else
    echo -e "${GREEN}Cloning xiNAS repository...${NC}"
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Make scripts executable
chmod +x *.sh 2>/dev/null || true

# Run prepare_system.sh to install dependencies
echo -e "${BLUE}Running system preparation...${NC}"
./prepare_system.sh

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  xiNAS installation complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "Installation directory: ${BLUE}${INSTALL_DIR}${NC}"
echo ""
echo -e "To start the menu:"
echo -e "  ${YELLOW}cd ${INSTALL_DIR} && ./startup_menu.sh${NC}"
echo ""
echo -e "Or run directly:"
echo -e "  ${YELLOW}${INSTALL_DIR}/startup_menu.sh${NC}"
echo ""

# Ask to launch menu
read -p "Launch xiNAS menu now? [Y/n] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    exec ./startup_menu.sh
fi
