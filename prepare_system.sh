#!/bin/bash
# Prepare system for xiNAS installation
# Uses colored console menus
set -e

usage() {
    echo "Usage: $0 [-e] [-u]" >&2
    echo "  -e  Expert mode with full startup menu" >&2
    echo "  -u  Update repository and exit" >&2
    echo "  -h  Show this help message" >&2
}

EXPERT=0
UPDATE_ONLY=0
while getopts "ehu" opt; do
    case $opt in
        e) EXPERT=1 ;;
        u) UPDATE_ONLY=1 ;;
        h) usage; exit 0 ;;
        *) usage; exit 1 ;;
    esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}xiNAS System Preparation${NC}"
echo ""

# Install required packages unless only updating the repository
if [ "$UPDATE_ONLY" -eq 0 ]; then
    echo -e "${YELLOW}Installing required packages...${NC}"
    sudo apt-get update -y
    sudo apt-get install -y ansible git dialog wget btop
    # Install yq v4 for YAML processing used by configuration scripts
    echo -e "${YELLOW}Installing yq...${NC}"
    sudo wget -qO /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64"
    sudo chmod +x /usr/local/bin/yq
    echo -e "${GREEN}Packages installed successfully${NC}"
fi

REPO_URL="https://github.com/XinnorLab/xiNAS/"
REPO_DIR="xiNAS"

# Determine if repo already exists in current directory
if [ -f "ansible.cfg" ] && [ -d "playbooks" ]; then
    REPO_DIR="$(pwd)"
else
    if [ ! -d "$REPO_DIR" ]; then
        echo -e "${YELLOW}Cloning xiNAS repository...${NC}"
        git clone "$REPO_URL" "$REPO_DIR"
    fi
    cd "$REPO_DIR"
fi

# If only updating the repository, perform the update and exit
if [ "$UPDATE_ONLY" -eq 1 ]; then
    echo -e "${YELLOW}Updating repository...${NC}"
    git reset --hard
    git pull origin main
    echo -e "${GREEN}Repository updated${NC}"
    exit 0
fi

# Ensure the hardware key utility is executable
[ -x ./hwkey ] || chmod +x ./hwkey

# Source the menu library if available
if [ -f "lib/menu_lib.sh" ]; then
    source "lib/menu_lib.sh"

    # In expert mode allow updating the repository from GitHub
    if [ "$EXPERT" -eq 1 ]; then
        if yes_no "Update Repository" "Update xiNAS code from GitHub?"; then
            git reset --hard
            git pull origin main
            msg_box "Updated" "Repository updated successfully"
        fi
    fi
else
    # Fallback to simple prompt if menu library not available
    if [ "$EXPERT" -eq 1 ]; then
        echo -e "${YELLOW}Update xiNAS code from GitHub? (y/n)${NC}"
        read -r response
        if [[ "$response" =~ ^[Yy] ]]; then
            git reset --hard
            git pull origin main
        fi
    fi
fi

chmod +x startup_menu.sh simple_menu.sh

if [ "$EXPERT" -eq 1 ]; then
    ./startup_menu.sh
    status=$?
else
    ./simple_menu.sh
    status=$?
fi

if [ "$status" -eq 2 ]; then
    exit 0
fi
