#!/bin/bash
set -e

usage() {
    echo "Usage: $0 [-e]" >&2
    echo "  -e  Expert mode with full startup menu" >&2
}

EXPERT=0
while getopts "e" opt; do
    case $opt in
        e) EXPERT=1 ;;
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

# In expert mode allow updating the repository from GitHub
if [ "$EXPERT" -eq 1 ]; then
    if whiptail --yesno "Update xiNAS code from GitHub?" 8 60; then
        git reset --hard
        git pull origin main
    fi
fi

chmod +x startup_menu.sh simple_menu.sh

PLAYBOOK="playbooks/site.yml"

while true; do
    menu_status=0
    if [ "$EXPERT" -eq 1 ]; then
        if whiptail --yesno "Configure this system now?" 8 60; then
            ./startup_menu.sh
            menu_status=$?
        else
            menu_status=2
        fi
    else
        ./simple_menu.sh
        menu_status=$?
    fi

    if [ "$menu_status" -eq 2 ]; then
        exit 0
    fi

    # Build a short description of roles from the site.yml file
    ROLE_NAMES=$(grep -E '^\s*- role:' "$PLAYBOOK" | awk '{print $3}')
    ROLE_LIST=""
    for role in $ROLE_NAMES; do
        desc_file="collection/roles/${role}/README.md"
        if [ -f "$desc_file" ]; then
            desc=$(awk '/^#/ {next} /^\s*$/ {if(found) exit; else next} {if(found) {printf " %s", $0} else {printf "%s", $0; found=1}} END {print ""}' "$desc_file")
        else
            desc="No description available"
        fi
        ROLE_LIST="${ROLE_LIST}\n - ${role}: ${desc}"
    done

    if whiptail --yesno --scrolltext "Run Ansible playbook to configure the system?\n\nThis will execute the following roles:${ROLE_LIST}" 20 70; then
        INV_FILE=$(whiptail --inputbox "Inventory to use for Ansible" 10 70 "inventories/lab.ini" 3>&1 1>&2 2>&3)
        ansible-playbook "$PLAYBOOK" -i "$INV_FILE" -v
        chmod +x post_install_menu.sh
        ./post_install_menu.sh
        break
    fi
done
