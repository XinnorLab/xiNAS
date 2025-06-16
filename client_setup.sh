#!/usr/bin/env bash
# Configure NFS client for RDMA or TCP transport according to xiNNOR blog post
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "This script must be run as root" >&2
    exit 1
fi

WHIPTAIL=$(command -v whiptail || true)

ask_yes_no() {
    local prompt="$1"
    if [ -n "$WHIPTAIL" ]; then
        whiptail --yesno "$prompt" 10 60
        return $?
    else
        read -rp "$prompt [y/N]: " ans
        [[ "$ans" =~ ^[Yy]$ ]]
        return
    fi
}

ask_input() {
    local prompt="$1" default="$2" result
    if [ -n "$WHIPTAIL" ]; then
        result=$(whiptail --inputbox "$prompt" 8 60 "$default" 3>&1 1>&2 2>&3) || return 1
    else
        read -rp "$prompt [$default]: " result
        result=${result:-$default}
    fi
    echo "$result"
}

run_playbook() {
    local pb="$1" log
    log=$(mktemp)
    if [ -n "$WHIPTAIL" ]; then
        whiptail --title "Ansible" --infobox "Running $pb" 8 60
    fi
    if ansible-playbook "$pb" -i inventories/lab.ini >"$log" 2>&1; then
        [ -n "$WHIPTAIL" ] && whiptail --textbox "$log" 20 70 && whiptail --msgbox "Playbook succeeded" 8 60 || cat "$log"
    else
        [ -n "$WHIPTAIL" ] && whiptail --textbox "$log" 20 70 && whiptail --msgbox "Playbook failed" 8 60 || cat "$log"
        return 1
    fi
    rm -f "$log"
}

main() {
    if ask_yes_no "Install DOCA OFED using Ansible playbook?"; then
        run_playbook playbooks/doca_ofed_install.yml
    fi

    proto=$(ask_input "Protocol to use (RDMA or TCP)" "RDMA")
    proto=${proto^^}
    server_ip=$(ask_input "Server IP address" "10.239.239.100")
    share=$(ask_input "NFS share" "/mnt/data")
    mount_point=$(ask_input "Local mount point" "/mnt/nfs")

    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -y
        apt-get install -y nfs-common
    elif command -v yum >/dev/null 2>&1; then
        yum install -y nfs-utils
    fi

    echo "options nfs max_session_slots=180" > /etc/modprobe.d/nfsclient.conf

    mkdir -p "$mount_point"
    if [[ "$proto" == "RDMA" ]]; then
        opts="rdma,port=20049,nconnect=16,vers=4.2,sync"
    else
        opts="nconnect=16,vers=4.2,sync"
    fi
    if ! mountpoint -q "$mount_point"; then
        mount -t nfs -o "$opts" "$server_ip:$share" "$mount_point" || \
            echo "Warning: failed to mount $server_ip:$share" >&2
    fi

    if ! grep -q "^$server_ip:$share" /etc/fstab; then
        echo "$server_ip:$share $mount_point nfs $opts 0 0" >> /etc/fstab
    fi

    echo "Configuration complete. Reboot recommended to apply module options." >&2
}

main "$@"
