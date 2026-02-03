#!/usr/bin/env bash
# Collect system data and upload via transfer.sh
# Uses colored console prompts
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/menu_lib.sh"

main() {
    local cfg email tmp archive server

    while [ $# -gt 0 ]; do
        case $1 in
            -h|--help)
                echo "Usage: $0" >&2
                return 0
                ;;
            *)
                echo "Unknown option: $1" >&2
                echo "Usage: $0" >&2
                return 1
                ;;
        esac
    done

    cfg=$(input_box "Config Name" "Enter config name for this collection:" "config") || exit 1
    email=$(input_box "Email" "Enter your email address:" "user@example.com") || exit 1
    tmp=$(mktemp -d)

    echo "Config name: $cfg" > "$tmp/info.txt"
    echo "Email: $email" >> "$tmp/info.txt"

    info_box "Collecting Data" "Gathering system information..."

    lsblk -o NAME,SIZE,TYPE,MOUNTPOINT > "$tmp/lsblk.txt"
    cat /proc/mdstat > "$tmp/mdstat.txt" 2>/dev/null || true
    pvs > "$tmp/pvs.txt" 2>&1 || true
    nvme list > "$tmp/nvme_list.txt" 2>&1 || true
    lspci > "$tmp/lspci.txt" 2>&1 || true
    [ -x ./hwkey ] || chmod +x ./hwkey
    ./hwkey > "$tmp/hwkey.txt" 2>&1 || true

    # NUMA node for each disk
    for dev in $(lsblk -ndo NAME,TYPE | awk '$2=="disk"{print $1}'); do
        node_file="/sys/block/$dev/device/numa_node"
        if [ -f "$node_file" ]; then
            echo "$dev $(cat "$node_file")" >> "$tmp/numa_nodes.txt"
        else
            echo "$dev unknown" >> "$tmp/numa_nodes.txt"
        fi
    done

    archive="/tmp/${cfg}.tgz"
    tar czf "$archive" -C "$tmp" .

    server=${TRANSFER_SERVER:-"http://178.253.23.152:8080"}

    info_box "Uploading" "Uploading data to server..."

    if ! curl --fail --upload-file "$archive" "$server/$(basename "$archive")"; then
        msg_warn "Transfer.sh upload failed"
    fi

    rm -rf "$tmp"
    msg_box "Collection Complete" "Archive created: $archive\n\nData has been collected and uploaded."
}

main "$@"
