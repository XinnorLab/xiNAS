#!/bin/bash
set -e
ROLE_TEMPLATE="collection/roles/net_controllers/templates/netplan.yaml.j2"

# list available interfaces excluding loopback
available=$(ip -o link show | awk -F': ' '{print $2}' | grep -v lo)

echo "Available interfaces:"
echo "$available"

configs=()
count=0
while [[ $count -lt 4 ]]; do
    read -rp "Interface to configure (leave empty to finish): " iface
    [[ -z "$iface" ]] && break
    if ! echo "$available" | grep -qw "$iface"; then
        echo "Interface $iface not found" >&2
        continue
    fi
    read -rp "IPv4 address for $iface (A.B.C.D/EE): " addr
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
