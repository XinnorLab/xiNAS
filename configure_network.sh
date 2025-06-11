#!/bin/bash
# Interactive network configuration helper for xiNAS
set -e

ROLE_TEMPLATE="collection/roles/net_controllers/templates/netplan.yaml.j2"

# Build list of available interfaces excluding loopback
available=$(ip -o link show | awk -F': ' '{print $2}' | grep -v lo)

# Prepare menu options: iface "ip - speed"
menu_items=()
for iface in $available; do
    ip_addr=$(ip -o -4 addr show "$iface" | awk '{print $4}')
    [[ -z "$ip_addr" ]] && ip_addr="none"
    speed="unknown"
    if [[ -e "/sys/class/net/$iface/speed" ]]; then
        speed=$(cat "/sys/class/net/$iface/speed" 2>/dev/null || echo "unknown")
    fi
    menu_items+=("$iface" "$ip_addr - ${speed}Mb/s")
done

configs=()
while [[ ${#configs[@]} -lt 4 && ${#menu_items[@]} -gt 0 ]]; do
    iface=$(whiptail --title "Select Interface" --menu \
        "Choose interface to configure:" 20 70 10 \
        "cancel" "Finish" \
        "${menu_items[@]}" 3>&1 1>&2 2>&3)
    [ $? -ne 0 ] && break
    if [[ "$iface" == "cancel" ]]; then
        break
    fi
    addr=$(whiptail --inputbox "IPv4 address for $iface (A.B.C.D/EE)" \
        8 60 3>&1 1>&2 2>&3)
    [ $? -ne 0 ] && continue
    configs+=("$iface:$addr")

    # remove chosen interface from menu_items to avoid duplicates
    new_items=()
    for ((i=0;i<${#menu_items[@]};i+=2)); do
        if [[ "${menu_items[i]}" != "$iface" ]]; then
            new_items+=("${menu_items[i]}" "${menu_items[i+1]}")
        fi
    done
    menu_items=("${new_items[@]}")
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
    IFS=: read -r name addr <<< "$cfg"
    cat >> "$ROLE_TEMPLATE" <<EOF2
    $name:
      dhcp4: no
      addresses: [ $addr ]
EOF2
done

whiptail --msgbox "Updated $ROLE_TEMPLATE" 8 60
