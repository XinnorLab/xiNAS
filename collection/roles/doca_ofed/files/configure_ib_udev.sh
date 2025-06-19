#!/bin/bash
set -euo pipefail

CONFIG_FILE="${1:-/opt/provision/collection/roles/net_controllers/templates/netplan.yaml.j2}"
RULES_FILE="${2:-/etc/udev/rules.d/70-ib-names.rules}"

if [ ! -f "$CONFIG_FILE" ]; then
    exit 0
fi

mapfile -t names < <(grep -oE '^[[:space:]]*(ib[0-9]+):' "$CONFIG_FILE" | sed -E 's/^[[:space:]]*(ib[0-9]+):/\1/')

ib_ifaces=()
for path in /sys/class/net/*; do
    [ -f "$path/type" ] || continue
    if [ "$(cat "$path/type")" = "32" ]; then
        ib_ifaces+=( "$(basename "$path")" )
    fi
done

num_names=${#names[@]}
num_ifaces=${#ib_ifaces[@]}

if [ "$num_names" -eq 0 ] || [ "$num_ifaces" -eq 0 ]; then
    exit 0
fi

if [ "$num_names" -le "$num_ifaces" ]; then
    max="$num_names"
else
    max="$num_ifaces"
fi

tmp=$(mktemp)
for ((i=0; i<max; i++)); do
    iface="${ib_ifaces[$i]}"
    name="${names[$i]}"
    addr=$(cat "/sys/class/net/$iface/address")
    echo "SUBSYSTEM==\"net\", ACTION==\"add\", ATTR{address}==\"$addr\", NAME=\"$name\"" >> "$tmp"
done

install -m 0644 "$tmp" "$RULES_FILE"
rm -f "$tmp"

udevadm control --reload
