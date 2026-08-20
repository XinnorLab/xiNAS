#!/usr/bin/env bash
# Interactive editor for NFS export clients and options
# Uses colored console menus
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/menu_lib.sh"
source "$SCRIPT_DIR/lib/xinas_config.sh"

backup_if_changed() {
    local file="$1" newfile="$2" ts
    # `return 0`, not a bare `return`: a bare `return` would surface `[ -f ]`'s
    # own failed-test status (1) to the caller, and every call site here runs
    # this as a plain simple command under `set -eu`, so that 1 would abort
    # the script. See docs/Installer/spec.md 2.8. Both callers in this file
    # seed $vars_file via xinas_config_seed_local first, which always creates
    # the overlay file - so this branch isn't reachable today - but the fix
    # belongs on the shared helper, not on trusting every future caller to
    # remember that precondition.
    [ -f "$file" ] || return 0
    if ! cmp -s "$file" "$newfile"; then
        ts=$(date +%Y%m%d%H%M%S)
        cp "$file" "${file}.${ts}.bak"
    fi
}

# All configuration writes land in the overlay; role defaults are read-only.
vars_file="$XINAS_LOCAL_LAYER"

edit_export() {
    local path="$1"
    local clients options tmp
    clients=$(xinas_config_effective | yq -r ".exports[] | select(.path==\"$path\") | .clients" -)
    options=$(xinas_config_effective | yq -r ".exports[] | select(.path==\"$path\") | .options" -)

    clients=$(input_box "Edit Export" "Clients for $path:\n\nExamples:\n  *           = everyone\n  192.168.1.0/24 = specific network\n  hostname    = specific host" "$clients") || return 0

    options=$(input_box "Edit Export" "Options for $path:\n\nCommon options:\n  rw,sync,no_subtree_check,no_root_squash" "$options") || return 0

    xinas_config_seed_local exports
    tmp=$(mktemp)
    yq e "(.exports[] | select(.path == \"$path\") | .clients) = \"${clients}\" | (.exports[] | select(.path == \"$path\") | .options) = \"${options}\"" "$vars_file" > "$tmp"
    backup_if_changed "$vars_file" "$tmp"
    mv "$tmp" "$vars_file"

    msg_box "Export Updated" "Export updated:\n\nPath: $path\nClients: $clients\nOptions: $options"
}

add_export() {
    local path clients options tmp

    path=$(input_box "Add Export" "Export path:\n\nExample: /mnt/data/shared") || return 0
    [ -z "$path" ] && return

    clients=$(input_box "Add Export" "Clients for $path:\n\nExamples:\n  *           = everyone\n  192.168.1.0/24 = specific network" "*") || return 0

    options=$(input_box "Add Export" "Options for $path:\n\nDefault: rw,sync,no_root_squash" "rw,sync,no_root_squash,no_subtree_check") || return 0

    xinas_config_seed_local exports
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
    mapfile -t paths < <(xinas_config_effective | yq -r '.exports[].path' -)
    menu_items=()
    for p in "${paths[@]}"; do
        clients=$(xinas_config_effective | yq -r ".exports[] | select(.path==\"$p\") | .clients" -)
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
