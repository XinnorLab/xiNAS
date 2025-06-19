#!/usr/bin/env bash
# Post installation information and management menu for xiNAS
set -euo pipefail

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Directory with Ansible repository
REPO_DIR="/opt/provision"
DEFAULT_GIT_URL="https://github.com/XinnorLab/xiNAS"

show_raid_info() {
    local out="$TMP_DIR/raid_info"
    local raw="$TMP_DIR/raid_raw"
    if xicli raid show -f json >"$raw" 2>&1; then
        if python3 - "$raw" <<'EOF' >"$out" 2>/dev/null; then
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
arrays = []
if isinstance(data, list):
    arrays = data
elif isinstance(data, dict):
    for key in ("raid_groups", "arrays", "groups"):
        if isinstance(data.get(key), list):
            arrays = data[key]
            break
    if not arrays:
        arrays = [dict(v, name=k) if isinstance(v, dict) else {"name": k}
                  for k, v in data.items()]
print("{:<15} {:>12} {:>10} {:<20} {:>5} {:>7}".format(
    'Name', 'Size', 'Strip', 'Status', 'Lvl', 'Devs'))
for arr in arrays:
    name = arr.get('name', '')
    size = arr.get('size', '')
    strip = (arr.get('strip_size') or arr.get('strip_size_kb') or '')
    status = arr.get('state') or arr.get('status') or ''
    if isinstance(status, list):
        status = ' '.join(status)
    level = arr.get('level', '')
    num = len(arr.get('devices', []))
    print("{:<15} {:>12} {:>10} {:<20} {:>5} {:>7}".format(
        name, size, strip, status, level, num))
EOF
            :
        else
            python3 -m json.tool "$raw" >"$out" 2>/dev/null || cat "$raw" >"$out"
        fi
        {
            echo
            echo "Spare Pools:"
            if ! xicli pool show; then
                echo "Failed to run xicli pool show"
            fi
        } >>"$out"
    else
        echo "Failed to run xicli raid show" >"$out"
    fi
    whiptail --title "RAID Groups" --scrolltext --textbox "$out" 20 70
}

show_license_info() {
    local out="$TMP_DIR/license_info"
    if ! xicli license show >"$out" 2>&1; then
        echo "Failed to run xicli license show" >"$out"
    fi
    whiptail --title "xiRAID License" --textbox "$out" 20 70
}

show_nfs_info() {
    local out="$TMP_DIR/nfs_info"
    {
        echo "NFS exports from /etc/exports:";
        if [ -f /etc/exports ]; then
            cat /etc/exports
            echo
            awk '{print $1}' /etc/exports | while read -r p; do
                [ -z "$p" ] && continue
                df -hT "$p" 2>/dev/null || true
                echo
            done
        else
            echo "/etc/exports not found"
        fi
    } >"$out"
    whiptail --title "Filesystem & NFS" --textbox "$out" 20 70
}

manage_network() {
    local out="$TMP_DIR/net_info"
    ip -o -4 addr show | awk '{print $2, $4}' >"$out"
    whiptail --title "Network Interfaces" --textbox "$out" 20 70
    if whiptail --yesno "Modify network configuration?" 8 60; then
        ROLE_TEMPLATE_OVERRIDE=/etc/netplan/99-xinas.yaml ./configure_network.sh
        netplan apply
    fi
}

is_custom_repo() {
    [ -d "$REPO_DIR/.git" ] || return 1
    local url
    url=$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || echo "")
    if [ -z "$url" ] && [ -f "$REPO_DIR/repo.url" ]; then
        url=$(cat "$REPO_DIR/repo.url")
    fi
    local def="${DEFAULT_GIT_URL%/}"
    case "$url" in
        "$def"|"$def.git"|*"XinnorLab/xiNAS"*) return 1 ;;
    esac
    return 0
}

has_repo_changes() {
    [ -d "$REPO_DIR/.git" ] || return 1
    git -C "$REPO_DIR" status --porcelain | grep -q .
}

store_config_repo() {
    local msg out
    msg=$(whiptail --inputbox "Commit message" 8 60 "Save configuration" 3>&1 1>&2 2>&3) || return 0
    git -C "$REPO_DIR" add -A
    if out=$(git -C "$REPO_DIR" commit -m "$msg" 2>&1); then
        if git -C "$REPO_DIR" push >/dev/null 2>&1; then
            whiptail --msgbox "Configuration saved to repository" 8 60
        else
            whiptail --msgbox "Failed to push changes" 8 60
        fi
    else
        whiptail --msgbox "Git commit failed:\n${out}" 15 70
    fi
}

while true; do
    menu_items=(
        1 "RAID Groups information"
        2 "xiRAID license information"
        3 "File system and NFS share information"
        4 "Network post install settings"
    )
    save_opt=5
    if is_custom_repo && has_repo_changes; then
        menu_items+=("$save_opt" "Store configuration to Git repository")
        exit_opt=$((save_opt + 1))
    else
        exit_opt=$save_opt
    fi
    menu_items+=("$exit_opt" "Exit")

    choice=$(whiptail --title "Post Install Menu" --menu "Select an option:" 20 70 10 "${menu_items[@]}" 3>&1 1>&2 2>&3)
    case "$choice" in
        1) show_raid_info ;;
        2) show_license_info ;;
        3) show_nfs_info ;;
        4) manage_network ;;
        "$save_opt")
            if is_custom_repo && has_repo_changes; then
                store_config_repo
            else
                break
            fi
            ;;
        *) break ;;
    esac
done
