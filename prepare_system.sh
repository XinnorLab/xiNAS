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

# Ask for license and store it
echo "Please paste your license. Finish input with Ctrl-D on a new line:"
cat > /tmp/license

# Show tasks to be performed
cat <<'TASKS'
The script will perform the following tasks:
1. Install ansible and git.
2. Clone the xiNAS repository.
3. Update the repository from origin main.
4. Store the provided license in /tmp/license.
5. Run ansible-playbook playbooks/site.yml -v.
TASKS

# Run ansible playbook
ansible-playbook playbooks/site.yml -v
