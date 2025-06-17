#!/bin/bash
# Interactive network configuration helper for xiNAS
set -e

backup_if_changed() {
    local file="$1" newfile="$2" ts
    [ -f "$file" ] || return
    if ! cmp -s "$file" "$newfile"; then
        ts=$(date +%Y%m%d%H%M%S)
        cp "$file" "${file}.${ts}.bak"
    fi
}

# Validate IPv4 address with CIDR prefix
valid_ipv4_cidr() {
    local ip=${1%/*}
    local prefix=${1#*/}
    # Expect form a.b.c.d/prefix
    [[ "$1" == */* ]] || return 1
    [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
    IFS=. read -r o1 o2 o3 o4 <<< "$ip"
    for octet in $o1 $o2 $o3 $o4; do
        [[ $octet -ge 0 && $octet -le 255 ]] || return 1
    done
    [[ $prefix =~ ^[0-9]{1,2}$ ]] || return 1
    [[ $prefix -ge 0 && $prefix -le 32 ]] || return 1
    return 0
}

ROLE_TEMPLATE_DEFAULT="collection/roles/net_controllers/templates/netplan.yaml.j2"
# Allow override of the configuration file via environment variable
ROLE_TEMPLATE="${ROLE_TEMPLATE_OVERRIDE:-$ROLE_TEMPLATE_DEFAULT}"

# Gather available interfaces excluding loopback
readarray -t interfaces < <(ip -o link show | awk -F': ' '{print $2}' | grep -v lo)

# Maps to store current and new IP addresses
declare -A curr_ip new_ip
configs=()

for iface in "${interfaces[@]}"; do
    ip_addr=$(ip -o -4 addr show "$iface" | awk '{print $4}')
    [[ -z "$ip_addr" ]] && ip_addr="none"
    curr_ip[$iface]="$ip_addr"
    new_ip[$iface]=""
done

while true; do
    # Build menu items dynamically with current and new IPs
    menu_items=()
    for iface in "${interfaces[@]}"; do
        speed="unknown"
        if [[ -e "/sys/class/net/$iface/speed" ]]; then
            speed=$(cat "/sys/class/net/$iface/speed" 2>/dev/null || echo "unknown")
        fi
        desc="${curr_ip[$iface]}"
        [[ -n "${new_ip[$iface]}" ]] && desc+=" -> ${new_ip[$iface]}"
        desc+=" - ${speed}Mb/s"
        menu_items+=("$iface" "$desc")
    done
    # Add a blank line before the finish option for clarity
    menu_items+=("" "")
    menu_items+=("Finish" "Finish configuration")

    # Show interface selection menu
    set +e
    iface=$(whiptail --title "Select Interface" --menu "Choose interface to configure:" 20 70 10 \
        "${menu_items[@]}" 3>&1 1>&2 2>&3)
    status=$?
    set -e
    if [[ $status -ne 0 ]]; then
        # cancel pressed -> go back to previous screen
        exit 0
    fi
    if [[ "$iface" == "Finish" ]]; then
        break
    fi

    prompt="IPv4 address for $iface (current: ${curr_ip[$iface]})"
    [[ -n "${new_ip[$iface]}" ]] && prompt+=" [new: ${new_ip[$iface]}]"
    while true; do
        set +e
        addr=$(whiptail --inputbox "$prompt" 8 60 3>&1 1>&2 2>&3)
        status=$?
        set -e
        [[ $status -ne 0 ]] && continue 2
        if valid_ipv4_cidr "$addr"; then
            new_ip[$iface]="$addr"
            found=""
            for i in "${!configs[@]}"; do
                IFS=: read -r name _ <<< "${configs[i]}"
                if [[ "$name" == "$iface" ]]; then
                    configs[i]="$iface:$addr"
                    found=1
                    break
                fi
            done
            [[ -z "$found" ]] && configs+=("$iface:$addr")
            break
        else
            whiptail --msgbox "Invalid IPv4/CIDR format" 8 60
        fi
    done

done

if [[ ${#configs[@]} -eq 0 ]]; then
    configs=("ib0:100.100.100.1/24")
fi

tmp_file=$(mktemp)
cat > "$tmp_file" <<EOF2
network:
  version: 2
  renderer: networkd
  ethernets:
EOF2

for cfg in "${configs[@]}"; do
    IFS=: read -r name addr <<< "$cfg"
    cat >> "$tmp_file" <<EOF2
    $name:
      dhcp4: no
      addresses: [ $addr ]
EOF2
done

backup_if_changed "$ROLE_TEMPLATE" "$tmp_file"
mv "$tmp_file" "$ROLE_TEMPLATE"

# Prepare summary message of interface changes
summary="Updated $ROLE_TEMPLATE\n"
for iface in "${interfaces[@]}"; do
    new="${new_ip[$iface]}"
    [[ -z "$new" ]] && continue
    summary+="$iface: ${curr_ip[$iface]} -> $new\n"

done

whiptail --msgbox "$summary" 15 70
