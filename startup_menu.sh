#!/usr/bin/env bash
# Interactive provisioning menu for xiNAS
# POSIX-compliant startup menu script using whiptail
# Exits on errors and cleans up temporary files
# Requires: whiptail (usually provided by the 'whiptail' package)

set -euo pipefail
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Prompt user for license string and store it in /tmp/license
# Show license prompt and save to /tmp/license
enter_license() {
    local license_file="/tmp/license"
    [ -x ./hwkey ] || chmod +x ./hwkey
    local hwkey_val
    hwkey_val=$(./hwkey 2>/dev/null | tr -d '\n' | tr '[:lower:]' '[:upper:]')

    # Show HWKEY to the user
    whiptail --title "Hardware Key" --msgbox "HWKEY: ${hwkey_val}\nRequest your license key from xiNNOR Support." 10 60

    if [ -f "$license_file" ]; then
        if whiptail --yesno "License already exists. Replace it?" 10 60; then
            local ts
            ts=$(date +%Y%m%d%H%M%S)
            cp "$license_file" "${license_file}.${ts}.bak"
            rm -f "$license_file"
        else
            return 0
        fi
    fi

    : > "$TMP_DIR/license_tmp"
    if command -v dialog >/dev/null 2>&1; then
        if dialog --title "Enter License" --editbox "$TMP_DIR/license_tmp" 20 70 2>"$TMP_DIR/license"; then
            :
        else
            return 0
        fi
    else
        whiptail --title "Enter License" --msgbox "Paste license in the terminal. End with Ctrl-D." 10 60
        cat >>"$TMP_DIR/license"
    fi
    cat "$TMP_DIR/license" > "$license_file"
}

# Edit network configuration for Ansible netplan role
configure_network() {
    local template="collection/roles/net_controllers/templates/netplan.yaml.j2"
    if [ ! -f "$template" ]; then
        whiptail --msgbox "File $template not found" 8 60
        return
    fi

    local edit_tmp="$TMP_DIR/netplan_edit"
    cp "$template" "$edit_tmp"

    if command -v dialog >/dev/null 2>&1; then
        if dialog --title "Edit netplan template" --editbox "$edit_tmp" 20 70 2>"$TMP_DIR/netplan_new"; then
            cat "$TMP_DIR/netplan_new" > "$template"
        else
            return 0
        fi
    else
        whiptail --title "Edit netplan" --msgbox "Modify $template in the terminal. End with Ctrl-D." 10 60
        cat "$template" > "$TMP_DIR/netplan_new"
        cat >> "$TMP_DIR/netplan_new"
        cat "$TMP_DIR/netplan_new" > "$template"
    fi

    whiptail --title "Ansible Netplan" --textbox "$template" 20 70
}

# Display playbook information from /opt/provision/README.md
show_playbook_info() {
    local info_file="/opt/provision/README.md"
    if [ -f "$info_file" ]; then
        whiptail --title "Playbook Info" --textbox "$info_file" 20 70
    else
        whiptail --msgbox "File $info_file not found" 8 60
    fi
}

# Show NFS share configuration based on exports role defaults
configure_nfs_shares() {
    local vars_file="collection/roles/exports/defaults/main.yml"
    if [ ! -f "$vars_file" ]; then
        whiptail --msgbox "File $vars_file not found" 8 60
        return
    fi
    local share_start
    share_start=$(grep -n '^exports:' "$vars_file" | cut -d: -f1)
    local tmp="$TMP_DIR/nfs_info"
    sed -n "$((share_start+1)),$((share_start+3))p" "$vars_file" > "$tmp"
    whiptail --title "NFS Share" --textbox "$tmp" 12 70

    local default_path
    default_path=$(awk '/^exports:/ {flag=1; next} flag && /- path:/ {print $3; exit}' "$vars_file")

    while true; do
        local choice
        choice=$(whiptail --title "NFS Share" --menu "Choose an action:" 15 70 4 \
            1 "Edit default share" \
            2 "Back" 3>&1 1>&2 2>&3)
        case "$choice" in
            1) ./configure_nfs_exports.sh --edit "$default_path" ;;
            *) break ;;
        esac
    done
}

# Edit NFS export clients and options interactively
edit_nfs_exports() {
    ./configure_nfs_exports.sh
}

# Configure RAID devices interactively
configure_raid() {
    ./configure_raid.sh
}

# Run ansible-playbook and stream output
run_playbook() {
    local log="$TMP_DIR/playbook.log"
    touch "$log"
    whiptail --title "Ansible Playbook" --tailbox "$log" 20 70 &
    local box_pid=$!
    if ansible-playbook /opt/provision/site.yml >"$log" 2>&1; then
        result=0
    else
        result=$?
    fi
    kill "$box_pid" 2>/dev/null || true
    wait "$box_pid" 2>/dev/null || true
    if [ $result -eq 0 ]; then
        whiptail --msgbox "Playbook completed successfully" 8 60
    else
        whiptail --msgbox "Playbook failed. Check log: $log" 10 60
    fi
    return $result
}

# Main menu loop
while true; do
    choice=$(whiptail --title "xiNAS Setup" --nocancel --menu "Choose an action:" 20 70 10 \
        1 "Enter License" \
        2 "Configure Network" \
        3 "Configure RAID" \
        4 "Edit NFS Exports" \
        5 "Continue" \
        3>&1 1>&2 2>&3)
    case "$choice" in
        1) enter_license ;;
        2) configure_network ;;
        3) configure_raid ;;
        4) edit_nfs_exports ;;
        5) exit 0 ;;
    esac
done

