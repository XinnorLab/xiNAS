#!/usr/bin/env bash
# Simplified startup menu for xiNAS
# Uses colored console menus instead of whiptail
set -euo pipefail
TMP_DIR="$(mktemp -d)"
REPO_DIR="$(pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Source the menu library
source "$SCRIPT_DIR/lib/menu_lib.sh"

# Update check
UPDATE_AVAILABLE=""

check_for_updates() {
    local git_dir="$REPO_DIR/.git"
    [[ -d "$git_dir" ]] || return 0
    command -v git &>/dev/null || return 0
    timeout 2 bash -c "echo >/dev/tcp/github.com/443" 2>/dev/null || return 0
    local local_commit
    local_commit=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null) || return 0
    git -C "$REPO_DIR" fetch --quiet origin main 2>/dev/null || return 0
    local remote_commit
    remote_commit=$(git -C "$REPO_DIR" rev-parse origin/main 2>/dev/null) || return 0
    if [[ "$local_commit" != "$remote_commit" ]]; then
        UPDATE_AVAILABLE="true"
    fi
}

do_update() {
    if ! command -v git &>/dev/null; then
        msg_box "Error" "Git is not installed."
        return 1
    fi
    info_box "Updating..." "Pulling latest changes..."
    if git -C "$REPO_DIR" pull origin main 2>"$TMP_DIR/update.log"; then
        UPDATE_AVAILABLE=""
        msg_box "Updated" "xiNAS updated!\n\nRestart the menu to use new version."
    else
        msg_box "Failed" "Update failed:\n\n$(cat "$TMP_DIR/update.log")"
    fi
}

check_for_updates &

# Show branded header
show_header() {
    clear
    echo -e "${BLUE}"
    cat << 'EOF'

    ██╗  ██╗██╗███╗   ██╗ █████╗ ███████╗
    ╚██╗██╔╝██║████╗  ██║██╔══██╗██╔════╝
     ╚███╔╝ ██║██╔██╗ ██║███████║███████╗
     ██╔██╗ ██║██║╚██╗██║██╔══██║╚════██║
    ██╔╝ ██╗██║██║ ╚████║██║  ██║███████║
    ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝
EOF
    echo -e "${NC}"
    echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}     High-Performance NAS Setup${NC}"
    echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

check_license() {
    local license_file="/tmp/license"
    if [ ! -f "$license_file" ]; then
        msg_box "License Required" "License file $license_file not found.\nPlease run 'Enter License' first."
        return 1
    fi
    return 0
}

# Display package status using dpkg-query with a trailing newline
pkg_status() {
    local pkg="$1"
    dpkg-query -W -f='${Status}\n' "$pkg" 2>/dev/null || true
}

enter_license() {
    local license_file="/tmp/license"
    [ -x ./hwkey ] || chmod +x ./hwkey
    local hwkey_val
    local replace=0

    local ts=""
    if [ -f "$license_file" ]; then
        if yes_no "License Exists" "License already exists. Replace it?"; then
            replace=1
            ts=$(date +%Y%m%d%H%M%S)
        else
            return 0
        fi
    fi

    hwkey_val=$(./hwkey 2>/dev/null | tr -d '\n' | tr '[:lower:]' '[:upper:]')
    msg_box "Hardware Key" "HWKEY: ${hwkey_val}\n\nRequest your license key from xiNNOR Support."

    if ! text_area "Enter License" "Paste your license key below:" "$TMP_DIR/license"; then
        return 0
    fi
    if [ $replace -eq 1 ]; then
        cp "$license_file" "${license_file}.${ts}.bak"
    fi
    cat "$TMP_DIR/license" > "$license_file"
}

run_playbook() {
    local playbook="${1:-$REPO_DIR/playbooks/site.yml}"
    local inventory="${2:-inventories/lab.ini}"
    ansible-playbook "$playbook" -i "$inventory" -v
    return $?
}

