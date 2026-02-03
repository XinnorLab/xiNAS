#!/usr/bin/env bash
# Configure NFS client for RDMA or TCP transport according to xiNNOR blog post
# Uses colored console menus
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/menu_lib.sh"

if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}This script must be run as root${NC}" >&2
    exit 1
fi

run_playbook() {
    local pb="$1" log
    log=$(mktemp)

    if ! command -v ansible-playbook >/dev/null 2>&1; then
        if command -v apt-get >/dev/null 2>&1; then
            apt-get update -y
            apt-get install -y ansible
        elif command -v yum >/dev/null 2>&1; then
            yum install -y ansible
        else
            msg_box "Error" "Ansible not found and automatic installation is unsupported."
            return 1
        fi
    fi

    info_box "Ansible" "Running $pb"
    if ansible-playbook "$pb" -i inventories/lab.ini >"$log" 2>&1; then
        text_box "Ansible Output" "$log"
        msg_box "Success" "Playbook succeeded"
    else
        text_box "Ansible Output" "$log"
        msg_box "Failed" "Playbook failed"
        rm -f "$log"
        return 1
    fi
    rm -f "$log"
}

main() {
    if yes_no "Install DOCA OFED" "Install DOCA OFED using Ansible playbook?"; then
        run_playbook playbooks/doca_ofed_install.yml
    fi

    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -y
        apt-get install -y nfs-common
    elif command -v yum >/dev/null 2>&1; then
        yum install -y nfs-utils
    fi

    echo "options nfs max_session_slots=180" > /etc/modprobe.d/nfsclient.conf

    while true; do
        # Select protocol
        proto=$(menu_select "Select Protocol" "Choose NFS protocol:" \
            "RDMA" "High performance RDMA transport" \
            "TCP" "Standard TCP transport") || proto="RDMA"
        proto=${proto^^}

        server_ip=$(input_box "Server IP" "Server IP address:" "10.239.239.100") || continue
        server_ips=("$server_ip")

        while yes_no "Add IP" "Add another server IP address?"; do
            ip=$(input_box "Additional IP" "Additional server IP address:") || break
            [[ -n "$ip" ]] && server_ips+=("$ip")
        done

        share=$(input_box "NFS Share" "NFS share path:" "/") || continue
        mount_point=$(input_box "Mount Point" "Local mount point:" "/mnt/nfs") || continue

        mkdir -p "$mount_point"
        if [[ "$proto" == "RDMA" ]]; then
            opts="rdma,port=20049,nconnect=16,vers=4.2,sync"
        else
            opts="nconnect=16,vers=4.2,sync"
        fi

        server_spec="$server_ip"
        if [[ ${#server_ips[@]} -gt 1 ]]; then
            server_spec=$(IFS=,; echo "${server_ips[*]}")
        fi

        if ! mountpoint -q "$mount_point"; then
            if ! mount -t nfs -o "$opts" "$server_spec:$share" "$mount_point"; then
                msg_box "Mount Failed" "Failed to mount $server_ip:$share"
                continue
            fi
        fi

        mount_opts=$(awk -v mp="$mount_point" '$2==mp {print $4}' /proc/mounts)
        mount_opts=${mount_opts:-$opts}

        if ! grep -q "^$server_spec:$share" /etc/fstab; then
            echo "$server_spec:$share $mount_point nfs $mount_opts 0 0" >> /etc/fstab
        fi

        msg_box "Complete" "Configuration complete.\n\nReboot recommended to apply module options."
        break
    done
}

main "$@"
