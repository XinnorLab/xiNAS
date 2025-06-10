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
    hwkey_val=$(./hwkey 2>/dev/null | tr -d '\n')

    # Show HWKEY to the user
    whiptail --title "Hardware Key" --msgbox "HWKEY: ${hwkey_val}" 10 60

    if [ -f "$license_file" ]; then
        if whiptail --yesno "License already exists. Replace it?" 10 60; then
            rm -f "$license_file"
        else
            return
        fi
    fi

    cat <<EOF > "$TMP_DIR/license_example"
hwkey: ${hwkey_val}
license_key: 863D8988D68A814F8E83D52626A6F864450CE388DBFEBB2B10DE217836149C2941734A3E4BB86DAD4F1E66CB9A06F977CFF944D0B5A2398DBF05B4E9AAE65D43ACD10748C4F40A310720C87E74BEEDD9FB3B38A68675CEDF1467386A3F5290B4EBF2AFB326C5D7EB6D62D69DA8CD3B5CCCF6315450E66434813D99A644D80D7B
version: 1
crypto_version: 1
created: 2025-06-09
expired: 2026-06-01
disks: 128
levels: 70
type: nvme
EOF

    whiptail --title "License Format" --textbox "$TMP_DIR/license_example" 20 70

    whiptail --title "Enter License" --inputbox "Paste license string:" 20 70 2>"$TMP_DIR/license" || return
    cat "$TMP_DIR/license" > "$license_file"
}

# Run network configuration script and show output
configure_network() {
    local log="$TMP_DIR/network.log"
    whiptail --infobox "Running network configuration..." 8 60
    if ./configure_network.sh >"$log" 2>&1; then
        whiptail --title "Configure Network" --textbox "$log" 20 70
    else
        whiptail --title "Configure Network" --textbox "$log" 20 70
        whiptail --msgbox "Network configuration failed" 8 60
    fi
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
        3 "Show Playbook Info" \
        4 "Run Ansible Playbook" \
        5 "Exit" \
        3>&1 1>&2 2>&3)
    case "$choice" in
        1) enter_license ;;
        2) configure_network ;;
        3) show_playbook_info ;;
        4) run_playbook && exit 0 || exit 1 ;;
        5) exit 0 ;;
    esac
done

