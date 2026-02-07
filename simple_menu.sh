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
# xiRAID Exporter
# ═══════════════════════════════════════════════════════════════════════════════

EXPORTER_GITHUB_REPO="E4-Computer-Engineering/xiraid-exporter"
EXPORTER_UPDATE_AVAILABLE=""

# Get installed version of xiraid-exporter (empty if not installed)
get_exporter_installed_version() {
    dpkg-query -W -f='${Version}' xiraid-exporter 2>/dev/null || echo ""
}

# Get latest release version from GitHub
get_exporter_latest_version() {
    local latest
    latest=$(curl -fsSL "https://api.github.com/repos/${EXPORTER_GITHUB_REPO}/releases/latest" 2>/dev/null \
        | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
    echo "$latest"
}

# Check if a newer exporter version is available
check_exporter_update() {
    local installed latest
    installed=$(get_exporter_installed_version)
    [[ -z "$installed" ]] && return 0
    latest=$(get_exporter_latest_version)
    [[ -z "$latest" ]] && return 0
    if [[ "$installed" != "$latest" ]]; then
        EXPORTER_UPDATE_AVAILABLE="$latest"
    else
        EXPORTER_UPDATE_AVAILABLE=""
    fi
}

# Install or upgrade xiraid-exporter from GitHub releases
install_xiraid_exporter() {
    local version="$1"
    local arch="amd64"
    local deb_url="https://github.com/${EXPORTER_GITHUB_REPO}/releases/download/v${version}/xiraid-exporter_${version}_linux_${arch}.deb"
    local deb_file="/tmp/xiraid-exporter_${version}.deb"

    info_box "Downloading" "Downloading xiraid-exporter v${version}..."
    if ! curl -fSL -o "$deb_file" "$deb_url" 2>"$TMP_DIR/exporter_dl.log"; then
        msg_box "Download Failed" "Could not download xiraid-exporter v${version}.\n\n$(cat "$TMP_DIR/exporter_dl.log")"
        return 1
    fi

    info_box "Installing" "Installing xiraid-exporter v${version}..."
    if sudo dpkg -i "$deb_file" 2>"$TMP_DIR/exporter_inst.log"; then
        sudo systemctl daemon-reload
        sudo systemctl enable xiraid-exporter 2>/dev/null || true
        sudo systemctl restart xiraid-exporter 2>/dev/null || true
        msg_box "Installed" "xiraid-exporter v${version} installed and started.\n\nMetrics available at http://localhost:9827/metrics"
        EXPORTER_UPDATE_AVAILABLE=""
    else
        msg_box "Install Failed" "Failed to install package.\n\n$(cat "$TMP_DIR/exporter_inst.log")"
        return 1
    fi
    rm -f "$deb_file"
}

# Uninstall xiraid-exporter
uninstall_xiraid_exporter() {
    if yes_no "Uninstall" "Remove xiraid-exporter and stop the service?"; then
        sudo systemctl stop xiraid-exporter 2>/dev/null || true
        sudo systemctl disable xiraid-exporter 2>/dev/null || true
        if sudo apt-get purge -y xiraid-exporter 2>"$TMP_DIR/exporter_rm.log"; then
            msg_box "Removed" "xiraid-exporter has been uninstalled."
        else
            msg_box "Error" "Failed to remove.\n\n$(cat "$TMP_DIR/exporter_rm.log")"
        fi
    fi
}

# xiRAID Exporter management menu
manage_xiraid_exporter() {
    while true; do
        show_header

        local installed
        installed=$(get_exporter_installed_version)

        if [[ -n "$installed" ]]; then
            local svc_status
            svc_status=$(systemctl is-active xiraid-exporter 2>/dev/null || echo "inactive")
            local status_color="$GREEN" status_icon="●"
            [[ "$svc_status" != "active" ]] && { status_color="$RED"; status_icon="●"; }

            echo -e "  ${WHITE}xiRAID Exporter:${NC} ${status_color}${status_icon} v${installed} (${svc_status})${NC}"
            if [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]]; then
                echo -e "  ${WHITE}Update:${NC} ${YELLOW}v${EXPORTER_UPDATE_AVAILABLE} available${NC}"
            fi
            echo ""

            local update_item="🔄 Check for Update"
            [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]] && update_item="🔄 Update to v${EXPORTER_UPDATE_AVAILABLE}"

            local choice
            choice=$(menu_select "xiRAID Exporter" "Manage Exporter" \
                "1" "$update_item" \
                "2" "🔁 Restart Service" \
                "3" "🗑  Uninstall" \
                "0" "🔙 Back") || return

            case "$choice" in
                1)
                    if [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]]; then
                        install_xiraid_exporter "$EXPORTER_UPDATE_AVAILABLE"
                    else
                        info_box "Checking..." "Checking for exporter updates..."
                        check_exporter_update
                        if [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]]; then
                            if yes_no "Update Available" "xiraid-exporter v${EXPORTER_UPDATE_AVAILABLE} is available.\nInstalled: v${installed}\n\nUpdate now?"; then
                                install_xiraid_exporter "$EXPORTER_UPDATE_AVAILABLE"
                            fi
                        else
                            msg_box "Up to Date" "xiraid-exporter v${installed} is the latest version."
                        fi
                    fi
                    ;;
                2)
                    sudo systemctl restart xiraid-exporter 2>/dev/null
                    msg_box "Restarted" "xiraid-exporter service restarted."
                    ;;
                3) uninstall_xiraid_exporter ;;
                0) return ;;
            esac
        else
            echo -e "  ${WHITE}xiRAID Exporter:${NC} ${GRAY}Not installed${NC}"
            echo -e "  ${DIM}Prometheus metrics exporter for xiRAID storage${NC}"
            echo ""

            local choice
            choice=$(menu_select "xiRAID Exporter" "Install Exporter" \
                "1" "📥 Install Latest" \
                "0" "🔙 Back") || return

            case "$choice" in
                1)
                    info_box "Checking..." "Fetching latest version..."
                    local latest
                    latest=$(get_exporter_latest_version)
                    if [[ -z "$latest" ]]; then
                        msg_box "Error" "Could not fetch latest version from GitHub.\nCheck your internet connection."
                    else
                        if yes_no "Install" "Install xiraid-exporter v${latest}?\n\nThis will:\n- Download the .deb package from GitHub\n- Install and enable the systemd service\n- Expose metrics on port 9827"; then
                            install_xiraid_exporter "$latest"
                        fi
                    fi
                    ;;
                0) return ;;
            esac
        fi
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Advanced Settings Menu
# ═══════════════════════════════════════════════════════════════════════════════

