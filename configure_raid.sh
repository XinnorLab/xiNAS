#!/usr/bin/env bash
# Interactive editor for RAID drive lists
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

vars_file="collection/roles/raid_fs/defaults/main.yml"
auto_vars_file="collection/roles/nvme_namespace/defaults/main.yml"

# Ensure required commands are present
for cmd in yq lsblk; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: required command '$cmd' not found. Please run prepare_system.sh or install it manually." >&2
        exit 1
    fi
done

# Ensure yq v4 is used rather than the older v3 release packaged by some
# distributions. When a v3 binary appears earlier in PATH it triggers errors
# such as "'//' expects 2 args but there is 1" during YAML processing.
if ! yq --version 2>/dev/null | grep -q 'version v4'; then
    echo "Error: yq version 4.x is required. Run prepare_system.sh or adjust your PATH to use /usr/local/bin/yq" >&2
    command -v yq >/dev/null 2>&1 && echo "Current yq path: $(command -v yq)" >&2
    exit 1
fi

if [ ! -f "$vars_file" ]; then
    echo "Error: $vars_file not found" >&2
    exit 1
fi

get_devices() {
    local level="$1"
    yq -r ".xiraid_arrays[] | select(.level==${level}) | .devices | join(\" \" )" "$vars_file" 2>/dev/null
}

get_spare_devices() {
    # Gracefully handle presets without a spare pool defined
    yq -r '(.xiraid_spare_pools[0].devices // []) | join(" ")' "$vars_file" 2>/dev/null
}

edit_spare_pool() {
    local current new tmp
    current="$(get_spare_devices)"
    new=$(input_box "Spare Pool" "Space-separated devices for spare pool:" "$current") || return
    tmp=$(mktemp)
    # Ensure the spare pool has a name and update its device list
    NEW_LIST="$new" yq eval '.xiraid_spare_pools |= [(.[0] // {"name":"sp1"}) | .devices = (env(NEW_LIST) | split(" "))]' "$vars_file" > "$tmp"
    backup_if_changed "$vars_file" "$tmp"
    mv "$tmp" "$vars_file"
}

# Display detected NVMe drives
show_nvme_drives() {
    local tmp
    tmp="$(mktemp)"
    {
        echo "NVMe Drives Detected"
        echo "===================="
        echo ""
        # Include model information since the vendor field is often blank for NVMe devices
        lsblk -d -o NAME,VENDOR,MODEL,SIZE 2>/dev/null \
            | awk '$1 ~ /^nvme/ {printf "/dev/%s %s %s %s\n", $1, $2, $3, $4}' || echo "No NVMe drives detected"
    } > "$tmp"
    text_box "NVMe Drives" "$tmp"
    rm -f "$tmp"
}

edit_devices() {
    local level="$1"
    local label
    case "$level" in
        6) label="DATA" ;;
        1) label="LOG" ;;
        *) label="RAID${level}" ;;
    esac
    local current new tmp
    current="$(get_devices "$level")"
    if [ -z "$current" ]; then
        msg_box "Not Defined" "No ${label} array defined"
        return
    fi
    new=$(input_box "${label} Array" "Space-separated devices for ${label}:" "$current") || return
    tmp=$(mktemp)
    NEW_LIST="$new" yq "(.xiraid_arrays[] | select(.level==${level})).devices = (env(NEW_LIST) | split(\" \") )" "$vars_file" > "$tmp"
    backup_if_changed "$vars_file" "$tmp"
    mv "$tmp" "$vars_file"
}

# Auto-detect functions
get_auto_enabled() {
    if [ -f "$auto_vars_file" ]; then
        yq -r '.nvme_auto_namespace // false' "$auto_vars_file" 2>/dev/null
    else
        echo "false"
    fi
}

