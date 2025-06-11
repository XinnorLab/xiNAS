#!/bin/bash
set -e
# Install required packages
sudo apt-get update -y
sudo apt-get install -y ansible git whiptail dialog

REPO_URL="https://github.com/XinnorLab/xiNAS/"
REPO_DIR="xiNAS"

# Determine if repo already exists in current directory
if [ -f "ansible.cfg" ] && [ -d "playbooks" ]; then
    REPO_DIR="$(pwd)"
else
    if [ ! -d "$REPO_DIR" ]; then
        git clone "$REPO_URL" "$REPO_DIR"
    fi
    cd "$REPO_DIR"
fi

# Pull latest changes
git pull origin main

# Show hardware key required for license for reference
echo "HWKEY:"
chmod +x ./hwkey
./hwkey

# Ask whether to run interactive configuration menu
if whiptail --yesno "Configure this system now?" 8 60; then
    chmod +x startup_menu.sh
    ./startup_menu.sh
fi
