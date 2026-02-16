#!/usr/bin/env bash
# Interactive provisioning menu for xiNAS
# Uses colored console menus instead of whiptail
# Exits on errors and cleans up temporary files

set -euo pipefail
TMP_DIR="$(mktemp -d)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Directory of the repository currently being configured
REPO_DIR="$(pwd)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Source the menu library
source "$SCRIPT_DIR/lib/menu_lib.sh"

# Update check
UPDATE_AVAILABLE=""

check_for_updates() {
    # Check if running from a git repo
    local git_dir="$REPO_DIR/.git"
    [[ -d "$git_dir" ]] || return 0

    # Skip if no git command
    command -v git &>/dev/null || return 0

    # Skip if no network (quick check)
    timeout 2 bash -c "echo >/dev/tcp/github.com/443" 2>/dev/null || return 0

    # Get local commit
    local local_commit
    local_commit=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null) || return 0

    # Fetch latest (quiet, background-friendly)
    git -C "$REPO_DIR" fetch --quiet origin main 2>/dev/null || return 0

    # Get remote commit
    local remote_commit
    remote_commit=$(git -C "$REPO_DIR" rev-parse origin/main 2>/dev/null) || return 0

    # Compare
    if [[ "$local_commit" != "$remote_commit" ]]; then
        UPDATE_AVAILABLE="true"
    fi
}

do_update() {
    if ! command -v git &>/dev/null; then
        msg_box "Error" "Git is not installed."
        return 1
    fi

    info_box "Updating..." "Pulling latest changes from origin/main..."

    if git -C "$REPO_DIR" pull origin main 2>"$TMP_DIR/update.log"; then
        UPDATE_AVAILABLE=""
        msg_box "Update Complete" "xiNAS has been updated successfully!\n\nPlease restart the menu to use the new version."
    else
        msg_box "Update Failed" "Failed to update:\n\n$(cat "$TMP_DIR/update.log")"
    fi
}

# Run update check in background
check_for_updates &

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

# Prompt user for license string and store it in /tmp/license
# Show license prompt and save to /tmp/license
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

    # Show HWKEY to the user
    msg_box "Hardware Key" "HWKEY: ${hwkey_val}\n\nRequest your license key from xiNNOR Support."

    if ! text_area "Enter License" "Paste your license key below:" "$TMP_DIR/license"; then
        return 0
    fi
    if [ $replace -eq 1 ]; then
        cp "$license_file" "${license_file}.${ts}.bak"
    fi
    cat "$TMP_DIR/license" > "$license_file"
}

# Edit network configuration (IP pool or manual)
configure_network() {
    ./configure_network.sh
}
# Configure hostname for Ansible role
configure_hostname() {
    ./configure_hostname.sh
}


# Display playbook information from /opt/provision/README.md
show_playbook_info() {
    local info_file="/opt/provision/README.md"
    if [ -f "$info_file" ]; then
        text_box "Playbook Info" "$info_file"
    else
        msg_box "Not Found" "File $info_file not found"
    fi
}

# Show NFS share configuration based on exports role defaults
configure_nfs_shares() {
    local vars_file="collection/roles/exports/defaults/main.yml"
    if [ ! -f "$vars_file" ]; then
        msg_box "Error" "File $vars_file not found"
        return
    fi
    local share_start
    share_start=$(grep -n '^exports:' "$vars_file" | cut -d: -f1)
    local tmp="$TMP_DIR/nfs_info"
    sed -n "$((share_start+1)),$((share_start+3))p" "$vars_file" > "$tmp"
    text_box "NFS Share" "$tmp"

    local default_path
    default_path=$(awk '/^exports:/ {flag=1; next} flag && /- path:/ {print $3; exit}' "$vars_file")

    while true; do
        show_header
        local choice
        choice=$(menu_select "xiNAS Setup" "Choose an action:" \
            "1" "Edit NFS Export Path" \
            "2" "Back") || break
        case "$choice" in
            1) ./configure_nfs_exports.sh --edit "$default_path" ;;
            *) break ;;
        esac
    done
}

# Edit NFS export clients and options interactively
edit_nfs_exports() {
    ./configure_nfs_exports.sh
}

# Configure RAID devices interactively
configure_raid() {
    ./configure_raid.sh
}