# Check for installed xiRAID packages and optionally remove them
check_remove_xiraid() {
    local pkgs found repo_status log=/tmp/xiraid_remove.log
    pkgs=$(dpkg-query -W -f='${Package} ${Status}\n' 'xiraid*' 2>/dev/null | \
        awk '$4=="installed"{print $1}')
    repo_status=$(pkg_status xiraid-repo)
    [ -n "$repo_status" ] && echo "xiraid-repo: $repo_status"
    rm -f "$log"
    if [ -z "$pkgs" ]; then
        sudo apt-get autoremove -y -qq --allow-change-held-packages >"$log" 2>&1 || true
        if [ -s "$log" ]; then
            msg_box "Cleanup" "Obsolete packages removed"
            rm -f "$log"
        fi
        return 0
    fi

    found=$(echo "$pkgs" | tr '\n' ' ')
    if ! yes_no "xiRAID Packages" "Found installed xiRAID packages:\n${found}\n\nRemove them before running Ansible?"; then
        return 1
    fi

    if sudo apt-get purge -y -qq --allow-change-held-packages $pkgs >"$log" 2>&1 \
        && sudo apt-get autoremove -y -qq --allow-change-held-packages >>"$log" 2>&1 \
        && sudo rm -rf /etc/xiraid >>"$log" 2>&1; then
        msg="xiRAID packages removed successfully"
    else
        msg="Errors occurred during removal. See $log for details"
    fi
    msg_box "Removal Complete" "$msg"
    rm -f "$log"
    return 0
}

# Detection-only: populate $TMP_DIR/arrays.txt with parsed array info
# Returns 0 if arrays found, 1 if none (or xicli unavailable)
detect_xiraid_arrays() {
    command -v xicli &>/dev/null || return 1

    local json_out
    json_out=$(xicli raid show -f json 2>/dev/null) || return 1

    local arrays_file="$TMP_DIR/arrays.txt"
    local py_script
    py_script=$(cat << 'PYEOF2'
import json, sys

try:
    data = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)

# Handle multiple JSON shapes:
#   list of array dicts:       [{"name": "data", ...}, ...]
#   "arrays" or "data" key:    {"arrays": [...]}
#   dict keyed by array name:  {"data": {...}, "log": {...}}
if isinstance(data, list):
    arrays = data
elif "arrays" in data:
    arrays = data["arrays"]
else:
    # Dict keyed by array name — check if values look like array objects
    vals = [v for v in data.values() if isinstance(v, dict) and ("level" in v or "devices" in v)]
    arrays = vals if vals else []
if not arrays:
    sys.exit(1)

for a in arrays:
    name = a.get("name", "unknown")
    level = a.get("level", a.get("raid_level", "?"))
    raw_devs = a.get("devices", a.get("disks", []))
    strip = a.get("strip_size", a.get("strip_size_kb", "?"))
    state = a.get("state", a.get("status", "unknown"))
    # devices may be simple strings or [index, path, status] triples
    devices = []
    if isinstance(raw_devs, list):
        for d in raw_devs:
            if isinstance(d, list) and len(d) >= 2:
                devices.append(str(d[1]))
            elif isinstance(d, str):
                devices.append(d)
    dev_count = len(devices)
    # state may be a list like ["online", "initialized"]
    if isinstance(state, list):
        state = ",".join(state)
    dev_list = " ".join(devices)
    print(f"{name}|{level}|{dev_count}|{strip}|{state}|{dev_list}")
PYEOF2
)
    echo "$json_out" | python3 -c "$py_script" > "$arrays_file" 2>/dev/null

    [[ -s "$arrays_file" ]]
}

