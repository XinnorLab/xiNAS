#!/bin/bash
set -e
ROLE_TEMPLATE="collection/roles/net_controllers/templates/netplan.yaml.j2"

# list available interfaces excluding loopback
available=$(ip -o link show | awk -F': ' '{print $2}' | grep -v lo)

echo "Available interfaces (current IPv4, speed):"
for iface in $available; do
    ip_addr=$(ip -o -4 addr show "$iface" | awk '{print $4}')
    [[ -z "$ip_addr" ]] && ip_addr="none"
    speed="unknown"
    if [[ -e "/sys/class/net/$iface/speed" ]]; then
        speed=$(cat "/sys/class/net/$iface/speed" 2>/dev/null || echo "unknown")
    fi
    echo "  $iface - $ip_addr - ${speed}Mb/s"
done

configs=()
count=0
printed_table_header=0
while [[ $count -lt 4 ]]; do
    read -rp "Interface to configure (leave empty to finish): " iface
    [[ -z "$iface" ]] && break
    if ! echo "$available" | grep -qw "$iface"; then
        echo "Interface $iface not found" >&2
        continue
    fi
    read -rp "IPv4 address for $iface (A.B.C.D/EE): " addr
    current_ip=$(ip -o -4 addr show "$iface" | awk '{print $4}')
    [[ -z "$current_ip" ]] && current_ip="none"

    if [[ $printed_table_header -eq 0 ]]; then
        printf '\n%-10s %-18s %-18s\n' "Interface" "Current IP" "New IP"
        printed_table_header=1
    fi
    printf '%-10s %-18s %-18s\n' "$iface" "$current_ip" "$addr"

    configs+=("$iface:$addr")
    count=$((count+1))
done

if [[ ${#configs[@]} -eq 0 ]]; then
    configs=("ib0:100.100.100.1/24")
fi

cat > "$ROLE_TEMPLATE" <<EOF2
network:
  version: 2
  renderer: networkd
  ethernets:
EOF2

for cfg in "${configs[@]}"; do
    IFS=: read name addr <<< "$cfg"
    cat >> "$ROLE_TEMPLATE" <<EOF2
    $name:
      dhcp4: no
      addresses: [ $addr ]
EOF2
done

echo "Updated $ROLE_TEMPLATE"