# Configure or update git repository under /opt/provision
configure_git_repo() {
    local repo_dir="/opt/provision"
    mkdir -p "$repo_dir"

    local out="$TMP_DIR/git_config"
    if [ -d "$repo_dir/.git" ]; then
        git -C "$repo_dir" config --list >"$out" 2>&1
    else
        git config --list >"$out" 2>&1 || echo "No git configuration found" >"$out"
    fi
    text_box "Current Git Configuration" "$out"

    if ! yes_no "Modify Git" "Modify Git repository settings?"; then
        return 0
    fi

    local current_url=""
    local current_branch="main"
    if [ -d "$repo_dir/.git" ]; then
        current_url=$(git -C "$repo_dir" remote get-url origin 2>/dev/null || true)
        current_branch=$(git -C "$repo_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
    elif [ -f "$repo_dir/repo.url" ]; then
        current_url=$(cat "$repo_dir/repo.url")
        [ -f "$repo_dir/repo.branch" ] && current_branch=$(cat "$repo_dir/repo.branch")
    fi

    local url branch
    url=$(input_box "Git Repository" "Git repository URL:" "$current_url") || return 0
    branch=$(input_box "Git Branch" "Git branch:" "$current_branch") || return 0

    if [ -d "$repo_dir/.git" ]; then
        git -C "$repo_dir" remote set-url origin "$url"
        git -C "$repo_dir" fetch origin
        git -C "$repo_dir" checkout "$branch"
        git -C "$repo_dir" pull origin "$branch"
    else
        rm -rf "$repo_dir"
        git clone -b "$branch" "$url" "$repo_dir"
    fi

    echo "$url" >"$repo_dir/repo.url"
    echo "$branch" >"$repo_dir/repo.branch"

    msg_box "Repository Configured" "Repository configured at $repo_dir"
    REPO_DIR="$repo_dir"
    cd "$REPO_DIR"
}

# Run ansible-playbook and stream output
run_playbook() {
    local playbook="${1:-$REPO_DIR/playbooks/site.yml}"
    local inventory="${2:-inventories/lab.ini}"
    ansible-playbook "$playbook" -i "$inventory" -v
    return $?
}

# Run a playbook with extra variables
run_playbook_with_vars() {
    local playbook="${1:-$REPO_DIR/playbooks/site.yml}"
    local extra_vars="${2:-}"
    local inventory="inventories/lab.ini"
    if [[ -n "$extra_vars" ]]; then
        ansible-playbook "$playbook" -i "$inventory" -v -e "$extra_vars"
    else
        ansible-playbook "$playbook" -i "$inventory" -v
    fi
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

# Display roles from a playbook and confirm execution
confirm_playbook() {
    local playbook="${1:-$REPO_DIR/playbooks/site.yml}"
    local roles role_list desc_file desc
    roles=$(grep -E '^\s*- role:' "$playbook" | awk '{print $3}')
    role_list=""
    for r in $roles; do
        desc_file="$REPO_DIR/collection/roles/${r}/README.md"
        if [ -f "$desc_file" ]; then
            desc=$(awk '/^#/ {next} /^[[:space:]]*$/ {if(found) exit; next} {if(found){printf " %s", $0} else {printf "%s", $0; found=1}} END{print ""}' "$desc_file")
        else
            desc="No description available"
        fi
        role_list="${role_list}\n - ${r}: ${desc}"
    done
    yes_no "Run Playbook" "Run Ansible playbook to configure the system?\n\nThis will execute the following roles:${role_list}"
}

# Show installation profile selection with descriptions
install_menu() {
    if ! has_license; then
        msg_box "License Required" "Oops! You need a license to continue.\n\n┌─────────────────────────────────────────┐\n│  Please complete step 2 first:          │\n│                                         │\n│  🔑 Enter License                       │\n│                                         │\n│  Contact: support@xinnor.io             │\n└─────────────────────────────────────────┘\n\nWe're excited to have you on board! 🎉"
        return
    fi

    local choice
    choice=$(menu_select "Installation Profile" "Choose how to deploy xiNAS:" \
        "1" "🖥️  Full Installation (NVMe)" \
        "2" "🖧  VM Profile (Virtual Machine)" \
        "3" "💾 Use Existing RAID Arrays" \
        "0" "🔙 Back") || return

    local desc=""
    case "$choice" in
        1)
            desc="FULL INSTALLATION — NVMe Auto-Detect\n"
            desc+="\nThis is the standard deployment for physical servers\n"
            desc+="with NVMe drives. The installer will:\n"
            desc+="\n  1. Configure system basics (timezone, packages, NTP)"
            desc+="\n  2. Install NVIDIA DOCA-OFED drivers for RDMA networking"
            desc+="\n  3. Configure network interfaces (IP addressing)"
            desc+="\n  4. Install Xinnor xiRAID software"
            desc+="\n  5. Auto-detect NVMe drives and create namespaces"
            desc+="\n  6. Build RAID arrays (RAID 5 data + RAID 10 log)"
            desc+="\n  7. Create XFS filesystem and mount storage"
            desc+="\n  8. Configure NFS exports for client access"
            desc+="\n  9. Apply performance tuning"
            desc+="\n\nAll non-OS NVMe drives will be used for storage."
            desc+="\nExisting data on those drives will be erased."
            if ! yes_no "Full Installation" "$desc"; then
                return
            fi
            apply_preset "default"
            ;;
        2)
            desc="VM PROFILE — Virtual Machine\n"
            desc+="\nOptimized for virtual environments using virtio or\n"
            desc+="SCSI drives instead of NVMe. The installer will:\n"
            desc+="\n  1. Configure system basics (timezone, packages, NTP)"
            desc+="\n  2. Install NVIDIA DOCA-OFED drivers"
            desc+="\n  3. Configure network interfaces"
            desc+="\n  4. Install Xinnor xiRAID software"
            desc+="\n  5. Auto-detect all non-OS block devices"
            desc+="\n  6. Assign drives: 2 smallest for log, rest for data"
            desc+="\n  7. Build RAID arrays and create XFS filesystem"
            desc+="\n  8. Configure NFS exports for client access"
            desc+="\n  9. Apply VM-tuned performance settings"
            desc+="\n\nAll non-OS drives will be used for storage."
            desc+="\nExisting data on those drives will be erased."
            if ! yes_no "VM Installation" "$desc"; then
                return
            fi
            apply_preset "xinnorVM"
            ;;
        3)
            desc="EXISTING RAID — Skip Array Creation\n"
            desc+="\nUse this when xiRAID arrays are already configured\n"
            desc+="and you only need to set up NFS. The installer will:\n"
            desc+="\n  1. Configure system basics (timezone, packages, NTP)"
            desc+="\n  2. Install NVIDIA DOCA-OFED drivers"
            desc+="\n  3. Configure network interfaces"
            desc+="\n  4. Skip xiRAID install and RAID array creation"
            desc+="\n  5. Create XFS filesystem on existing RAID devices"
            desc+="\n  6. Configure NFS exports for client access"
            desc+="\n  7. Apply performance tuning"
            desc+="\n\nExisting RAID arrays must already be present."
            desc+="\nRAID devices (/dev/xi_data, /dev/xi_log) must exist."
            if ! yes_no "Existing RAID Installation" "$desc"; then
                return
            fi
            # Use default preset but skip xiRAID installation
            apply_preset "default"
            # Set skip flags for xiraid and namespace roles
            local extra_vars="xiraid_skip_install=true nvme_auto_namespace=false"
            if check_license && check_remove_xiraid && confirm_playbook "playbooks/site.yml"; then
                run_playbook_with_vars "playbooks/site.yml" "$extra_vars"
                echo ""
                echo "🎉 Deployment complete! System status:"
                echo ""
                xinas-status 2>/dev/null || echo "Run 'xinas-status' to see system status."
                exit 0
            fi
            return
            ;;
        0) return ;;
    esac

    if check_license && check_remove_xiraid && confirm_playbook "playbooks/site.yml"; then
        run_playbook "playbooks/site.yml"
        echo ""
        echo "🎉 Deployment complete! System status:"
        echo ""
        xinas-status 2>/dev/null || echo "Run 'xinas-status' to see system status."
        exit 0
    fi
}

