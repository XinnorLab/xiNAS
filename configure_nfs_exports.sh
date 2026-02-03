#!/usr/bin/env bash
# Interactive editor for NFS export clients and options
# Uses colored console menus
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/menu_lib.sh"

backup_if_changed() {
    local file="$1" newfile="$2" ts
    [ -f "$file" ] || return
    if ! cmp -s "$file" "$newfile"; then
        ts=$(date +%Y%m%d%H%M%S)
        cp "$file" "${file}.${ts}.bak"
    fi
}

vars_file="collection/roles/exports/defaults/main.yml"

if [ ! -f "$vars_file" ]; then
    echo "Error: $vars_file not found" >&2
    exit 1
fi

edit_export() {
    local path="$1"
    local clients options tmp
    clients=$(yq -r ".exports[] | select(.path==\"$path\") | .clients" "$vars_file")
    options=$(yq -r ".exports[] | select(.path==\"$path\") | .options" "$vars_file")

    clients=$(input_box "Edit Export" "Clients for $path:\n\nExamples:\n  *           = everyone\n  192.168.1.0/24 = specific network\n  hostname    = specific host" "$clients") || return

    options=$(input_box "Edit Export" "Options for $path:\n\nCommon options:\n  rw,sync,no_subtree_check,no_root_squash" "$options") || return

    tmp=$(mktemp)
    yq e "(.exports[] | select(.path == \"$path\") | .clients) = \"${clients}\" | (.exports[] | select(.path == \"$path\") | .options) = \"${options}\"" "$vars_file" > "$tmp"
    backup_if_changed "$vars_file" "$tmp"
    mv "$tmp" "$vars_file"

    msg_box "Export Updated" "Export updated:\n\nPath: $path\nClients: $clients\nOptions: $options"
}

add_export() {
    local path clients options tmp

    path=$(input_box "Add Export" "Export path:\n\nExample: /mnt/data/shared") || return
    [ -z "$path" ] && return

    clients=$(input_box "Add Export" "Clients for $path:\n\nExamples:\n  *           = everyone\n  192.168.1.0/24 = specific network" "*") || return

    options=$(input_box "Add Export" "Options for $path:\n\nDefault: rw,sync" "rw,sync") || return

    tmp=$(mktemp)
    yq ".exports += [{\"path\": \"${path}\", \"clients\": \"${clients}\", \"options\": \"${options}\"}]" "$vars_file" > "$tmp"
    backup_if_changed "$vars_file" "$tmp"
    mv "$tmp" "$vars_file"

    msg_box "Export Added" "New export added:\n\nPath: $path\nClients: $clients\nOptions: $options"
}

# Allow non-interactive calls for editing a single export
if [ "${1:-}" = "--edit" ] && [ -n "${2:-}" ]; then
    edit_export "$2"
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

    clear
    echo -e "${CYAN}NFS Exports Configuration${NC}"
    echo ""

    choice=$(menu_select "NFS Exports" "Select export to edit:" "${menu_items[@]}") || break

    case "$choice" in
        Back) break ;;
        Add) add_export ;;
        *) edit_export "$choice" ;;
    esac
done
