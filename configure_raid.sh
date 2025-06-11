#!/usr/bin/env bash
# Interactive editor for RAID drive lists
set -euo pipefail

vars_file="group_vars/all.yml"

# Ensure required commands are present
for cmd in yq whiptail; do
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
    mv "$tmp" "$vars_file"
}

while true; do
    raid6_devices=$(get_devices 6)
    raid1_devices=$(get_devices 1)
    menu=$(whiptail --title "RAID Configuration" --menu "Select array to edit:" 15 70 5 \
        1 "RAID6: ${raid6_devices:-none}" \
        2 "RAID1: ${raid1_devices:-none}" \
        3 "Back" 3>&1 1>&2 2>&3)
    case "$menu" in
        1) edit_devices 6 ;;
        2) edit_devices 1 ;;
        *) break ;;
    esac
done

