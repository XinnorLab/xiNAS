#!/usr/bin/env bash
# Post installation information and management menu for xiNAS
set -euo pipefail

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

show_raid_info() {
    local out="$TMP_DIR/raid_info"
    if ! xicli raid show >"$out" 2>&1; then
        echo "Failed to run xicli raid show" >"$out"
    fi
    whiptail --title "RAID Groups" --textbox "$out" 20 70
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

while true; do
    choice=$(whiptail --title "Post Install Menu" --menu "Select an option:" 20 70 10 \
        1 "RAID Groups information" \
        2 "xiRAID license information" \
        3 "File system and NFS share information" \
        4 "Network post install settings" \
        5 "Exit" 3>&1 1>&2 2>&3)
    case "$choice" in
        1) show_raid_info ;;
        2) show_license_info ;;
        3) show_nfs_info ;;
        4) manage_network ;;
        *) break ;;
    esac
done