detect_system_drive() {
    local root_dev boot_dev efi_dev
    root_dev=$(findmnt -no SOURCE / 2>/dev/null | head -1 | sed -E 's/p?[0-9]+$//')
    boot_dev=$(findmnt -no SOURCE /boot 2>/dev/null | head -1 | sed -E 's/p?[0-9]+$//' || true)
    efi_dev=$(lsblk -nro NAME,PARTTYPE 2>/dev/null | grep -i 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b' | awk '{print "/dev/"$1}' | sed -E 's/p?[0-9]+$//' | head -1 || true)
    echo "$root_dev $boot_dev $efi_dev" | tr ' ' '\n' | grep -E '^/dev/' | sort -u | tr '\n' ' '
}

detect_nvme_data_drives() {
    local system_drives="$1"
    for ctrl in /dev/nvme[0-9]*; do
        [[ "$ctrl" =~ ^/dev/nvme[0-9]+$ ]] || continue
        local is_system=0
        for sys in $system_drives; do
            # Check if system drive is on this controller
            [[ "$sys" == "$ctrl"* ]] && is_system=1 && break
        done
        [[ $is_system -eq 0 ]] && echo "$ctrl"
    done
}

show_auto_detection() {
    local tmp system_drives data_drives
    tmp="$(mktemp)"
    system_drives=$(detect_system_drive)
    data_drives=$(detect_nvme_data_drives "$system_drives")

    {
        echo "=== Auto-Detection Results ==="
        echo ""
        echo "System drives (PROTECTED):"
        for d in $system_drives; do
            echo "  $d"
        done
        echo ""
        echo "Data drives (will be reconfigured):"
        if [ -n "$data_drives" ]; then
            for d in $data_drives; do
                echo "  $d"
            done
        else
            echo "  (none found)"
        fi
        echo ""
        echo "Total data drives: $(echo "$data_drives" | wc -w)"
        echo ""
        echo "Auto-mode enabled: $(get_auto_enabled)"
    } > "$tmp"

    text_box "Auto-Detection Results" "$tmp"
    rm -f "$tmp"
}

toggle_auto_mode() {
    if [ ! -f "$auto_vars_file" ]; then
        msg_box "Not Found" "Auto-detection role not found.\nFile missing: $auto_vars_file"
        return
    fi
    local current new_val tmp
    current=$(get_auto_enabled)
    if [ "$current" = "true" ]; then
        new_val="false"
    else
        new_val="true"
    fi
    tmp=$(mktemp)
    yq ".nvme_auto_namespace = $new_val" "$auto_vars_file" > "$tmp"
    backup_if_changed "$auto_vars_file" "$tmp"
    mv "$tmp" "$auto_vars_file"
    msg_box "Auto Mode" "Auto-namespace mode: $new_val\n\nWhen enabled, the playbook will automatically:\n- Detect system vs data NVMe drives\n- Rebuild namespaces (500MB + remaining)\n- Create RAID 10 (log) and RAID 5 (data)"
}

show_nvme_drives
while true; do
    raid6_devices=$(get_devices 6)
    raid1_devices=$(get_devices 1)
    spare_devices=$(get_spare_devices)
    auto_enabled=$(get_auto_enabled)

    clear
    echo -e "${CYAN}RAID Configuration${NC}"
    echo -e "${DIM}Auto-mode: $auto_enabled${NC}"
    echo ""

    choice=$(menu_select "RAID Configuration" "Select option:" \
        "1" "DATA: ${raid6_devices:-none}" \
        "2" "LOG: ${raid1_devices:-none}" \
        "3" "Spare: ${spare_devices:-none}" \
        "4" "Auto-Detect Drives" \
        "5" "Toggle Auto-Mode ($auto_enabled)" \
        "6" "Back") || break

    case "$choice" in
        1) edit_devices 6 ;;
        2) edit_devices 1 ;;
        3) edit_spare_pool ;;
        4) show_auto_detection ;;
        5) toggle_auto_mode ;;
        *) break ;;
    esac
done
