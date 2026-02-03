#!/usr/bin/env bash
# Interactive helper to configure system hostname for xiNAS
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

valid_hostname() {
    local name="$1"
    [[ $name =~ ^[A-Za-z0-9][-A-Za-z0-9]{0,62}$ ]]
}

# Update /etc/hosts with provided hostname using 127.0.0.1 entry
update_hosts_file() {
    local host="$1" hosts_file="/etc/hosts" tmp
    [ -w "$hosts_file" ] || return
    tmp=$(mktemp)
    if grep -q '^127\.0\.0\.1' "$hosts_file"; then
        # Preserve localhost alias while updating the hostname
        sed "s/^127\.0\.0\.1\s*.*/127.0.0.1\t$host localhost/" "$hosts_file" > "$tmp"
    else
        cat "$hosts_file" > "$tmp"
        echo -e "127.0.0.1\t$host localhost" >> "$tmp"
    fi
    backup_if_changed "$hosts_file" "$tmp"
    mv "$tmp" "$hosts_file"
}

vars_file="collection/roles/common/defaults/main.yml"

for cmd in yq; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: required command '$cmd' not found. Please run prepare_system.sh or install it manually." >&2
        exit 1
    fi
done

if [ ! -f "$vars_file" ]; then
    echo "Error: $vars_file not found" >&2
    exit 1
fi

current=$(yq -r '.xinas_hostname // ""' "$vars_file")
[ -x ./hwkey ] || chmod +x ./hwkey
if [ -z "$current" ]; then
    hw=$(./hwkey 2>/dev/null | tr -d '\n' | tr '[:lower:]' '[:upper:]')
    current="xiNAS-$hw"
fi

while true; do
    name=$(input_box "Set Hostname" "Enter the hostname for this system:\n\nFormat: letters, numbers, and hyphens\nMust start with a letter or number" "$current") || exit 0

    if valid_hostname "$name"; then
        break
    else
        msg_box "Invalid Hostname" "Invalid hostname format.\n\nHostname must:\n- Start with a letter or number\n- Contain only letters, numbers, and hyphens\n- Be 1-63 characters long"
        current="$name"
    fi
done

tmp=$(mktemp)
NAME="$name" yq e '.xinas_hostname = env(NAME)' "$vars_file" > "$tmp"
backup_if_changed "$vars_file" "$tmp"
mv "$tmp" "$vars_file"

update_hosts_file "$name"

msg_box "Hostname Set" "Hostname set to: $name"
