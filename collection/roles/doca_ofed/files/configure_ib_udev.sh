#!/bin/bash
set -euo pipefail

CONFIG_FILE="${1:-/opt/xiNAS/collection/roles/net_controllers/templates/netplan.yaml.j2}"
RULES_FILE="${2:-/etc/udev/rules.d/70-ib-names.rules}"

# Renaming is opt-in: it only happens when the netplan config pins literal ibN
# names. A pool-allocated config keeps the kernel's predictable names, so every
# "noop:" below is a legitimate outcome, not a failure. They are printed so the
# caller can tell "did nothing" apart from "renamed something".
if [ ! -f "$CONFIG_FILE" ]; then
    echo "noop: config file not found: $CONFIG_FILE" >&2
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

if [ "$num_names" -eq 0 ]; then
    echo "noop: no literal ibN names in $CONFIG_FILE; keeping predictable names"
    exit 0
fi

if [ "$num_ifaces" -eq 0 ]; then
    echo "noop: no InfiniBand interfaces present"
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

if cmp -s "$tmp" "$RULES_FILE"; then
    rm -f "$tmp"
    echo "unchanged: $max rule(s) already current in $RULES_FILE"
    exit 0
fi

install -m 0644 "$tmp" "$RULES_FILE"
rm -f "$tmp"

udevadm control --reload
echo "changed: wrote $max rule(s) to $RULES_FILE"
