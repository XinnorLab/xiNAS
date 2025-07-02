#!/usr/bin/env bash
# Collect system data and upload to SharePoint
set -euo pipefail

WHIPTAIL=$(command -v whiptail || true)

ask_input() {
    local prompt="$1" default="$2" result
    if [ -n "$WHIPTAIL" ]; then
        result=$(whiptail --inputbox "$prompt" 8 60 "$default" 3>&1 1>&2 2>&3) || return 1
        echo "$result"
    else
        read -rp "$prompt [$default]: " result
        echo "${result:-$default}"
    fi
}

main() {
    local cfg email tmp archive dest_arg dest

    dest_arg=${RCLONE_DEST:-}
    while [ $# -gt 0 ]; do
        case $1 in
            --dest)
                [ $# -gt 1 ] || { echo "Missing argument for --dest" >&2; return 1; }
                dest_arg=$2
                shift 2
                continue
                ;;
            -h|--help)
                echo "Usage: $0 [--dest remote:path]" >&2
                return 0
                ;;
            *)
                echo "Unknown option: $1" >&2
                echo "Usage: $0 [--dest remote:path]" >&2
                return 1
                ;;
        esac
    done

    cfg=$(ask_input "Enter config name" "config") || exit 1
    email=$(ask_input "Enter your email" "user@example.com") || exit 1
    tmp=$(mktemp -d)

    echo "Config name: $cfg" > "$tmp/info.txt"
    echo "Email: $email" >> "$tmp/info.txt"

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

    archive="${cfg}.tgz"
    tar czf "$archive" -C "$tmp" .

    # Install rclone if not present
    if ! command -v rclone >/dev/null 2>&1; then
        if command -v apt-get >/dev/null 2>&1; then
            apt-get update -y
            apt-get install -y rclone
        elif command -v yum >/dev/null 2>&1; then
            yum install -y rclone
        else
            curl https://rclone.org/install.sh | bash
        fi
    fi

    dest=${dest_arg:-$(ask_input "rclone destination (remote:path)" "sharepoint:")}
    [ -n "$dest" ] || exit 1
    remote_name=${dest%%:*}:
    if ! rclone listremotes | grep -qx "$remote_name"; then
        echo "rclone remote $remote_name not found. Launching rclone config..." >&2
        rclone config
    fi

    if ! rclone copy "$archive" "$dest"; then
        echo "Warning: rclone upload failed" >&2
    fi

    rm -rf "$tmp"
    echo "Archive created: $archive"
}

main "$@"
