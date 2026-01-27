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

    ██╗  ██╗██╗███╗   ██╗ █████╗ ███████╗
    ╚██╗██╔╝██║████╗  ██║██╔══██╗██╔════╝
     ╚███╔╝ ██║██╔██╗ ██║███████║███████╗
     ██╔██╗ ██║██║╚██╗██║██╔══██║╚════██║
    ██╔╝ ██╗██║██║ ╚████║██║  ██║███████║
    ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝
EOF
echo -e "${NC}"
echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}     High-Performance NAS Provisioning${NC}"
echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Quick Start Guide
CYAN='\033[0;36m'
WHITE='\033[1;37m'
DIM='\033[2m'

echo -e "${WHITE}    ┌─────────────────────────────────────────────────────────────┐${NC}"
echo -e "${WHITE}    │${NC}  ${CYAN}✨ Welcome to xiNAS - Let's get you started!${NC}               ${WHITE}│${NC}"
echo -e "${WHITE}    └─────────────────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "    ${WHITE}QUICK START GUIDE${NC}"
echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
echo ""
echo -e "    ${GREEN}①${NC}  ${WHITE}📊 Collect System Data${NC}"
echo -e "        ${DIM}Use the menu to gather hardware info for licensing${NC}"
echo ""
echo -e "    ${YELLOW}②${NC}  ${WHITE}🔑 Obtain & Enter License${NC} ${RED}★ Required${NC}"
echo -e "        ${DIM}Contact${NC} ${CYAN}XINNOR Support Team${NC} ${DIM}to get your license${NC}"
echo -e "        ${DIM}Enter it in the setup menu when prompted${NC}"
echo ""
echo -e "    ${GREEN}③${NC}  ${WHITE}🌐 Configure Network${NC} ${DIM}(Optional)${NC}"
echo -e "        ${DIM}Set IP ranges and interfaces for your storage network${NC}"
echo -e "        ${DIM}Skip to use automatic detection${NC}"
echo ""
echo -e "    ${GREEN}④${NC}  ${WHITE}🚀 Run Installation${NC}"
echo -e "        ${DIM}Select your preset and let the magic happen!${NC}"
echo ""
echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
echo -e "    ${DIM}💬 Need help?${NC} ${CYAN}support@xinnor.io${NC}"
echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
echo ""

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

# Show system status
echo -e "${BLUE}System Status:${NC}"
echo ""
xinas-status 2>/dev/null || echo "Run 'xinas-status' after deployment to see system status."
