#!/bin/bash
set -e

usage() {
    echo "Usage: $0 [-e]" >&2
    echo "  -e  Expert mode with full startup menu" >&2
    echo "  -h  Show this help message" >&2
}

EXPERT=0
while getopts "eh" opt; do
    case $opt in
        e) EXPERT=1 ;;
        h) usage; exit 0 ;;
        *) usage; exit 1 ;;
    esac
done
# Install required packages
sudo apt-get update -y
sudo apt-get install -y ansible git whiptail dialog wget
# Install yq v4 for YAML processing used by configuration scripts
sudo wget -qO /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64"
sudo chmod +x /usr/local/bin/yq

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

# Ensure the hardware key utility is executable
[ -x ./hwkey ] || chmod +x ./hwkey

# In expert mode allow updating the repository from GitHub
if [ "$EXPERT" -eq 1 ]; then
    if whiptail --yesno "Update xiNAS code from GitHub?" 8 60; then
        git reset --hard
        git pull origin main
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