# Interactive reuse flow: map DATA + LOG arrays, write config via yq
# Requires detect_xiraid_arrays to have been called first
# Returns 0 on success, 1 if user declines or arrays insufficient
reuse_existing_arrays() {
    local arrays_file="$TMP_DIR/arrays.txt"

    # Display arrays to user
    local display_file="$TMP_DIR/array_display.txt"
    {
        printf "%-12s %-8s %-8s %-10s %-10s\n" "NAME" "LEVEL" "DRIVES" "STRIP" "STATE"
        printf "%-12s %-8s %-8s %-10s %-10s\n" "────" "─────" "──────" "─────" "─────"
        while IFS='|' read -r name level dev_count strip state dev_list; do
            printf "%-12s %-8s %-8s %-10s %-10s\n" "$name" "RAID$level" "$dev_count" "${strip}KB" "$state"
        done < "$arrays_file"
    } > "$display_file"
    text_box "💾 Existing RAID Arrays" "$display_file"

    # Ask whether to reuse
    if ! yes_no "Reuse Arrays?" "Existing xiRAID arrays found. Reuse them?"; then
        return 1
    fi

    # Build array name list
    local -a array_names=()
    while IFS='|' read -r name level dev_count strip state dev_list; do
        array_names+=("$name")
    done < "$arrays_file"

    # Require at least 2 arrays (DATA + LOG)
    if [[ ${#array_names[@]} -lt 2 ]]; then
        msg_box "❌ Not Enough Arrays" \
            "Reuse requires exactly 2 arrays (DATA + LOG).\nOnly ${#array_names[@]} array(s) found.\n\nProceeding with a clean install to recreate all arrays."
        return 1
    fi

    # Select DATA array
    local -a data_menu_items=()
    for aname in "${array_names[@]}"; do
        local info alevel acount
        info=$(grep "^${aname}|" "$arrays_file" | head -1)
        alevel=$(echo "$info" | cut -d'|' -f2)
        acount=$(echo "$info" | cut -d'|' -f3)
        data_menu_items+=("$aname" "RAID$alevel, $acount drives")
    done

    local data_array
    data_array=$(menu_select "Select Data Array" "Choose the array for primary data storage:" \
        "${data_menu_items[@]}") || return 1

    # Select LOG array (mandatory — no "none" option)
    local -a log_menu_items=()
    for aname in "${array_names[@]}"; do
        [[ "$aname" == "$data_array" ]] && continue
        local info alevel acount
        info=$(grep "^${aname}|" "$arrays_file" | head -1)
        alevel=$(echo "$info" | cut -d'|' -f2)
        acount=$(echo "$info" | cut -d'|' -f3)
        log_menu_items+=("$aname" "RAID$alevel, $acount drives")
    done

    local log_array
    log_array=$(menu_select "Select Log Array" "Choose the array for XFS log device:" \
        "${log_menu_items[@]}") || return 1

    # Get mountpoint and label
    local mountpoint label
    mountpoint=$(input_box "Mountpoint" "XFS mountpoint:" "/mnt/data") || return 1
    label=$(input_box "FS Label" "XFS filesystem label:" "nfsdata") || return 1

    # Read array details for config
    local data_info data_level data_strip data_dev_list
    data_info=$(grep "^${data_array}|" "$arrays_file" | head -1)
    data_level=$(echo "$data_info" | cut -d'|' -f2)
    data_strip=$(echo "$data_info" | cut -d'|' -f4)
    data_dev_list=$(echo "$data_info" | cut -d'|' -f6)

    local data_parity=0
    case "$data_level" in
        5) data_parity=1 ;;
        6) data_parity=2 ;;
    esac

    local log_info log_level log_strip log_dev_list
    log_info=$(grep "^${log_array}|" "$arrays_file" | head -1)
    log_level=$(echo "$log_info" | cut -d'|' -f2)
    log_strip=$(echo "$log_info" | cut -d'|' -f4)
    log_dev_list=$(echo "$log_info" | cut -d'|' -f6)

    local log_parity=0
    case "$log_level" in
        5) log_parity=1 ;;
        6) log_parity=2 ;;
    esac

    # Confirm selections
    local confirm_msg="Data Array: $data_array (RAID$data_level)\n"
    confirm_msg+="Log Array:  $log_array (RAID$log_level)\n"
    confirm_msg+="Mountpoint: $mountpoint\n"
    confirm_msg+="Label:      $label\n"
    confirm_msg+="\nThe playbook will skip RAID creation and\ncreate filesystems on the existing arrays."

    if ! yes_no "✅ Confirm Configuration" "$confirm_msg"; then
        return 1
    fi

    # Write configuration via yq
    local auto_vars="$REPO_DIR/collection/roles/nvme_namespace/defaults/main.yml"
    local raid_vars="$REPO_DIR/collection/roles/raid_fs/defaults/main.yml"

    yq -i '.nvme_auto_namespace = false' "$auto_vars"
    yq -i '.xiraid_force_metadata = false' "$raid_vars"
    yq -i '.xfs_force_mkfs = false' "$raid_vars"

    # Build xiraid_arrays YAML
    local data_devices_yaml=""
    for dev in $data_dev_list; do
        data_devices_yaml+="      - \"$dev\""$'\n'
    done

    local log_devices_yaml=""
    for dev in $log_dev_list; do
        log_devices_yaml+="      - \"$dev\""$'\n'
    done

    local arrays_yaml
    arrays_yaml="xiraid_arrays:"$'\n'
    arrays_yaml+="  - name: \"$data_array\""$'\n'
    arrays_yaml+="    level: $data_level"$'\n'
    arrays_yaml+="    strip_size_kb: $data_strip"$'\n'
    arrays_yaml+="    parity_disks: $data_parity"$'\n'
    arrays_yaml+="    devices:"$'\n'
    arrays_yaml+="$data_devices_yaml"
    arrays_yaml+="  - name: \"$log_array\""$'\n'
    arrays_yaml+="    level: $log_level"$'\n'
    arrays_yaml+="    strip_size_kb: $log_strip"$'\n'
    arrays_yaml+="    parity_disks: $log_parity"$'\n'
    arrays_yaml+="    devices:"$'\n'
    arrays_yaml+="$log_devices_yaml"

    # Build xfs_filesystems YAML (LOG always present)
    local fs_yaml
    fs_yaml="xfs_filesystems:"$'\n'
    fs_yaml+="  - label: \"$label\""$'\n'
    fs_yaml+="    data_device: \"/dev/xi_${data_array}\""$'\n'
    fs_yaml+="    log_device: \"/dev/xi_${log_array}\""$'\n'
    fs_yaml+="    log_size: 1G"$'\n'
    fs_yaml+="    sector_size: 4k"$'\n'
    fs_yaml+="    mountpoint: \"$mountpoint\""$'\n'
    fs_yaml+="    mount_opts: \"logdev=/dev/xi_${log_array},noatime,nodiratime,logbsize=256k,largeio,inode64,swalloc,allocsize=131072k\""$'\n'

    # Write arrays and filesystems to raid_fs defaults
    local combined_yaml="${arrays_yaml}${fs_yaml}"
    echo "$combined_yaml" > "$TMP_DIR/raid_config.yml"

    yq -i 'del(.xiraid_arrays) | del(.xfs_filesystems)' "$raid_vars"
    yq -i '. *= load("'"$TMP_DIR/raid_config.yml"'")' "$raid_vars"

    msg_box "✅ Config Written" "Configuration saved.\n\nThe playbook will:\n  • Skip namespace recreation\n  • Skip array creation (arrays exist)\n  • Create XFS filesystem on /dev/xi_${data_array}\n  • Configure NFS exports and tuning"
    return 0
}

