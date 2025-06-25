#!/usr/bin/env bash
# Interactive editor for RAID drive lists
set -euo pipefail

backup_if_changed() {
    local file="$1" newfile="$2" ts
    [ -f "$file" ] || return
    if ! cmp -s "$file" "$newfile"; then
        ts=$(date +%Y%m%d%H%M%S)
        cp "$file" "${file}.${ts}.bak"
    fi
}

vars_file="collection/roles/raid_fs/defaults/main.yml"

# Ensure required commands are present
for cmd in yq whiptail lsblk; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: required command '$cmd' not found. Please run prepare_system.sh or install it manually." >&2
        exit 1
    fi
done

# Ensure yq v4 is used rather than the older v3 release packaged by some
# distributions. When a v3 binary appears earlier in PATH it triggers errors
# such as "'//' expects 2 args but there is 1" during YAML processing.
if ! yq --version 2>/dev/null | grep -q 'version v4'; then
    echo "Error: yq version 4.x is required. Run prepare_system.sh or adjust your PATH to use /usr/local/bin/yq" >&2
    command -v yq >/dev/null 2>&1 && echo "Current yq path: $(command -v yq)" >&2
    exit 1
fi

if [ ! -f "$vars_file" ]; then
    echo "Error: $vars_file not found" >&2
    exit 1
fi

get_devices() {
    local level="$1"
    yq -r ".xiraid_arrays[] | select(.level==${level}) | .devices | join(\" \" )" "$vars_file" 2>/dev/null
}

get_spare_devices() {
    # Gracefully handle presets without a spare pool defined
    yq -r '(.xiraid_spare_pools[0].devices // []) | join(" ")' "$vars_file" 2>/dev/null
}

edit_spare_pool() {
    local current new tmp status
    current="$(get_spare_devices)"
    set +e
    new=$(whiptail --inputbox "Space-separated devices for spare pool" 10 70 "$current" 3>&1 1>&2 2>&3)
    status=$?
    set -e
    [ $status -ne 0 ] && return
    tmp=$(mktemp)
    # Ensure the spare pool has a name and update its device list
    NEW_LIST="$new" yq eval '.xiraid_spare_pools |= [(.[0] // {"name":"sp1"}) | .devices = (env(NEW_LIST) | split(" "))]' "$vars_file" > "$tmp"
    backup_if_changed "$vars_file" "$tmp"
    mv "$tmp" "$vars_file"
}

# Display detected NVMe drives using whiptail
show_nvme_drives() {
    local tmp
    tmp="$(mktemp)"
    # Include model information since the vendor field is often blank for NVMe devices
    lsblk -d -o NAME,VENDOR,MODEL,SIZE 2>/dev/null \
        | awk '$1 ~ /^nvme/ {printf "/dev/%s %s %s %s\n", $1, $2, $3, $4}' > "$tmp"
    if [ ! -s "$tmp" ]; then
        echo "No NVMe drives detected" > "$tmp"
    fi
    whiptail --title "NVMe Drives" --scrolltext --textbox "$tmp" 20 60
    rm -f "$tmp"
}

edit_devices() {
    local level="$1"
    local label
    case "$level" in
        6) label="DATA" ;;
        1) label="LOG" ;;
        *) label="RAID${level}" ;;
    esac
    local current new tmp status
    current="$(get_devices "$level")"
    if [ -z "$current" ]; then
        whiptail --msgbox "No ${label} array defined" 8 60
        return
    fi
    set +e
    new=$(whiptail --inputbox "Space-separated devices for ${label}" 10 70 "$current" 3>&1 1>&2 2>&3)
    status=$?
    set -e
    [ $status -ne 0 ] && return
    tmp=$(mktemp)
    NEW_LIST="$new" yq "(.xiraid_arrays[] | select(.level==${level})).devices = (env(NEW_LIST) | split(\" \") )" "$vars_file" > "$tmp"
    backup_if_changed "$vars_file" "$tmp"
    mv "$tmp" "$vars_file"
}

show_nvme_drives
while true; do
    raid6_devices=$(get_devices 6)
    raid1_devices=$(get_devices 1)
    spare_devices=$(get_spare_devices)
    set +e
    menu=$(whiptail --title "RAID Configuration" --menu "Select array to edit:" 15 70 6 \
        1 "DATA: ${raid6_devices:-none}" \
        2 "LOG: ${raid1_devices:-none}" \
        3 "Spare: ${spare_devices:-none}" \
        4 "Back" 3>&1 1>&2 2>&3)
    status=$?
    set -e
    [ $status -ne 0 ] && break
    case "$menu" in
        1) edit_devices 6 ;;
        2) edit_devices 1 ;;
        3) edit_spare_pool ;;
        *) break ;;
    esac
done

