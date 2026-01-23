#!/bin/bash
# Interactive network configuration helper for xiNAS
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# MTU (0 = system default)
net_mtu: 0
EOF
}

# Configure IP Pool
configure_ip_pool() {
    get_pool_settings

    # Input start IP
    while true; do
        set +e
        new_start=$(whiptail --inputbox "Start IP address of the pool:\n\nFormat: X.X.X.X (e.g., 10.10.1.1)\nEach interface will get next subnet: 10.10.1.1, 10.10.2.1, ..." \
            12 60 "$pool_start" 3>&1 1>&2 2>&3)
        status=$?
        set -e
        [[ $status -ne 0 ]] && return

        if valid_ipv4 "$new_start"; then
            break
        else
            whiptail --msgbox "Invalid IP address format. Use X.X.X.X" 8 50
        fi
    done

    # Input end IP
    while true; do
        set +e
        new_end=$(whiptail --inputbox "End IP address of the pool:\n\nFormat: X.X.X.X (e.g., 10.10.255.1)" \
            10 60 "$pool_end" 3>&1 1>&2 2>&3)
        status=$?
        set -e
        [[ $status -ne 0 ]] && return

        if valid_ipv4 "$new_end"; then
            break
        else
            whiptail --msgbox "Invalid IP address format. Use X.X.X.X" 8 50
        fi
    done

    # Input prefix
    while true; do
        set +e
        new_prefix=$(whiptail --inputbox "Subnet prefix (CIDR):\n\n(e.g., 24 for /24 = 255.255.255.0)" \
            10 50 "$pool_prefix" 3>&1 1>&2 2>&3)
        status=$?
        set -e
        [[ $status -ne 0 ]] && return

        if [[ $new_prefix =~ ^[0-9]{1,2}$ ]] && [[ $new_prefix -ge 1 && $new_prefix -le 32 ]]; then
            break
        else
            whiptail --msgbox "Invalid prefix. Use 1-32." 8 40
        fi
    done

    # Save settings
    save_pool_settings "$new_start" "$new_end" "$new_prefix"

    # Show summary
    whiptail --msgbox "IP Pool configured:\n\nRange: $new_start - $new_end\nPrefix: /$new_prefix\n\nInterfaces will be auto-assigned:\n  Interface 1: ${new_start}/${new_prefix}\n  Interface 2: next subnet\n  etc.\n\nSaved to: $ROLE_DEFAULTS" 16 60
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
        menu_items+=("" "")
        menu_items+=("Finish" "Finish configuration")

        set +e
        iface=$(whiptail --title "Select Interface" --menu "Choose interface to configure:" 20 70 10 \
            "${menu_items[@]}" 3>&1 1>&2 2>&3)
        status=$?
        set -e
        [[ $status -ne 0 ]] && return
        [[ "$iface" == "Finish" ]] && break

        prompt="IPv4 address for $iface (current: ${curr_ip[$iface]})"
        [[ -n "${new_ip[$iface]}" ]] && prompt+=" [new: ${new_ip[$iface]}]"
        while true; do
            set +e
            addr=$(whiptail --inputbox "$prompt\n\nFormat: X.X.X.X/prefix (e.g., 192.168.1.1/24)" 10 60 3>&1 1>&2 2>&3)
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

    whiptail --msgbox "Manual configuration saved to:\n$ROLE_TEMPLATE\n\nNote: IP pool is DISABLED in manual mode." 12 60
}

# View current configuration
view_config() {
    get_pool_settings

    msg="=== IP Pool Settings ===\n"
    msg+="Enabled: $pool_enabled\n"
    msg+="Range: $pool_start - $pool_end\n"
    msg+="Prefix: /$pool_prefix\n\n"

    msg+="=== Detected High-Speed Interfaces ===\n"
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
            msg+="  $name: $ip_addr (driver: $driver)\n"
        fi
    done

    whiptail --msgbox "$msg" 20 70
}

# Main menu
main_menu() {
    while true; do
        get_pool_settings

        pool_status="ENABLED"
        [[ "$pool_enabled" != "true" ]] && pool_status="DISABLED"

        set +e
        choice=$(whiptail --title "Network Configuration" --menu \
            "Current IP Pool: $pool_start - $pool_end [$pool_status]\n\nSelect option:" 16 70 5 \
            "1" "Configure IP Pool (automatic allocation)" \
            "2" "Configure interfaces manually" \
            "3" "View current configuration" \
            "4" "Back to main menu" \
            3>&1 1>&2 2>&3)
        status=$?
        set -e

        [[ $status -ne 0 ]] && break

        case "$choice" in
            1) configure_ip_pool ;;
            2) configure_manual ;;
            3) view_config ;;
            4) break ;;
        esac
    done
}

main_menu
