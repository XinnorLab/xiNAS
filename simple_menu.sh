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

configure_raid_manual() {
    # Check xicli is available
    if ! command -v xicli &>/dev/null; then
        msg_box "❌ xicli Not Found" "xicli is not installed.\n\nPlease run the installer first to deploy xiRAID."
        return
    fi

    # Show available drives
    local drives_info
    drives_info=$(mktemp)
    {
        echo "Available Block Devices"
        echo "======================="
        echo ""
        lsblk -d -o NAME,SIZE,MODEL,TYPE 2>/dev/null | head -30
        echo ""
        echo "Current xiRAID arrays:"
        xicli raid show 2>/dev/null || echo "  (none)"
        echo ""
        echo "Current spare pools:"
        xicli pool show 2>/dev/null || echo "  (none)"
    } > "$drives_info"
    text_box "💾 Drive Inventory" "$drives_info"
    rm -f "$drives_info"

    # ── Data RAID ──
    if ! yes_no "💾 Create Data RAID" \
        "Create a DATA RAID array?\n\nThis is the primary storage array."; then
        return
    fi

    local data_name data_level data_strip data_devices
    data_name=$(input_box "Data RAID Name" "Array name:" "data") || return
    data_level=$(menu_select "Data RAID Level" "Select RAID level for data array:" \
        "5"  "RAID 5  (1 parity, good capacity)" \
        "6"  "RAID 6  (2 parity, better safety)" \
        "10" "RAID 10 (mirror+stripe, best perf)" \
        "1"  "RAID 1  (mirror only)" \
        "0"  "RAID 0  (stripe, no redundancy)") || return
    data_strip=$(menu_select "Data Strip Size" "Select strip size (KB) for data array:" \
        "128" "128 KB (recommended for large I/O)" \
        "64"  "64 KB" \
        "256" "256 KB" \
        "512" "512 KB") || return
    data_devices=$(input_box "Data RAID Devices" \
        "Space-separated device paths for data array:\n(e.g. /dev/nvme1n2 /dev/nvme2n2 /dev/nvme3n2)" "") || return

    if [[ -z "$data_devices" ]]; then
        msg_box "Cancelled" "No devices specified for data RAID."
        return
    fi

    # ── Log RAID ──
    local log_name="" log_level="" log_strip="" log_devices=""
    local create_log=false
    if yes_no "📝 Create Log RAID" \
        "Create a LOG RAID array?\n\nUsed for XFS external log device (improves metadata performance)."; then
        create_log=true
        log_name=$(input_box "Log RAID Name" "Array name:" "log") || return
        log_level=$(menu_select "Log RAID Level" "Select RAID level for log array:" \
            "1"  "RAID 1  (mirror, recommended)" \
            "10" "RAID 10 (mirror+stripe)" \
            "0"  "RAID 0  (stripe, no redundancy)") || return
        log_strip=$(menu_select "Log Strip Size" "Select strip size (KB) for log array:" \
            "16"  "16 KB (recommended for metadata)" \
            "32"  "32 KB" \
            "64"  "64 KB") || return
        log_devices=$(input_box "Log RAID Devices" \
            "Space-separated device paths for log array:\n(e.g. /dev/nvme1n1 /dev/nvme2n1)" "") || return

        if [[ -z "$log_devices" ]]; then
            msg_box "Skipped" "No devices specified for log RAID. Skipping."
            create_log=false
        fi
    fi

    # ── Spare Pool (optional) ──
    local spare_name="" spare_devices=""
    local create_spare=false
    if yes_no "🔄 Create Spare Pool" \
        "Create a spare pool?\n\nSpare drives automatically replace failed drives\nin the data RAID array."; then
        create_spare=true
        spare_name=$(input_box "Spare Pool Name" "Pool name:" "spare") || return
        spare_devices=$(input_box "Spare Pool Devices" \
            "Space-separated device paths for spare pool:\n(e.g. /dev/nvme4n2)" "") || return

        if [[ -z "$spare_devices" ]]; then
            msg_box "Skipped" "No devices specified for spare pool. Skipping."
            create_spare=false
        fi
    fi

    # ── Build command list ──
    local cmds_file
    cmds_file=$(mktemp)
    {
        echo "Commands to execute:"
        echo "===================="
        echo ""

        if [[ "$create_spare" == true ]]; then
            echo "1) Create spare pool:"
            echo "   xicli pool create -n $spare_name -d $spare_devices"
            echo ""
        fi

        local data_cmd="xicli raid create -n $data_name -l $data_level -d $data_devices -ss $data_strip"
        if [[ "$create_spare" == true ]]; then
            data_cmd+=" -sp $spare_name"
        fi

        local cmd_num=1
        [[ "$create_spare" == true ]] && cmd_num=2
        echo "${cmd_num}) Create data RAID:"
        echo "   $data_cmd"
        echo ""

        if [[ "$create_log" == true ]]; then
            ((cmd_num++))
            echo "${cmd_num}) Create log RAID:"
            echo "   xicli raid create -n $log_name -l $log_level -d $log_devices -ss $log_strip"
            echo ""
        fi
    } > "$cmds_file"
    text_box "📋 RAID Commands" "$cmds_file"
    rm -f "$cmds_file"

    if ! yes_no "⚠️ Confirm RAID Creation" \
        "This will create RAID arrays on the specified devices.\n\nAny existing data on those devices will be lost!\n\nProceed?"; then
        msg_box "Cancelled" "RAID creation cancelled."
        return
    fi

    # ── Execute commands ──
    local all_ok=true

    # 1. Spare pool first (if data RAID references it)
    if [[ "$create_spare" == true ]]; then
        info_box "Creating Spare Pool" "xicli pool create -n $spare_name ..."
        local pool_out="" pool_rc=0
        pool_out=$(xicli pool create -n "$spare_name" -d $spare_devices 2>&1) || pool_rc=$?
        if [[ $pool_rc -ne 0 ]]; then
            msg_box "❌ Spare Pool Failed" "Command failed (exit $pool_rc):\n\n$pool_out"
            all_ok=false
        else
            msg_box "✅ Spare Pool Created" "Pool '$spare_name' created.\n${pool_out:+\n$pool_out}"
        fi
    fi

    # 2. Data RAID
    info_box "Creating Data RAID" "xicli raid create -n $data_name ..."
    local data_args=(-n "$data_name" -l "$data_level" -d $data_devices -ss "$data_strip")
    if [[ "$create_spare" == true ]]; then
        data_args+=(-sp "$spare_name")
    fi
    local data_out="" data_rc=0
    data_out=$(xicli raid create "${data_args[@]}" 2>&1) || data_rc=$?
    if [[ $data_rc -ne 0 ]]; then
        msg_box "❌ Data RAID Failed" "Command failed (exit $data_rc):\n\n$data_out"
        all_ok=false
    else
        msg_box "✅ Data RAID Created" "Array '$data_name' (RAID $data_level) created.\n${data_out:+\n$data_out}"
    fi

    # 3. Log RAID
    if [[ "$create_log" == true ]]; then
        info_box "Creating Log RAID" "xicli raid create -n $log_name ..."
        local log_out="" log_rc=0
        log_out=$(xicli raid create -n "$log_name" -l "$log_level" -d $log_devices -ss "$log_strip" 2>&1) || log_rc=$?
        if [[ $log_rc -ne 0 ]]; then
            msg_box "❌ Log RAID Failed" "Command failed (exit $log_rc):\n\n$log_out"
            all_ok=false
        else
            msg_box "✅ Log RAID Created" "Array '$log_name' (RAID $log_level) created.\n${log_out:+\n$log_out}"
        fi
    fi

    # Final status
    if [[ "$all_ok" == true ]]; then
        # Show result
        local result_info
        result_info=$(mktemp)
        {
            echo "RAID Status"
            echo "==========="
            echo ""
            xicli raid show 2>/dev/null || echo "(unable to query)"
            echo ""
            xicli pool show 2>/dev/null || true
        } > "$result_info"
        text_box "✅ RAID Configuration Complete" "$result_info"
        rm -f "$result_info"
    else
        msg_box "⚠️ Partial Failure" "Some commands failed.\nCheck the output above and verify with:\n  xicli raid show\n  xicli pool show"
    fi
}

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
            "3" "💾 Configure RAID (Manual)" \
            "4" "$update_text" \
            "0" "🔙 Back to Main Menu") || return

        case "$choice" in
            1) ./configure_network.sh ;;
            2) choose_preset ;;
            3) configure_raid_manual ;;
            4)
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
            if check_license && check_remove_xiraid && confirm_playbook "playbooks/site.yml"; then
                run_playbook "playbooks/site.yml" "inventories/lab.ini"
                echo ""
                echo "🎉 Deployment complete! System status:"
                echo ""
                xinas-status 2>/dev/null || echo "Run 'xinas-status' to see system status."
                exit 0
            fi
            ;;
        4) advanced_settings_menu ;;
        0)
            msg_box "See you soon!" "Thank you for choosing xiNAS!\n\nRun this menu again anytime:\n./simple_menu.sh\n\nQuestions? support@xinnor.io"
            exit 2
            ;;
    esac
done