# Copy configuration files from a preset directory and optionally run its playbook
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

# Present available presets to the user
choose_preset() {
    local preset_dir="$REPO_DIR/presets"
    [ -d "$preset_dir" ] || { msg_box "No Presets" "No presets available"; return; }

    local -a items=()
    for d in "$preset_dir"/*/; do
        [ -d "$d" ] || continue
        items+=("$(basename "$d")" "Preset configuration")
    done
    items+=("Save" "Save current configuration")
    items+=("Back" "Return to main menu")

    show_header
    local choice
    choice=$(menu_select "Presets" "Select preset or save current:" "${items[@]}") || return

    if [ "$choice" = "Back" ]; then
        return
    fi
    if [ "$choice" = "Save" ]; then
        save_preset
        return
    fi
    apply_preset "$choice"
}

# Save current configuration files as a new preset directory
save_preset() {
    local preset
    preset=$(input_box "Save Preset" "Preset name:") || return
    [ -n "$preset" ] || { msg_box "Error" "Preset name cannot be empty"; return; }

    local pdir="$REPO_DIR/presets/$preset"
    if [ -d "$pdir" ]; then
        if ! yes_no "Overwrite" "Preset exists. Overwrite?"; then
            return
        fi
        rm -rf "$pdir"
    fi
    mkdir -p "$pdir"
    cp "collection/roles/net_controllers/defaults/main.yml" "$pdir/network.yml" 2>/dev/null || true
    cp "collection/roles/net_controllers/templates/netplan.yaml.j2" "$pdir/netplan.yaml.j2" 2>/dev/null || true
    cp "collection/roles/raid_fs/defaults/main.yml" "$pdir/raid_fs.yml" 2>/dev/null || true
    cp "collection/roles/exports/defaults/main.yml" "$pdir/nfs_exports.yml" 2>/dev/null || true
    [ -f "playbooks/site.yml" ] && cp "playbooks/site.yml" "$pdir/playbook.yml"
    msg_box "Preset Saved" "Preset saved to $pdir"
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

# Suggest VM preset if running inside a VM
suggest_vm_preset() {
    is_vm || return 0
    local virt_type
    virt_type=$(systemd-detect-virt 2>/dev/null)

    if yes_no "Virtual Machine Detected" \
        "This system is running as a VM ($virt_type).\n\nVMs typically use virtio/SCSI drives instead of NVMe.\nThe xinnorVM preset auto-detects all non-OS drives\nand assigns them for RAID (2 log + remaining data).\n\nApply the xinnorVM preset?"; then
        apply_preset "xinnorVM"
    fi
}

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
    echo -e "${YELLOW}     Expert Mode Setup${NC}"
    echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# Show welcome message
show_header
echo -e "${WHITE}    ┌─────────────────────────────────────────────────────────────┐${NC}"
echo -e "${WHITE}    │${NC}  ${CYAN}✨ Welcome to xiNAS Expert Mode!${NC}                           ${WHITE}│${NC}"
echo -e "${WHITE}    └─────────────────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "    ${WHITE}ADVANCED CONFIGURATION FOR POWER USERS${NC}"
echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
echo ""
echo -e "    ${GREEN}📊${NC}  Collect system information"
echo -e "    ${GREEN}🔑${NC}  Enter your license (required)"
echo -e "    ${GREEN}🌐${NC}  Configure network & hostname"
echo -e "    ${GREEN}💾${NC}  Configure RAID & NFS exports"
echo -e "    ${GREEN}📦${NC}  Manage presets"
echo -e "    ${GREEN}🚀${NC}  Launch the installation"
echo ""
echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
echo -e "    ${DIM}Need help?${NC} ${CYAN}support@xinnor.io${NC}"
echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
echo ""
read -p "    Press Enter to continue..." -r

# Suggest VM preset if running on a virtual machine
suggest_vm_preset

# ═══════════════════════════════════════════════════════════════════════════════
# Advanced Settings Menu
# ═══════════════════════════════════════════════════════════════════════════════

advanced_settings_menu() {
    while true; do
        show_header

        # Update status indicator
        local update_text="🔄 Check for Updates"
        if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
            update_text="🔄 Check for Updates [Update Available!]"
        fi

        local choice
        choice=$(menu_select "Advanced Settings" "Configuration & Management Options" \
            "1" "🌐 Configure Network" \
            "2" "🏷️  Set Hostname" \
            "3" "💾 Configure RAID" \
            "4" "📂 Edit NFS Exports" \
            "5" "📦 Presets" \
            "6" "🔧 Git Repository Configuration" \
            "7" "$update_text" \
            "0" "🔙 Back to Main Menu") || return

        case "$choice" in
            1) configure_network ;;
            2) configure_hostname ;;
            3) configure_raid ;;
            4) edit_nfs_exports ;;
            5) choose_preset ;;
            6) configure_git_repo ;;
            7)
                if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
                    if yes_no "Update Available" "A new version of xiNAS is available!\n\nWould you like to update now?\n\nThis will pull the latest changes from GitHub."; then
                        do_update
                    fi
                else
                    info_box "Checking for Updates" "Checking for updates..."
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
        3) install_menu ;;
        4) advanced_settings_menu ;;
        0)
            msg_box "See you soon!" "Thank you for choosing xiNAS!\n\nRun this menu again anytime:\n./startup_menu.sh\n\nQuestions? support@xinnor.io"
            exit 2
            ;;
    esac
done
