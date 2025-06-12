#!/usr/bin/env bash
# Interactive editor for NFS export clients and options
set -euo pipefail

backup_if_changed() {
    local file="$1" newfile="$2" ts
    [ -f "$file" ] || return
    if ! cmp -s "$file" "$newfile"; then
        ts=$(date +%Y%m%d%H%M%S)
        cp "$file" "${file}.${ts}.bak"
    fi
}

vars_file="group_vars/all.yml"

if [ ! -f "$vars_file" ]; then
    echo "Error: $vars_file not found" >&2
    exit 1
fi

edit_export() {
    local path="$1"
    local clients options status tmp
    clients=$(yq -r ".exports[] | select(.path==\"$path\") | .clients" "$vars_file")
    options=$(yq -r ".exports[] | select(.path==\"$path\") | .options" "$vars_file")
    set +e
    clients=$(whiptail --inputbox "Clients for $path" 8 60 "$clients" 3>&1 1>&2 2>&3)
    status=$?
    set -e
    [ $status -ne 0 ] && return
    set +e
    options=$(whiptail --inputbox "Options for $path" 8 60 "$options" 3>&1 1>&2 2>&3)
    status=$?
    set -e
    [ $status -ne 0 ] && return
    tmp=$(mktemp)
    yq ".exports[] | select(.path == \"$path\") |= (.clients = \"${clients}\" | .options = \"${options}\")" "$vars_file" > "$tmp"
    backup_if_changed "$vars_file" "$tmp"
    mv "$tmp" "$vars_file"
}

add_export() {
    local path clients options status tmp
    set +e
    path=$(whiptail --inputbox "Export path" 8 60 3>&1 1>&2 2>&3)
    status=$?
    set -e
    [ $status -ne 0 ] && return
    [ -z "$path" ] && return
    set +e
    clients=$(whiptail --inputbox "Clients for $path" 8 60 "*" 3>&1 1>&2 2>&3)
    status=$?
    set -e
    [ $status -ne 0 ] && return
    set +e
    options=$(whiptail --inputbox "Options for $path" 8 60 "rw,sync" 3>&1 1>&2 2>&3)
    status=$?
    set -e
    [ $status -ne 0 ] && return
    tmp=$(mktemp)
    yq ".exports += [{\"path\": \"${path}\", \"clients\": \"${clients}\", \"options\": \"${options}\"}]" "$vars_file" > "$tmp"
    backup_if_changed "$vars_file" "$tmp"
    mv "$tmp" "$vars_file"
}

# Allow non-interactive calls for editing or adding a single export
if [ "${1:-}" = "--edit" ] && [ -n "${2:-}" ]; then
    edit_export "$2"
    exit 0
elif [ "${1:-}" = "--add" ]; then
    add_export
    exit 0
fi

while true; do
    mapfile -t paths < <(yq -r '.exports[].path' "$vars_file")
    menu_items=()
    for p in "${paths[@]}"; do
        clients=$(yq -r ".exports[] | select(.path==\"$p\") | .clients" "$vars_file")
        menu_items+=("$p" "clients: $clients")
    done
    menu_items+=("Add" "Add new export")
    menu_items+=("Back" "Return to main menu")
    set +e
    choice=$(whiptail --title "NFS Exports" --menu "Select export to edit:" 20 70 10 "${menu_items[@]}" 3>&1 1>&2 2>&3)
    status=$?
    set -e
    if [ $status -ne 0 ] || [ "$choice" = "Back" ]; then
        break
    fi
    if [ "$choice" = "Add" ]; then
        add_export
    else
        edit_export "$choice"
    fi
done
