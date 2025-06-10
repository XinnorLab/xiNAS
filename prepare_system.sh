#!/bin/bash
set -e
# Install required packages
sudo apt-get update -y
sudo apt-get install -y ansible git

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

# Show hardware key required for license
echo "HWKEY:"
chmod +x ./hwkey
./hwkey

# Ask for license and store it
if [ -f /tmp/license ]; then
    echo "Using existing license from /tmp/license"
else
    echo "Please paste your license. Finish input with Ctrl-D on a new line:"
    cat > /tmp/license
fi

# Configure network interfaces via startup script
./configure_network.sh

# Show tasks to be performed by Ansible
echo "The following Ansible tasks will be executed:"
ansible-playbook playbooks/site.yml --list-tasks
read -rp "Continue with these tasks? [y/N] " confirm
if [[ ! $confirm =~ ^[Yy]$ ]]; then
    echo "Aborting." >&2
    exit 1
fi


# Run ansible playbook
ansible-playbook playbooks/site.yml -v
