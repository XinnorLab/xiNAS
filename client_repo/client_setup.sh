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

# Present a choice between RDMA and TCP protocols using a menu when possible
select_protocol() {
    local default="${1:-RDMA}" choice status
    if [ -n "$WHIPTAIL" ]; then
        set +e
        choice=$(whiptail --title "Select Protocol" --menu "Choose NFS protocol:" 15 60 2 \
            RDMA "" \
            TCP "" 3>&1 1>&2 2>&3)
        status=$?
        set -e
        if [ $status -ne 0 ]; then
            choice="$default"
        fi
    else
        PS3="Select protocol [1-2]: "
        select choice in RDMA TCP; do
            [ -n "$choice" ] && break
        done
    fi
    echo "${choice:-$default}"
}

# Present a choice for NFS security mode
select_security() {
    local default="${1:-sys}" choice status
    if [ -n "$WHIPTAIL" ]; then
        set +e
        choice=$(whiptail --title "Select Security" --menu "Choose NFS security mode:" 15 60 4 \
            sys "AUTH_SYS" \
            krb5 "Kerberos" \
            krb5i "Kerberos+Integrity" \
            krb5p "Kerberos+Privacy" 3>&1 1>&2 2>&3)
        status=$?
        set -e
        if [ $status -ne 0 ]; then
            choice="$default"
        fi
    else
        PS3="Select security mode [1-4]: "
        select choice in sys krb5 krb5i krb5p; do
            [ -n "$choice" ] && break
        done
    fi
    echo "${choice:-$default}"
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

    proto=$(select_protocol "RDMA")
    proto=${proto^^}
    server_ip=$(ask_input "Server IP address" "10.239.239.100")
    share=$(ask_input "NFS share" "/mnt/data")
    mount_point=$(ask_input "Local mount point" "/mnt/nfs")
    sec_mode=$(select_security "sys")

    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -y
        apt-get install -y nfs-common
    elif command -v yum >/dev/null 2>&1; then
        yum install -y nfs-utils
    fi

    echo "options nfs max_session_slots=180" > /etc/modprobe.d/nfsclient.conf

    mkdir -p "$mount_point"
    if [[ "$proto" == "RDMA" ]]; then
        opts="rdma,port=20049,nconnect=16,vers=4.2,sync,sec=$sec_mode"
    else
        opts="nconnect=16,vers=4.2,sync,sec=$sec_mode"
    fi
    if ! mountpoint -q "$mount_point"; then
        mount -t nfs -o "$opts" "$server_ip:$share" "$mount_point" || \
            echo "Warning: failed to mount $server_ip:$share" >&2
    fi

    if mountpoint -q "$mount_point"; then
        mount_opts=$(awk -v mp="$mount_point" '$2==mp {print $4}' /proc/mounts)
    fi
    mount_opts=${mount_opts:-$opts}

    if ! grep -q "^$server_ip:$share" /etc/fstab; then
        echo "$server_ip:$share $mount_point nfs $mount_opts 0 0" >> /etc/fstab
    fi

    echo "Configuration complete. Reboot recommended to apply module options." >&2
}

main "$@"
