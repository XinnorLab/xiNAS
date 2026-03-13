#!/bin/bash
# Interactive network configuration helper for xiNAS
# Uses colored console menus
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/menu_lib.sh"

ROLE_DEFAULTS="$SCRIPT_DIR/collection/roles/net_controllers/defaults/main.yml"
ROLE_TEMPLATE="$SCRIPT_DIR/collection/roles/net_controllers/templates/netplan.yaml.j2"

# Check for yq
if ! command -v yq &>/dev/null; then
    echo "Error: yq is required. Install with: sudo snap install yq" >&2
    exit 1
fi

backup_if_changed() {
    local file="$1" newfile="$2" ts
    [ -f "$file" ] || return
    if ! cmp -s "$file" "$newfile"; then
        ts=$(date +%Y%m%d%H%M%S)
        cp "$file" "${file}.${ts}.bak"
    fi
}

# Validate IPv4 address (without CIDR)
valid_ipv4() {
    local ip="$1"
    [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
    IFS=. read -r o1 o2 o3 o4 <<< "$ip"
    for octet in $o1 $o2 $o3 $o4; do
        [[ $octet -ge 0 && $octet -le 255 ]] || return 1
    done
    return 0
}

# Validate IPv4 address with CIDR prefix
valid_ipv4_cidr() {
    local ip=${1%/*}
    local prefix=${1#*/}
    [[ "$1" == */* ]] || return 1
    valid_ipv4 "$ip" || return 1
    [[ $prefix =~ ^[0-9]{1,2}$ ]] || return 1
    [[ $prefix -ge 0 && $prefix -le 32 ]] || return 1
    return 0
}

# Get current IP pool settings
get_pool_settings() {
    if [[ -f "$ROLE_DEFAULTS" ]]; then
        pool_enabled=$(yq '.net_ip_pool_enabled // true' "$ROLE_DEFAULTS")
        pool_start=$(yq '.net_ip_pool_start // "10.10.1.1"' "$ROLE_DEFAULTS")
        pool_end=$(yq '.net_ip_pool_end // "10.10.255.1"' "$ROLE_DEFAULTS")
        pool_prefix=$(yq '.net_ip_pool_prefix // 24' "$ROLE_DEFAULTS")
    else
        pool_enabled=true
        pool_start="10.10.1.1"
        pool_end="10.10.255.1"
        pool_prefix=24
    fi
}

# Save IP pool settings
save_pool_settings() {
    local start="$1" end="$2" prefix="$3"

    cat > "$ROLE_DEFAULTS" <<EOF
---
# Automatic IP pool allocation
net_ip_pool_enabled: true
net_ip_pool_start: "$start"
net_ip_pool_end: "$end"
net_ip_pool_prefix: $prefix

# Interface detection
net_detect_infiniband: true
net_detect_mlx5: true

# Manual IP overrides
net_manual_ips: {}

# MTU (0 = auto-detect: 4092 for InfiniBand, 9000 for RoCE/Ethernet)
net_mtu: 0
EOF
}

# Configure IP Pool
configure_ip_pool() {
    get_pool_settings

    # Input start IP
    while true; do
        new_start=$(input_box "IP Pool - Start Address" "Start IP address of the pool:\n\nFormat: X.X.X.X (e.g., 10.10.1.1)\nEach interface will get next subnet: 10.10.1.1, 10.10.2.1, ..." "$pool_start") || return

        if valid_ipv4 "$new_start"; then
            break
        else
            msg_box "Invalid IP" "Invalid IP address format. Use X.X.X.X"
        fi
    done

    # Input end IP
    while true; do
        new_end=$(input_box "IP Pool - End Address" "End IP address of the pool:\n\nFormat: X.X.X.X (e.g., 10.10.255.1)" "$pool_end") || return

        if valid_ipv4 "$new_end"; then
            break
        else
            msg_box "Invalid IP" "Invalid IP address format. Use X.X.X.X"
        fi
    done

    # Input prefix
    while true; do
        new_prefix=$(input_box "IP Pool - Prefix" "Subnet prefix (CIDR):\n\n(e.g., 24 for /24 = 255.255.255.0)" "$pool_prefix") || return

        if [[ $new_prefix =~ ^[0-9]{1,2}$ ]] && [[ $new_prefix -ge 1 && $new_prefix -le 32 ]]; then
            break
        else
            msg_box "Invalid Prefix" "Invalid prefix. Use 1-32."
        fi
    done

    # Validate pool capacity: check third-octet range won't overflow
    IFS=. read -r s1 s2 s3 s4 <<< "$new_start"
    IFS=. read -r e1 e2 e3 e4 <<< "$new_end"
    local pool_slots=$(( e3 - s3 + 1 ))
    [[ $pool_slots -le 0 ]] && pool_slots=1

    # Count detected high-speed interfaces
    local iface_count=0
    for iface_path in /sys/class/net/*; do
        [ -d "$iface_path" ] || continue
        local iname
        iname=$(basename "$iface_path")
        [ "$iname" = "lo" ] && continue
        [ -e "$iface_path/device" ] || continue
        local itype idriver
        itype=$(cat "$iface_path/type" 2>/dev/null || echo "0")
        idriver=$(basename "$(readlink -f "$iface_path/device/driver" 2>/dev/null)" 2>/dev/null || echo "")
        if [ "$itype" = "32" ] || [ "$idriver" = "mlx5_core" ]; then
            ((iface_count++)) || true
        fi
    done

    # Warn if pool can't accommodate all interfaces
    if [[ $iface_count -gt 0 && $iface_count -gt $pool_slots ]]; then
        msg_box "WARNING: Pool Too Small" "Detected $iface_count high-speed interfaces but\npool only has $pool_slots subnet slots\n(third octet: $s3 to $e3).\n\nInterfaces beyond slot $pool_slots will get\ninvalid IPs. Expand the pool range or use\nmanual IP configuration."
    fi

    # Warn if start octet + interface count would overflow 255
    if [[ $iface_count -gt 0 ]] && [[ $(( s3 + iface_count - 1 )) -gt 255 ]]; then
        msg_box "WARNING: IP Overflow" "Starting at third octet $s3 with $iface_count\ninterfaces would produce IPs with\nthird octet > 255 (invalid).\n\nUse a lower start address or fewer interfaces."
    fi

    # Save settings
    save_pool_settings "$new_start" "$new_end" "$new_prefix"

    # Build summary with capacity info
    local capacity_note=""
    if [[ $iface_count -gt 0 ]]; then
        capacity_note="\n\nDetected interfaces: $iface_count\nPool capacity: $pool_slots subnets"
    fi
    msg_box "IP Pool Configured" "IP Pool configured:\n\nRange: $new_start - $new_end\nPrefix: /$new_prefix\n\nInterfaces will be auto-assigned:\n  Interface 1: ${new_start}/${new_prefix}\n  Interface 2: next subnet\n  etc.${capacity_note}\n\nSaved to: $ROLE_DEFAULTS"
}

# Configure interfaces manually (legacy mode)
configure_manual() {
    # Disable pool mode
    if [[ -f "$ROLE_DEFAULTS" ]]; then
        yq -i '.net_ip_pool_enabled = false' "$ROLE_DEFAULTS"
    fi

    # Gather available interfaces excluding loopback
    readarray -t interfaces < <(ip -o link show | awk -F': ' '{print $2}' | grep -v lo)

    declare -A curr_ip new_ip
    configs=()

    for iface in "${interfaces[@]}"; do
        ip_addr=$(ip -o -4 addr show "$iface" | awk '{print $4}')
        [[ -z "$ip_addr" ]] && ip_addr="none"
        curr_ip[$iface]="$ip_addr"
        new_ip[$iface]=""
    done

    while true; do
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
        menu_items+=("Finish" "Finish configuration")

        clear
        echo -e "${CYAN}Manual Network Configuration${NC}"
        echo ""

        iface=$(menu_select "Select Interface" "Choose interface to configure:" "${menu_items[@]}") || return
        [[ "$iface" == "Finish" ]] && break

        prompt="IPv4 address for $iface (current: ${curr_ip[$iface]})"
        [[ -n "${new_ip[$iface]}" ]] && prompt+=" [new: ${new_ip[$iface]}]"

        while true; do
            addr=$(input_box "Configure $iface" "$prompt\n\nFormat: X.X.X.X/prefix (e.g., 192.168.1.1/24)") || break

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
                msg_box "Invalid Format" "Invalid IPv4/CIDR format"
            fi
        done
    done

    if [[ ${#configs[@]} -eq 0 ]]; then
        configs=("ib0:100.100.100.1/24")
    fi

    tmp_file=$(mktemp)
    cat > "$tmp_file" <<EOF
network:
  version: 2
  renderer: networkd
  ethernets:
EOF

    for cfg in "${configs[@]}"; do
        IFS=: read -r name addr <<< "$cfg"
        cat >> "$tmp_file" <<EOF
    $name:
      dhcp4: no
      addresses: [ $addr ]
EOF
    done

    backup_if_changed "$ROLE_TEMPLATE" "$tmp_file"
    mv "$tmp_file" "$ROLE_TEMPLATE"

    msg_box "Manual Config Saved" "Manual configuration saved to:\n$ROLE_TEMPLATE\n\nNote: IP pool is DISABLED in manual mode."
}

# View current configuration
view_config() {
    get_pool_settings

    local tmp="$TMP_DIR/net_config"
    TMP_DIR="${TMP_DIR:-/tmp}"
    mkdir -p "$TMP_DIR"
    tmp="$TMP_DIR/net_config_$$"

    {
        echo "=== IP Pool Settings ==="
        echo "Enabled: $pool_enabled"
        echo "Range: $pool_start - $pool_end"
        echo "Prefix: /$pool_prefix"
        echo ""
        echo "=== Detected High-Speed Interfaces ==="

        for iface in /sys/class/net/*; do
            [ -d "$iface" ] || continue
            name=$(basename "$iface")
            [ "$name" = "lo" ] && continue
            [ -e "$iface/device" ] || continue

            type=$(cat "$iface/type" 2>/dev/null || echo "0")
            driver=$(basename "$(readlink -f "$iface/device/driver" 2>/dev/null)" 2>/dev/null || echo "")

            if [ "$type" = "32" ] || [ "$driver" = "mlx5_core" ]; then
                ip_addr=$(ip -o -4 addr show "$name" 2>/dev/null | awk '{print $4}')
                [[ -z "$ip_addr" ]] && ip_addr="no IP"
                echo "  $name: $ip_addr (driver: $driver)"
            fi
        done
    } > "$tmp"

    text_box "Network Configuration" "$tmp"
    rm -f "$tmp"
}

# Main menu
main_menu() {
    while true; do
        get_pool_settings

        pool_status="ENABLED"
        [[ "$pool_enabled" != "true" ]] && pool_status="DISABLED"

        clear
        echo -e "${CYAN}Network Configuration${NC}"
        echo -e "${DIM}Current IP Pool: $pool_start - $pool_end [$pool_status]${NC}"
        echo ""

        choice=$(menu_select "Network Configuration" "Select option:" \
            "1" "Configure IP Pool (automatic allocation)" \
            "2" "Configure interfaces manually" \
            "3" "View current configuration" \
            "4" "Back to main menu") || break

        case "$choice" in
            1) configure_ip_pool ;;
            2) configure_manual ;;
            3) view_config ;;
            4) break ;;
        esac
    done
}

main_menu