# Clean install: remove xiRAID packages, confirm, run playbook
# Returns 1 if any step is declined/fails
clean_install() {
    if ! check_remove_xiraid; then return 1; fi
    if ! confirm_playbook; then return 1; fi
    run_playbook "playbooks/site.yml" "inventories/lab.ini"
    echo ""
    echo "🎉 Deployment complete! System status:"
    echo ""
    xinas-status 2>/dev/null || echo "Run 'xinas-status' to see system status."
    exit 0
}

confirm_playbook() {
    yes_no "Run Playbook" "Run Ansible playbook to configure the system?"
}

apply_preset() {
    local preset="$1"
    local pdir="$REPO_DIR/presets/$preset"
    [ -d "$pdir" ] || { msg_box "Error" "Preset $preset not found"; return; }
    local msg="Applying preset: $preset\n"
    if [ -f "$pdir/network.yml" ]; then
        cp "$pdir/network.yml" "collection/roles/net_controllers/defaults/main.yml"
        msg+="- IP pool configuration\n"
    fi
    if [ -f "$pdir/netplan.yaml.j2" ]; then
        cp "$pdir/netplan.yaml.j2" "collection/roles/net_controllers/templates/netplan.yaml.j2"
        msg+="- network template\n"
    fi
    if [ -f "$pdir/raid_fs.yml" ]; then
        cp "$pdir/raid_fs.yml" "collection/roles/raid_fs/defaults/main.yml"
        msg+="- RAID configuration\n"
    fi
    if [ -f "$pdir/nfs_exports.yml" ]; then
        cp "$pdir/nfs_exports.yml" "collection/roles/exports/defaults/main.yml"
        msg+="- NFS exports\n"
    fi
    if [ -f "$pdir/playbook.yml" ]; then
        cp "$pdir/playbook.yml" "playbooks/site.yml"
        msg+="- playbook updated\n"
    fi
    msg_box "Preset Applied" "$msg"
}

