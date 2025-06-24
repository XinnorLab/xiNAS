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
    NEW_LIST="$new" yq '.xiraid_spare_pools[0].devices = (env(NEW_LIST) | split(" "))' "$vars_file" > "$tmp"
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
    local current new tmp status
    current="$(get_devices "$level")"
    if [ -z "$current" ]; then
        whiptail --msgbox "No RAID${level} array defined" 8 60
        return
    fi
    set +e
    new=$(whiptail --inputbox "Space-separated devices for RAID${level}" 10 70 "$current" 3>&1 1>&2 2>&3)
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
        1 "RAID6: ${raid6_devices:-none}" \
        2 "RAID1: ${raid1_devices:-none}" \
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