advanced_settings_menu() {
    while true; do
        show_header

        # Update status indicators
        local update_text="🔄 Check for Updates"
        if [[ "$UPDATE_AVAILABLE" == "true" ]] || [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]]; then
            update_text="🔄 Check for Updates [Update Available!]"
        fi

        # Exporter status indicator
        local exporter_text="📈 xiRAID Exporter"
        local exporter_ver
        exporter_ver=$(get_exporter_installed_version)
        if [[ -n "$exporter_ver" ]]; then
            local svc_state
            svc_state=$(systemctl is-active xiraid-exporter 2>/dev/null || echo "inactive")
            if [[ "$svc_state" == "active" ]]; then
                exporter_text="📈 xiRAID Exporter [v${exporter_ver} Running]"
            else
                exporter_text="📈 xiRAID Exporter [v${exporter_ver} Stopped]"
            fi
            [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]] && exporter_text="📈 xiRAID Exporter [Update!]"
        else
            exporter_text="📈 xiRAID Exporter [Not Installed]"
        fi

        local choice
        choice=$(menu_select "Advanced Settings" "Configuration Options" \
            "1" "🌐 Configure Network" \
            "2" "📦 Choose Preset" \
            "3" "$exporter_text" \
            "4" "$update_text" \
            "0" "🔙 Back to Main Menu") || return

        case "$choice" in
            1) ./configure_network.sh ;;
            2) choose_preset ;;
            3) manage_xiraid_exporter ;;
            4)
                if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
                    if yes_no "Update Available" "A new version of xiNAS is available!\n\nWould you like to update now?"; then
                        do_update
                    fi
                else
                    info_box "Checking..." "Checking for updates..."
                    check_for_updates
                    check_exporter_update
                    if [[ "$UPDATE_AVAILABLE" == "true" ]] || [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]]; then
                        local msg=""
                        [[ "$UPDATE_AVAILABLE" == "true" ]] && msg+="xiNAS: update available\n"
                        [[ -n "$EXPORTER_UPDATE_AVAILABLE" ]] && msg+="xiraid-exporter: v${EXPORTER_UPDATE_AVAILABLE} available\n"
                        msg_box "Updates Found" "$msg"
                    else
                        msg_box "Up to Date" "Everything is up to date!"
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

# Background update checks (after all functions defined)
check_exporter_update &

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