choose_preset() {
    local preset_dir="$REPO_DIR/presets"
    [ -d "$preset_dir" ] || { msg_box "No Presets" "No presets available"; return; }
    local -a items=()
    for d in "$preset_dir"/*/; do
        [ -d "$d" ] || continue
        items+=("$(basename "$d")" "Preset configuration")
    done
    items+=("Back" "Return to main menu")

    show_header
    local choice
    choice=$(menu_select "Presets" "Select preset:" "${items[@]}") || return

    if [ "$choice" = "Back" ]; then
        return
    fi
    apply_preset "$choice"
}

has_license() {
    [ -f "/tmp/license" ] && [ -s "/tmp/license" ]
}

# Detect if running inside a virtual machine
is_vm() {
    local virt
    virt=$(systemd-detect-virt 2>/dev/null) || virt=""
    [[ -n "$virt" && "$virt" != "none" ]]
}

# Suggest VM preset if running inside a VM and preset not yet applied
suggest_vm_preset() {
    is_vm || return 0
    local virt_type
    virt_type=$(systemd-detect-virt 2>/dev/null)

    if yes_no "Virtual Machine Detected" \
        "This system is running as a VM ($virt_type).\n\nVMs typically use virtio/SCSI drives instead of NVMe.\nThe xinnorVM preset auto-detects all non-OS drives\nand assigns them for RAID (2 log + remaining data).\n\nApply the xinnorVM preset?"; then
        apply_preset "xinnorVM"
    fi
}

show_welcome() {
    show_header
    echo -e "${WHITE}    ┌─────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${WHITE}    │${NC}  ${CYAN}✨ Welcome to xiNAS Setup!${NC}                                 ${WHITE}│${NC}"
    echo -e "${WHITE}    └─────────────────────────────────────────────────────────────┘${NC}"
    echo ""
    echo -e "    ${WHITE}QUICK START GUIDE${NC}"
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo ""
    echo -e "    ${GREEN}①${NC}  ${WHITE}📊 Collect System Data${NC}"
    echo -e "        ${DIM}Gather hardware info for licensing${NC}"
    echo ""
    echo -e "    ${YELLOW}②${NC}  ${WHITE}🔑 Enter License${NC} ${RED}★ Required${NC}"
    echo -e "        ${DIM}Contact${NC} ${CYAN}support@xinnor.io${NC} ${DIM}for your license${NC}"
    echo ""
    echo -e "    ${GREEN}③${NC}  ${WHITE}🌐 Configure Network${NC} ${DIM}(Optional)${NC}"
    echo -e "        ${DIM}Set IP ranges for your storage network${NC}"
    echo ""
    echo -e "    ${GREEN}④${NC}  ${WHITE}🚀 Run Installation${NC}"
    echo -e "        ${DIM}Deploy your high-performance NAS!${NC}"
    echo ""
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo -e "    ${DIM}Need help?${NC} ${CYAN}support@xinnor.io${NC}"
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo ""
    read -p "    Press Enter to continue..." -r
}

# ═══════════════════════════════════════════════════════════════════════════════
# Advanced Settings Menu
# ═══════════════════════════════════════════════════════════════════════════════

advanced_settings_menu() {
    while true; do
        show_header

        # Update status indicator
        update_text="🔄 Check for Updates"
        if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
            update_text="🔄 Check for Updates [Update Available!]"
        fi

        local choice
        choice=$(menu_select "Advanced Settings" "Configuration Options" \
            "1" "🌐 Configure Network" \
            "2" "📦 Choose Preset" \
            "3" "$update_text" \
            "0" "🔙 Back to Main Menu") || return

        case "$choice" in
            1) ./configure_network.sh ;;
            2) choose_preset ;;
            3)
                if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
                    if yes_no "Update Available" "A new version of xiNAS is available!\n\nWould you like to update now?"; then
                        do_update
                    fi
                else
                    info_box "Checking..." "Checking for updates..."
                    check_for_updates
                    if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
                        if yes_no "Update Found" "Update found! Install now?"; then
                            do_update
                        fi
                    else
                        msg_box "Up to Date" "xiNAS is already up to date!"
                    fi
                fi
                ;;
            0) return ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Main Menu
# ═══════════════════════════════════════════════════════════════════════════════

# Show welcome message on first run
show_header
show_welcome

# Suggest VM preset if running on a virtual machine
suggest_vm_preset

while true; do
    show_header

    # Build dynamic menu based on license status
    if has_license; then
        license_text="🔑 Enter License [Licensed]"
        license_status="${GREEN}✅ Licensed${NC}"
        install_text="🚀 Install"
    else
        license_text="🔑 Enter License [Required]"
        license_status="${RED}❌ No License${NC}"
        install_text="🚀 Install [License Required]"
    fi

    # Advanced settings indicator
    advanced_text="🛠 Advanced Settings"
    if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
        advanced_text="🛠 Advanced Settings [!]"
    fi

    # Show status bar
    echo -e "  ${WHITE}License:${NC} $license_status"
    if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
        echo -e "  ${WHITE}Updates:${NC} ${YELLOW}📦 Update available!${NC}"
    fi
    echo ""

    choice=$(menu_select "xiNAS Setup" "Select an option:" \
        "1" "📊 Collect System Data" \
        "2" "$license_text" \
        "3" "$install_text" \
        "4" "$advanced_text" \
        "0" "🚪 Exit") || { echo ""; exit 2; }

    case "$choice" in
        1) ./collect_data.sh ;;
        2) enter_license ;;
        3)
            if ! has_license; then
                msg_box "License Required" "Oops! You need a license to continue.\n\n┌─────────────────────────────────────────┐\n│  Please complete step 2 first:          │\n│                                         │\n│  🔑 Enter License                       │\n│                                         │\n│  Contact: support@xinnor.io             │\n└─────────────────────────────────────────┘\n\nWe're excited to have you on board! 🎉"
                continue
            fi
            if ! check_license; then continue; fi

            # Detect existing xiRAID arrays first
            if detect_xiraid_arrays; then
                # Arrays found — offer reuse
                if reuse_existing_arrays; then
                    # Reuse succeeded — run playbook
                    if confirm_playbook; then
                        run_playbook "playbooks/site.yml" "inventories/lab.ini"
                        echo ""
                        echo "🎉 Deployment complete! System status:"
                        echo ""
                        xinas-status 2>/dev/null || echo "Run 'xinas-status' to see system status."
                        exit 0
                    fi
                else
                    # User declined reuse or not enough arrays — clean install
                    clean_install
                fi
            else
                # No arrays (or no xicli) — clean install
                clean_install
            fi
            ;;
        4) advanced_settings_menu ;;
        0)
            msg_box "See you soon!" "Thank you for choosing xiNAS!\n\nRun this menu again anytime:\n./simple_menu.sh\n\nQuestions? support@xinnor.io"
            exit 2
            ;;
    esac
done
